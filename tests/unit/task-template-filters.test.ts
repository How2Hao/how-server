import type { ParsedTemplate } from '~/server/utils/services/task-template.ts'
import { eq, sql } from 'drizzle-orm'
// 纯函数单测：活动分类后代展开 / 列表筛选排序 / groupId 聚合 / 存储格式解析（不触 DB）
import { describe, expect, it } from 'vitest'
import { db } from '~/server/database/db.ts'
import { taskTemplate } from '~/server/database/schema/task.ts'
import {
  applyFilters,
  expandActivityDescendantIds,
  firstTierMinAmount,
  groupByActivity,
  normalizeTiers,
  parseJsonArray,
  parseJsonStringArray,
} from '~/server/utils/services/task-template.ts'

/** 造一条解析后的模板 DTO（字段取 applyFilters/groupByActivity 实际读取的子集） */
function tpl(over: Partial<ParsedTemplate> & { id: number }): ParsedTemplate {
  return {
    title: '',
    ruleDetail: '',
    bankId: '1',
    bankCardType: 'CREDIT',
    cardOrganizations: [] as string[],
    regionCode: '100000',
    benefitCategoryId: null,
    activityCategoryId: null,
    publisher: '运营小张',
    addCount: 0,
    groupId: null,
    tiers: [{ minAmount: 0 }],
    bankCardMatch: { status: 'MATCHED' },
    ...over,
  }
}

describe('expandActivityDescendantIds（活动分类后代 BFS 展开）', () => {
  const categories = [
    { id: 1, parentId: null }, // 出行（一级）
    { id: 2, parentId: 1 }, // 火车票（二级）
    { id: 3, parentId: null }, // 购物（一级）
    { id: 4, parentId: 3 }, // 电商（二级）
    { id: 5, parentId: 4 }, // 电商-某平台（三级）
  ]

  it('一级分类展开为自身 + 所有后代', () => {
    expect(expandActivityDescendantIds([1], categories)).toEqual(new Set([1, 2]))
    expect(expandActivityDescendantIds([3], categories)).toEqual(new Set([3, 4, 5]))
  })

  it('多 root 取并集并去重', () => {
    expect(expandActivityDescendantIds([1, 3], categories)).toEqual(new Set([1, 2, 3, 4, 5]))
    expect(expandActivityDescendantIds([3, 4], categories)).toEqual(new Set([3, 4, 5]))
  })

  it('没有有效 root 时返回 null（跳过筛选）', () => {
    expect(expandActivityDescendantIds([], categories)).toBeNull()
    expect(expandActivityDescendantIds([0, Number.NaN, -2], categories)).toBeNull()
  })
})

describe('applyFilters（列表筛选与排序）', () => {
  const items: ParsedTemplate[] = [
    tpl({ id: 1, title: '微信户外聚餐满减', bankId: '1', cardOrganizations: ['UNIONPAY'] }),
    tpl({ id: 2, title: '云闪付购物', ruleDetail: '限借记卡参与', bankId: '2', bankCardType: 'debit', regionCode: '440100', benefitCategoryId: 5, activityCategoryId: 2, addCount: 10 }),
    tpl({ id: 3, title: 'Visa 刷卡活动', bankId: '3', cardOrganizations: ['UNIONPAY', 'VISA'], bankCardMatch: { status: 'MISSING_BANK_CARD_TYPE' }, publisher: '' }),
  ]

  it('keyword 大小写无关匹配 title / ruleDetail', () => {
    expect(applyFilters(items, { keyword: '聚餐' }).map(i => i.id)).toEqual([1])
    expect(applyFilters(items, { keyword: '借记卡' }).map(i => i.id)).toEqual([2])
  })

  it('bankId 与 bankIds 取并集（IN 语义）', () => {
    expect(applyFilters(items, { bankId: '1', bankIds: ['2'] }).map(i => i.id)).toEqual([1, 2])
    expect(applyFilters(items, { bankIds: ['3'] }).map(i => i.id)).toEqual([3])
  })

  it('cardType 大小写无关比对', () => {
    expect(applyFilters(items, { cardType: 'DEBIT' }).map(i => i.id)).toEqual([2])
    expect(applyFilters(items, { cardType: 'credit' }).map(i => i.id)).toEqual([1, 3])
  })

  it('cardOrganizations 为 ANY 语义：模板含任一即命中', () => {
    expect(applyFilters(items, { cardOrganization: 'visa' }).map(i => i.id)).toEqual([3])
    expect(applyFilters(items, { cardOrganizations: ['unionpay'] }).map(i => i.id)).toEqual([1, 3])
  })

  it('regionCode/regionCodes、benefitCategoryId(s) 并集', () => {
    expect(applyFilters(items, { regionCode: '440100' }).map(i => i.id)).toEqual([2])
    expect(applyFilters(items, { regionCodes: ['440100', '100000'] }).length).toBe(3)
    expect(applyFilters(items, { benefitCategoryId: 5 }).map(i => i.id)).toEqual([2])
  })

  it('activityDescendants：用预构集合判断（一级筛选包含后代模板）', () => {
    expect(applyFilters(items, { activityCategoryId: 1 }, new Set([1, 2])).map(i => i.id)).toEqual([2])
    expect(applyFilters(items, { activityCategoryId: 1 }, new Set([1])).length).toBe(0)
  })

  it('officialOnly：publisher 为空被过滤；canAddOnly：未 MATCHED 被过滤', () => {
    expect(applyFilters(items, { officialOnly: true }).map(i => i.id)).toEqual([1, 2])
    expect(applyFilters(items, { canAddOnly: true }).map(i => i.id)).toEqual([1, 2])
  })

  it('quickFilter：CAN_ADD / OFFICIAL / MOST_ADDED', () => {
    expect(applyFilters(items, { quickFilter: 'CAN_ADD' }).map(i => i.id)).toEqual([1, 2])
    expect(applyFilters(items, { quickFilter: 'OFFICIAL' }).map(i => i.id)).toEqual([1, 2])
    // MOST_ADDED → sortBy=ADD_COUNT_DESC：addCount 降序、addCount 相同 id 降序（3 > 1）
    expect(applyFilters(items, { quickFilter: 'MOST_ADDED' }).map(i => i.id)).toEqual([2, 3, 1])
  })

  it('sortBy=ADD_COUNT_DESC：addCount 相同时按 id 降序', () => {
    const tie: ParsedTemplate[] = [tpl({ id: 7, addCount: 5 }), tpl({ id: 9, addCount: 5 }), tpl({ id: 8, addCount: 6 })]
    expect(applyFilters(tie, { sortBy: 'ADD_COUNT_DESC' }).map(i => i.id)).toEqual([8, 9, 7])
  })
})

describe('groupByActivity（groupId 聚合 + 排序）', () => {
  it('同 group 组内按首档 minAmount 升序，activity 间按 rootId 降序', () => {
    const items: ParsedTemplate[] = [
      tpl({ id: 11, groupId: 5, tiers: [{ minAmount: 100 }] }),
      tpl({ id: 12, groupId: 5, tiers: [{ minAmount: 50 }] }),
      tpl({ id: 3, groupId: null, tiers: [{ minAmount: 0 }] }),
    ]
    const grouped = groupByActivity(items)
    expect(grouped.map(g => g.rootId)).toEqual([5, 3])
    const group = grouped.find(g => g.rootId === 5)!
    expect((group.templates as ParsedTemplate[]).map(t => t.id)).toEqual([12, 11])
  })

  it('首档缺失按 0 参与排序（firstTierMinAmount）', () => {
    expect(firstTierMinAmount({ tiers: [] })).toBe(0)
    expect(firstTierMinAmount({ tiers: [{ minAmount: 30 }] })).toBe(30)
    expect(firstTierMinAmount(null)).toBe(0)
  })
})

describe('存储格式解析', () => {
  it('parseJsonArray 兼容 JSON 数组 / 逗号分隔 / 非 JSON', () => {
    expect(parseJsonArray('[1,3,5]')).toEqual([1, 3, 5])
    expect(parseJsonArray('1,3,5')).toEqual([1, 3, 5])
    expect(parseJsonArray('7')).toEqual([7]) // JSON.parse 得数字非数组 → 落逗号 split
    expect(parseJsonArray('abc')).toEqual([])
    expect(parseJsonArray(null)).toEqual([])
    expect(parseJsonArray(undefined)).toEqual([])
  })

  it('parseJsonStringArray 兼容 JSON 数组 / 逗号分隔', () => {
    expect(parseJsonStringArray('["UNIONPAY","VISA"]')).toEqual(['UNIONPAY', 'VISA'])
    expect(parseJsonStringArray('UNIONPAY, VISA')).toEqual(['UNIONPAY', 'VISA'])
    expect(parseJsonStringArray(null)).toEqual([])
  })

  it('normalizeTiers 把字符串金额规整为 number/null', () => {
    expect(normalizeTiers([{ minAmount: '50.00', benefitAmountFixed: null, benefitDescription: '减 50', extra: 1 }])).toEqual([
      {
        minAmount: 50,
        benefitAmountFixed: null,
        benefitAmountMin: null,
        benefitAmountMax: null,
        benefitDescription: '减 50',
        quotaPerCycleText: null,
        quotaTotalText: null,
      },
    ])
    expect(normalizeTiers('not-array')).toEqual([])
  })
})

describe('like/unlike 更新语句（发布时间不被点赞污染）', () => {
  it('likes 自增/置值的同时显式 SET updated_at = updated_at 冻结发布时间', () => {
    // 仅生成 SQL（toSQL 不触库），校验旧系统「SET updated_at = updated_at 跳过
    // ON UPDATE CURRENT_TIMESTAMP」的移植方式
    const likeSql = db.update(taskTemplate).set({
      likes: sql`${taskTemplate.likes} + 1`,
      updatedAt: sql`${taskTemplate.updatedAt}`,
    }).where(eq(taskTemplate.id, 1)).toSQL().sql
    expect(likeSql).toContain('`updated_at` = `task_template`.`updated_at`')
    expect(likeSql).toContain('`likes` = `task_template`.`likes` + 1')
  })
})
