// 用户设置纯逻辑单测：默认值 / 入参校验 / 深合并 / 归属清洗（不触碰 DB/网络）
import { describe, expect, it } from 'vitest'
import {
  cloneDefaultSettings,
  mergeSettings,
  normalizeSettingsInput,
  sanitizeSettingsByOwnership,
} from '~/server/utils/services/user-settings-core.ts'

describe('cloneDefaultSettings', () => {
  it('返回 schema v1 默认值', () => {
    const d = cloneDefaultSettings()
    expect(d.schemaVersion).toBe(1)
    expect(d.cardPack).toEqual({
      showBillManagement: true,
      showInterestFreeTips: true,
      showAnnualFeeReminder: true,
      showGroupedCards: true,
    })
    expect(d.finance).toEqual({
      amountColorMode: 'red-up',
      defaultLedgerId: null,
      defaultTransactionType: 'INCOME',
      defaultAccUserByLedger: {},
    })
    expect(d.plaza).toEqual({
      defaultQuickFilter: 'ALL',
      rememberAdvancedFilters: true,
      defaultRegionCode: null,
      defaultSortBy: 'HOT',
      defaultMode: 'FOLLOWED',
    })
    expect(d.notification).toEqual({
      masterEnabled: true,
      typeActivity: true,
      typeAnnouncement: true,
      typeFeedbackReply: true,
      typeTaskReminder: true,
    })
  })

  it('每次调用都是独立副本，互不污染', () => {
    const a = cloneDefaultSettings()
    a.cardPack.showGroupedCards = false
    a.finance.defaultAccUserByLedger['1'] = 9
    const b = cloneDefaultSettings()
    expect(b.cardPack.showGroupedCards).toBe(true)
    expect(b.finance.defaultAccUserByLedger).toEqual({})
  })
})

describe('normalizeSettingsInput（strict=true，客户端 PATCH）', () => {
  it('接受合法补丁，只输出出现的键', () => {
    const patch = normalizeSettingsInput({
      cardPack: { showGroupedCards: false },
      finance: { amountColorMode: 'green-up' },
    }, true)
    expect(patch).toEqual({
      cardPack: { showGroupedCards: false },
      finance: { amountColorMode: 'green-up' },
    })
  })

  it('非对象 payload 报错', () => {
    expect(() => normalizeSettingsInput([], true)).toThrow('settings payload 必须是对象')
    expect(() => normalizeSettingsInput('x', true)).toThrow('settings payload 必须是对象')
    expect(() => normalizeSettingsInput(null, true)).toThrow('settings payload 必须是对象')
  })

  it('未知根字段报错', () => {
    expect(() => normalizeSettingsInput({ foo: 1 }, true)).toThrow('不支持的设置字段: foo')
  })

  it('schemaVersion 仅支持 1', () => {
    expect(normalizeSettingsInput({ schemaVersion: 1 }, true)).toEqual({ schemaVersion: 1 })
    expect(() => normalizeSettingsInput({ schemaVersion: 2 }, true)).toThrow('schemaVersion 仅支持 1')
  })

  it('cardPack：必须是对象 / 未知字段报错 / 必须是 boolean', () => {
    expect(() => normalizeSettingsInput({ cardPack: 'x' }, true)).toThrow('cardPack 必须是对象')
    expect(() => normalizeSettingsInput({ cardPack: { foo: true } }, true)).toThrow('不支持的 cardPack 字段: foo')
    expect(() => normalizeSettingsInput({ cardPack: { showBillManagement: 'yes' } }, true)).toThrow('cardPack.showBillManagement 必须是 boolean')
    expect(normalizeSettingsInput({ cardPack: { showBillManagement: false } }, true)).toEqual({
      cardPack: { showBillManagement: false },
    })
  })

  it('finance：枚举与正整数/null 校验', () => {
    expect(() => normalizeSettingsInput({ finance: { amountColorMode: 'blue-up' } }, true)).toThrow('finance.amountColorMode 取值非法')
    expect(() => normalizeSettingsInput({ finance: { defaultTransactionType: 'REFUND' } }, true)).toThrow('finance.defaultTransactionType 取值非法')
    expect(() => normalizeSettingsInput({ finance: { defaultLedgerId: 0 } }, true)).toThrow('finance.defaultLedgerId 必须是正整数或 null')
    expect(() => normalizeSettingsInput({ finance: { defaultLedgerId: 1.5 } }, true)).toThrow('finance.defaultLedgerId 必须是正整数或 null')
    expect(() => normalizeSettingsInput({ finance: { defaultLedgerId: '2' } }, true)).toThrow('finance.defaultLedgerId 必须是正整数或 null')
    expect(normalizeSettingsInput({ finance: { defaultLedgerId: null, amountColorMode: 'green-up', defaultTransactionType: 'EXPENSE' } }, true)).toEqual({
      finance: { defaultLedgerId: null, amountColorMode: 'green-up', defaultTransactionType: 'EXPENSE' },
    })
  })

  it('finance.defaultAccUserByLedger：key 必须是数字串，value 必须是正整数或 null', () => {
    expect(() => normalizeSettingsInput({ finance: { defaultAccUserByLedger: { abc: 1 } } }, true)).toThrow('finance.defaultAccUserByLedger key 非法: abc')
    expect(() => normalizeSettingsInput({ finance: { defaultAccUserByLedger: { 1: 0 } } }, true)).toThrow('finance.defaultAccUserByLedger.1 必须是正整数或 null')
    expect(normalizeSettingsInput({ finance: { defaultAccUserByLedger: { 1: 3, 2: null } } }, true)).toEqual({
      finance: { defaultAccUserByLedger: { 1: 3, 2: null } },
    })
  })

  it('plaza：defaultRegionCode 去空白、空串归 null、超长截断', () => {
    expect(normalizeSettingsInput({ plaza: { defaultRegionCode: '  100000 ' } }, true)).toEqual({ plaza: { defaultRegionCode: '100000' } })
    expect(normalizeSettingsInput({ plaza: { defaultRegionCode: '   ' } }, true)).toEqual({ plaza: { defaultRegionCode: null } })
    expect(normalizeSettingsInput({ plaza: { defaultRegionCode: '1234567890123456789012345' } }, true)).toEqual({ plaza: { defaultRegionCode: '12345678901234567890' } })
    expect(() => normalizeSettingsInput({ plaza: { defaultRegionCode: 100000 } }, true)).toThrow('plaza.defaultRegionCode 必须是字符串或 null')
    expect(() => normalizeSettingsInput({ plaza: { defaultSortBy: 'NEW' } }, true)).toThrow('plaza.defaultSortBy 取值非法')
    expect(() => normalizeSettingsInput({ plaza: { defaultMode: 'RANDOM' } }, true)).toThrow('plaza.defaultMode 取值非法')
    expect(() => normalizeSettingsInput({ plaza: { defaultQuickFilter: 'RECENT' } }, true)).toThrow('plaza.defaultQuickFilter 取值非法')
  })

  it('notification：必须是对象，各开关必须是 boolean', () => {
    expect(() => normalizeSettingsInput({ notification: 1 }, true)).toThrow('notification 必须是对象')
    expect(() => normalizeSettingsInput({ notification: { masterEnabled: 0 } }, true)).toThrow('notification.masterEnabled 必须是 boolean')
    expect(() => normalizeSettingsInput({ notification: { typeActivity: 'yes' } }, true)).toThrow('notification.typeActivity 必须是 boolean')
    expect(() => normalizeSettingsInput({ notification: { unknownKey: true } }, true)).toThrow('不支持的 notification 字段: unknownKey')
    expect(normalizeSettingsInput({ notification: { masterEnabled: false, typeTaskReminder: false } }, true)).toEqual({
      notification: { masterEnabled: false, typeTaskReminder: false },
    })
  })

  it('旧字段 task.reminderEnabled 迁移为 notification.typeTaskReminder', () => {
    expect(normalizeSettingsInput({ task: { reminderEnabled: false } }, true)).toEqual({
      notification: { typeTaskReminder: false },
    })
    // 显式 notification.typeTaskReminder 优先
    expect(normalizeSettingsInput({ task: { reminderEnabled: false }, notification: { typeTaskReminder: true } }, true)).toEqual({
      notification: { typeTaskReminder: true },
    })
  })

  it('strict=false（读 DB 存量）：非法字段静默丢弃，不抛错', () => {
    expect(normalizeSettingsInput({ foo: 1, cardPack: 'x' }, false)).toEqual({})
    expect(normalizeSettingsInput({ schemaVersion: 2, notification: { typeActivity: false } }, false)).toEqual({
      notification: { typeActivity: false },
    })
    // 非法 map key 静默跳过
    expect(normalizeSettingsInput({ finance: { defaultAccUserByLedger: { abc: 1, 2: 5 } } }, false)).toEqual({
      finance: { defaultAccUserByLedger: { 2: 5 } },
    })
  })
})

describe('mergeSettings（深合并）', () => {
  it('patch 只覆盖出现的键，其余保持 base', () => {
    const base = cloneDefaultSettings()
    const merged = mergeSettings(base, { notification: { masterEnabled: false } })
    expect(merged.notification.masterEnabled).toBe(false)
    expect(merged.notification.typeActivity).toBe(true)
    expect(merged.cardPack.showBillManagement).toBe(true)
    expect(merged.plaza.defaultSortBy).toBe('HOT')
    expect(merged.schemaVersion).toBe(1)
  })

  it('defaultAccUserByLedger 按账本 id 逐键合并，不整体替换', () => {
    const base = cloneDefaultSettings()
    base.finance.defaultAccUserByLedger = { 1: 10, 2: null }
    const merged = mergeSettings(base, { finance: { defaultAccUserByLedger: { 2: 20 } } })
    expect(merged.finance.defaultAccUserByLedger).toEqual({ 1: 10, 2: 20 })
  })

  it('patch 未带 finance 时 defaultAccUserByLedger 原样保留', () => {
    const base = cloneDefaultSettings()
    base.finance.defaultAccUserByLedger = { 7: 3 }
    const merged = mergeSettings(base, { cardPack: { showGroupedCards: false } })
    expect(merged.finance.defaultAccUserByLedger).toEqual({ 7: 3 })
  })

  it('schemaVersion 强制回写为 1', () => {
    const base = cloneDefaultSettings()
    const merged = mergeSettings(base, { schemaVersion: 1 })
    expect(merged.schemaVersion).toBe(1)
  })
})

describe('sanitizeSettingsByOwnership（归属清洗）', () => {
  const ledgerIds = new Set([1, 2])
  const accUserIds = new Set([10, 20])

  it('defaultLedgerId 归属校验：合法保留、非法归 null', () => {
    const owned = sanitizeSettingsByOwnership(
      { ...cloneDefaultSettings(), finance: { ...cloneDefaultSettings().finance, defaultLedgerId: 2 } },
      ledgerIds,
      accUserIds,
    )
    expect(owned.finance.defaultLedgerId).toBe(2)

    const unowned = sanitizeSettingsByOwnership(
      { ...cloneDefaultSettings(), finance: { ...cloneDefaultSettings().finance, defaultLedgerId: 99 } },
      ledgerIds,
      accUserIds,
    )
    expect(unowned.finance.defaultLedgerId).toBe(null)
  })

  it('defaultAccUserByLedger：无权账本键丢弃、无权成员键丢弃、null 保留', () => {
    const settings = cloneDefaultSettings()
    settings.finance.defaultAccUserByLedger = {
      1: 10, // 账本+成员都有权 → 保留
      2: null, // 账本有权、成员 null → 保留 null
      3: 99, // 账本有权、成员无权 → 丢弃
      9: 10, // 账本无权 → 丢弃
    }
    const cleaned = sanitizeSettingsByOwnership(settings, ledgerIds, accUserIds)
    expect(cleaned.finance.defaultAccUserByLedger).toEqual({ 1: 10, 2: null })
  })

  it('非数字 key 直接丢弃，输出补全默认字段（自愈）', () => {
    const settings = cloneDefaultSettings()
    settings.finance.defaultAccUserByLedger = { '0x1': 10 }
    const cleaned = sanitizeSettingsByOwnership(settings, ledgerIds, accUserIds)
    expect(cleaned.finance.defaultAccUserByLedger).toEqual({})
    // 输出是补全了全部默认结构的完整 settings
    expect(cleaned.cardPack).toEqual(cloneDefaultSettings().cardPack)
    expect(cleaned.notification).toEqual(cloneDefaultSettings().notification)
    expect(cleaned.schemaVersion).toBe(1)
  })
})
