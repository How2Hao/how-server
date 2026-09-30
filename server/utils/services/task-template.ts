import type { cardOrganization } from '~/server/database/schema/plaza.ts'
import type { RegionIndex } from '~/server/utils/services/reference-cache.ts'
// 任务模板（活动广场）服务：列表 / 详情 / 点赞 / 取消点赞 / 置顶
// 移植自旧 how-api src/service/task_template.ts（TypeORM → Drizzle + reference-cache）
//
// 结构说明：
// - 纯函数（分类后代展开、筛选、分组、地区匹配、组织名归一化等）单独 export，便于 vitest 单测。
// - 字典表（银行 / 卡组织 / 优惠类目 / 平台 / 活动分类 / 管理员 / 卡券分类 / 行政区划）
//   全部走 reference-cache 进程内缓存，不再每请求查库。
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { bankCard, bankCardTemplate, plazaCustomTab } from '~/server/database/schema/plaza.ts'
import { task, taskRecurring, taskTemplate, taskTemplateLike } from '~/server/database/schema/task.ts'
import { config } from '~/server/utils/config.ts'
import {
  getCardOrganizations,
  getRegionIndex,
  resolveActivityCategories,
  resolveAdminUsers,
  resolveBanks,
  resolveBenefitCategories,
  resolveBenefitPayPlatforms,
  resolveBenefitUsagePlatforms,
  resolveCouponCategories,
} from '~/server/utils/services/reference-cache.ts'

// ---------- 行类型（从 drizzle schema / reference-cache 返回值推导） ----------

type TaskTemplateRow = typeof taskTemplate.$inferSelect
type BankCardRow = typeof bankCard.$inferSelect
type BankCardTemplateRow = typeof bankCardTemplate.$inferSelect
type CardOrganizationRow = typeof cardOrganization.$inferSelect

type MapValue<F extends (...args: any[]) => any> = Awaited<ReturnType<F>> extends Map<number, infer V> ? V : never
type BankRow = MapValue<typeof resolveBanks>
type BenefitCategoryRow = MapValue<typeof resolveBenefitCategories>
type BenefitPayPlatformRow = MapValue<typeof resolveBenefitPayPlatforms>
type BenefitUsagePlatformRow = MapValue<typeof resolveBenefitUsagePlatforms>
type ActivityCategoryRow = MapValue<typeof resolveActivityCategories>
type AdminUserRow = MapValue<typeof resolveAdminUsers>
type CouponCategoryRow = MapValue<typeof resolveCouponCategories>
export type RegionRow = RegionIndex['byCode'] extends Map<string, infer V> ? V : never

/** 地区行的最小结构（纯函数只依赖这些字段，方便单测手造对象） */
export interface RegionRowLike {
  regionCode: string
  regionName: string | null
  parentCode: string | null
  level: number | null
  isPlanSingleCity: number | null
}

// ---------- 常量 ----------

export const REGION_MATCH_STRATEGY = {
  EXACT: 'EXACT',
  INCLUDE_ALL: 'INCLUDE_ALL',
  EXCLUDE_PLAN_SINGLE_CITY: 'EXCLUDE_PLAN_SINGLE_CITY',
} as const
const NATIONWIDE_REGION_CODE = '100000'
export const BANK_CARD_MATCH_STATUS = {
  MATCHED: 'MATCHED',
  MISSING_BANK_CARD_TYPE: 'MISSING_BANK_CARD_TYPE',
  MISSING_CARD_ORGANIZATION: 'MISSING_CARD_ORGANIZATION',
  MISSING_REGION: 'MISSING_REGION',
} as const
export const BANK_CARD_MATCH_ACTION = {
  ADD_CARD: 'ADD_CARD',
  APPLY_CARD: 'APPLY_CARD',
} as const

// ---------- 对外类型 ----------

export interface TaskTemplateFilterParams {
  userId?: number
  keyword?: string
  quickFilter?: string
  canAddOnly?: boolean
  officialOnly?: boolean
  sortBy?: string
  bankId?: string
  bankIds?: string[] // 多值（新）；与 bankId 取并集，IN 语义
  cardType?: string
  cardOrganization?: string
  cardOrganizations?: string[] // 多值（新）；与 cardOrganization 取并集，OR 语义（template 含 ANY 即匹配）
  regionCode?: string
  regionCodes?: string[] // 多值（新）；与 regionCode 取并集，IN 语义
  benefitCategoryId?: number
  benefitCategoryIds?: number[] // 多值（新）；与 benefitCategoryId 取并集，IN 语义
  activityCategoryId?: number
  activityCategoryIds?: number[] // 多值（新）；与 activityCategoryId 取并集；每个 root 展开后代后再并集
  customTabCode?: string // 自定义运营 tab 的 code；命中时把 templateIds 当硬过滤
}

/** 解析后的模板 DTO：旧系统为实体展开 + 附加字段的动态对象，这里保持宽松 */
export type ParsedTemplate = Record<string, any> & { id: number }

export type BankCardMatchStatus = typeof BANK_CARD_MATCH_STATUS[keyof typeof BANK_CARD_MATCH_STATUS]
type BankCardMatchActionType = typeof BANK_CARD_MATCH_ACTION[keyof typeof BANK_CARD_MATCH_ACTION]

export interface BankCardMatchAction {
  type: BankCardMatchActionType
  text: string
  payload: Record<string, any> | null
}

export interface BankCardMatchResult {
  status: BankCardMatchStatus
  message: string
  matchedCardId: string | null
  matchedCardLastFour: string | null
  requiredCardType: 'CREDIT' | 'DEBIT'
  requiredOrganizationIds: string[]
  requiredOrganizationLogos: string[]
  requiredRegionCode: string | null
  requiredRegionText: string | null
  actions: BankCardMatchAction[]
}

export interface CardOrganizationContext {
  orgById: Map<string, CardOrganizationRow>
  orgIdByName: Map<string, string>
  comboIdByMembers: Map<string, string>
  baseOrgIds: {
    unionpay: string | null
    visa: string | null
    ae: string | null
    mastercard: string | null
    jcb: string | null
  }
}

export interface RegionContext {
  regionMap: Map<string, RegionRow>
  provincePlanSingleCityMap: Map<string, string[]>
}

interface TaskTemplateParseContext {
  bankMap: Map<number, BankRow>
  cardTemplateMap: Map<number, BankCardTemplateRow>
  bankCards: BankCardRow[]
  cardOrganizationContext: CardOrganizationContext
  benefitCategoryMap: Map<number, BenefitCategoryRow>
  benefitPayPlatformMap: Map<number, BenefitPayPlatformRow>
  benefitUsagePlatformMap: Map<number, BenefitUsagePlatformRow>
  activityCategoryMap: Map<number, ActivityCategoryRow>
  adminUserMap: Map<number, AdminUserRow>
  couponCategoryMap: Map<number, CouponCategoryRow>
  regionContext: RegionContext
  likedTemplateIds?: Set<number>
}

// 本地调试（NODE_ENV=local）不按 is_visible 过滤，方便看未上架活动；生产正常过滤。
const visibilityWhere = config.isLocal() ? undefined : eq(taskTemplate.isVisible, 1)

// ═════════════════════════ 纯函数（可单测） ═════════════════════════

/**
 * 给定一组活动分类 root id + 全部分类行，返回它们自身 + 所有后代 id 的并集（BFS）。
 * 没传任何有效 id 时返回 null（applyFilters 跳过该筛选）。
 */
export function expandActivityDescendantIds(
  rootIds: number[],
  categories: Array<{ id: number, parentId: number | null }>,
): Set<number> | null {
  const cleaned = rootIds
    .map(id => Number(id))
    .filter(id => Number.isFinite(id) && id > 0)
  if (cleaned.length === 0)
    return null

  const childrenMap = new Map<number, number[]>()
  for (const cat of categories) {
    const parent = cat.parentId
    if (parent == null)
      continue
    const list = childrenMap.get(Number(parent)) || []
    list.push(Number(cat.id))
    childrenMap.set(Number(parent), list)
  }

  const result = new Set<number>(cleaned)
  const queue: number[] = [...cleaned]
  while (queue.length > 0) {
    const head = queue.shift()!
    const kids = childrenMap.get(head)
    if (!kids)
      continue
    for (const k of kids) {
      if (!result.has(k)) {
        result.add(k)
        queue.push(k)
      }
    }
  }
  return result
}

/** 模板第一档的达标金额（无档位/空值按 0）——分组与详情排序的统一键 */
export function firstTierMinAmount(tpl: unknown): number {
  const tiers = Array.isArray((tpl as any)?.tiers) ? (tpl as any).tiers : []
  return Number(tiers[0]?.minAmount) || 0
}

/**
 * 列表筛选 + 排序（与旧 applyFilters 逐条对应）：
 * keyword / bank 并集 / cardType / 卡组织 ANY / region 并集 / benefit 类目并集 /
 * 活动分类（含后代展开集合）/ officialOnly / canAddOnly；sortBy=ADD_COUNT_DESC 时按
 * addCount 降序、id 降序兜底。
 */
export function applyFilters(
  parsed: ParsedTemplate[],
  params: TaskTemplateFilterParams,
  activityDescendants: Set<number> | null = null,
): ParsedTemplate[] {
  const keyword = (params.keyword || '').trim().toLowerCase()
  const quickFilter = (params.quickFilter || '').trim().toUpperCase()
  const cardType = (params.cardType || '').trim().toUpperCase()
  const cardOrganizationSet = new Set<string>([
    ...(params.cardOrganization ? [params.cardOrganization.trim().toUpperCase()] : []),
    ...((params.cardOrganizations ?? [])
      .map(v => String(v).trim().toUpperCase())
      .filter(Boolean)),
  ])
  const benefitCategoryIdSet = new Set<number>([
    ...(params.benefitCategoryId != null ? [Number(params.benefitCategoryId)] : []),
    ...((params.benefitCategoryIds ?? []).map(v => Number(v))).filter(v => Number.isFinite(v) && v > 0),
  ])

  // 归一化：单值 bankId/regionCode + 多值 bankIds/regionCodes 取并集，IN 语义
  // 老客户端只传 single，新客户端只传 multi；都不传 → 空集合 → 跳过该条件
  const bankIdSet = new Set<string>([
    ...(params.bankId ? [params.bankId.trim()] : []),
    ...((params.bankIds ?? []).map(v => String(v).trim()).filter(Boolean)),
  ])
  const regionCodeSet = new Set<string>([
    ...(params.regionCode ? [params.regionCode.trim()] : []),
    ...((params.regionCodes ?? []).map(v => String(v).trim()).filter(Boolean)),
  ])

  const canAddOnly
    = params.canAddOnly === true
      || quickFilter === 'CAN_ADD'
      || quickFilter === 'CAN_ADD_ONLY'
      || quickFilter === 'MY_CAN_ADD'
  const officialOnly = params.officialOnly === true || quickFilter === 'OFFICIAL'
  const sortBy = (`${params.sortBy || (quickFilter === 'MOST_ADDED' ? 'ADD_COUNT_DESC' : '')}`).trim().toUpperCase()

  let list = parsed.filter((item) => {
    if (keyword) {
      const title = String(item.title || '').toLowerCase()
      const desc = String(item.ruleDetail || '').toLowerCase()
      if (!title.includes(keyword) && !desc.includes(keyword))
        return false
    }

    if (bankIdSet.size > 0 && !bankIdSet.has(String(item.bankId || '')))
      return false

    // 借记 / 信用卡筛选：模板表 bankCardType 字段，大小写无关比对
    if (cardType && String(item.bankCardType || '').trim().toUpperCase() !== cardType)
      return false

    if (cardOrganizationSet.size > 0) {
      const orgs: string[] = Array.isArray(item.cardOrganizations) ? item.cardOrganizations : []
      const hasMatch = orgs.some(o => cardOrganizationSet.has(String(o).toUpperCase()))
      if (!hasMatch)
        return false
    }

    if (regionCodeSet.size > 0 && !regionCodeSet.has(String(item.regionCode || '')))
      return false
    if (benefitCategoryIdSet.size > 0 && !benefitCategoryIdSet.has(Number(item.benefitCategoryId)))
      return false
    // 活动分类：用预构的「自身 + 所有后代」集合判断，让一级筛选包含其下二级及更深层的模板
    if (activityDescendants && !activityDescendants.has(Number(item.activityCategoryId)))
      return false

    if (officialOnly && String(item.publisher || '').trim() === '')
      return false
    if (canAddOnly && item.bankCardMatch?.status !== BANK_CARD_MATCH_STATUS.MATCHED)
      return false

    return true
  })

  if (sortBy === 'ADD_COUNT_DESC' || sortBy === 'MOST_ADDED') {
    list = [...list].sort((a, b) => {
      const diff = Number(b.addCount || 0) - Number(a.addCount || 0)
      if (diff !== 0)
        return diff
      return Number(b.id || 0) - Number(a.id || 0)
    })
  }

  return list
}

/**
 * 按 groupId 聚合为 activity：groupId 非空 → 同 group 多行聚合（组内按首档达标金额升序）；
 * groupId 为空 → 单行独立成 activity。activity 之间按 rootId 降序。
 */
export function groupByActivity(parsed: ParsedTemplate[]): ParsedTemplate[] {
  const byGroup = new Map<string, ParsedTemplate[]>()
  for (const tpl of parsed) {
    const key = tpl.groupId != null ? `g:${tpl.groupId}` : `s:${tpl.id}`
    const arr = byGroup.get(key)
    if (arr)
      arr.push(tpl)
    else byGroup.set(key, [tpl])
  }
  const activities: ParsedTemplate[] = []
  for (const templates of byGroup.values()) {
    templates.sort((a, b) => firstTierMinAmount(a) - firstTierMinAmount(b))
    const root = templates[0]
    activities.push({
      ...root,
      rootId: root.groupId ?? root.id,
      templates,
    })
  }
  activities.sort((a, b) => Number(b.rootId) - Number(a.rootId))
  return activities
}

/** 兼容两种存储格式：how-admin 写逗号分隔 "1,3,5"；how-api 写 JSON "[1,3,5]"。都失败则空数组兜底 */
export function parseJsonArray(s: string | null | undefined): number[] {
  if (!s || typeof s !== 'string')
    return []
  try {
    const arr = JSON.parse(s)
    if (Array.isArray(arr)) {
      return arr.map((x: any) => Number(x)).filter((n: number) => !Number.isNaN(n))
    }
    // JSON.parse 成功但不是数组（如 '7' → 数字 7） → fallthrough 走逗号 split
  }
  catch {
    // 非合法 JSON → fallthrough 走逗号 split
  }
  return s
    .split(',')
    .map((x: string) => Number(x.trim()))
    .filter((n: number) => !Number.isNaN(n))
}

/** 卡组织字段（JSON 数组字符串或逗号分隔）→ string[] */
export function parseJsonStringArray(s: string | null | undefined): string[] {
  if (!s || typeof s !== 'string')
    return []
  try {
    const arr = JSON.parse(s)
    return Array.isArray(arr) ? arr.filter((x: any) => typeof x === 'string') : []
  }
  catch {
    return s.split(',').map(x => x.trim()).filter(Boolean)
  }
}

/** TypeORM/drizzle 把 JSON 反序列化后金额字段可能是字符串；统一规整为 number 或 null */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '')
    return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 档位数组规整：decimal 字段统一为 number/null */
export function normalizeTiers(raw: unknown): Array<{
  minAmount: number | null
  benefitAmountFixed: number | null
  benefitAmountMin: number | null
  benefitAmountMax: number | null
  benefitDescription: string | null
  quotaPerCycleText: string | null
  quotaTotalText: string | null
}> {
  if (!Array.isArray(raw))
    return []
  return raw.map((t: any) => {
    const tier = t || {}
    return {
      minAmount: toNumberOrNull(tier.minAmount),
      benefitAmountFixed: toNumberOrNull(tier.benefitAmountFixed),
      benefitAmountMin: toNumberOrNull(tier.benefitAmountMin),
      benefitAmountMax: toNumberOrNull(tier.benefitAmountMax),
      benefitDescription: tier.benefitDescription ?? null,
      quotaPerCycleText: tier.quotaPerCycleText ?? null,
      quotaTotalText: tier.quotaTotalText ?? null,
    }
  })
}

/** 卡组织名归一化：大写、全角/分隔符统一、运通/万事达别名收敛，用于名字 → ID 反查 */
export function normalizeOrganizationAlias(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/＋/g, '+')
    .replace(/，/g, ',')
    .replace(/\s+/g, '')
    .replace(/AMERICANEXPRESS/g, 'AE')
    .replace(/AMEX/g, 'AE')
    .replace(/美国运通/g, 'AE')
    .replace(/运通/g, 'AE')
    .replace(/MASTERCARD/g, '万事达')
    .replace(/_/g, '+')
}

/** 卡组织来源串拆 token：JSON 数组字符串优先，否则按 | 分隔 */
export function splitOrganizationSource(source: string): string[] {
  const raw = source.trim()
  if (!raw)
    return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.map(item => String(item).trim()).filter(Boolean)
    }
  }
  catch {
    // ignore
  }
  return raw.split('|').map(item => item.trim()).filter(Boolean)
}

export function parseCsv(raw: string | null | undefined): string[] {
  if (!raw || typeof raw !== 'string')
    return []
  return raw.split(',').map(item => item.trim()).filter(Boolean)
}

function toMemberKey(memberIds: string[]): string {
  return [...new Set(memberIds.map(id => id.trim()).filter(Boolean))].sort().join(',')
}

/** 全量卡组织字典 → 名字/组合反查上下文（每次 parse 复用同一份，构建本身零 IO） */
export function buildCardOrganizationContext(rows: CardOrganizationRow[]): CardOrganizationContext {
  const orgById = new Map<string, CardOrganizationRow>()
  const orgIdByName = new Map<string, string>()
  const comboIdByMembers = new Map<string, string>()

  rows.forEach((row) => {
    const id = String(row.id)
    orgById.set(id, row)
    orgIdByName.set(normalizeOrganizationAlias(row.name), id)
  })

  rows.forEach((row) => {
    const id = String(row.id)
    const memberIds = parseCsv(row.memberOrgIds)
    if (memberIds.length > 1) {
      const key = toMemberKey(memberIds)
      comboIdByMembers.set(key, id)
    }
  })

  const findOrgIdByAliases = (aliases: string[]): string | null => {
    for (const alias of aliases) {
      const id = orgIdByName.get(normalizeOrganizationAlias(alias))
      if (id)
        return id
    }
    return null
  }

  const baseOrgIds = {
    unionpay: findOrgIdByAliases(['银联', 'UNIONPAY']),
    visa: findOrgIdByAliases(['VISA']),
    ae: findOrgIdByAliases(['AE', 'AMEX', '美国运通', '运通']),
    mastercard: findOrgIdByAliases(['MASTERCARD', '万事达', '万事达卡']),
    jcb: findOrgIdByAliases(['JCB']),
  }

  return { orgById, orgIdByName, comboIdByMembers, baseOrgIds }
}

function resolveComboId(orgContext: CardOrganizationContext, first: string | null, second: string | null): string | null {
  if (!first || !second)
    return null
  return orgContext.comboIdByMembers.get(toMemberKey([first, second])) ?? null
}

/** 单个 token（数字 ID / 名称 / 组合名）→ 卡组织 ID；认不出返回 null */
export function resolveOrganizationTokenToId(token: string, orgContext: CardOrganizationContext): string | null {
  const raw = token.trim()
  if (!raw)
    return null
  if (/^\d+$/.test(raw)) {
    return orgContext.orgById.has(raw) ? raw : null
  }

  const normalized = normalizeOrganizationAlias(raw)
  if (!normalized)
    return null

  const directByName = orgContext.orgIdByName.get(normalized)
  if (directByName)
    return directByName

  const memberTokens = normalized
    .split(/[+,]/)
    .map(item => item.trim())
    .filter(Boolean)

  if (memberTokens.length > 1) {
    const memberIds = memberTokens
      .map(item => resolveOrganizationTokenToId(item, orgContext))
      .filter((id): id is string => Boolean(id))
    if (memberIds.length > 1) {
      const comboId = orgContext.comboIdByMembers.get(toMemberKey(memberIds))
      if (comboId)
        return comboId
    }
  }

  if (normalized === 'UNIONPAY')
    return orgContext.baseOrgIds.unionpay
  if (normalized === 'VISA')
    return orgContext.baseOrgIds.visa
  if (normalized === 'AE')
    return orgContext.baseOrgIds.ae
  if (normalized === '万事达')
    return orgContext.baseOrgIds.mastercard
  if (normalized === 'JCB')
    return orgContext.baseOrgIds.jcb

  if (normalized === 'UNIONPAY+VISA') {
    return resolveComboId(orgContext, orgContext.baseOrgIds.unionpay, orgContext.baseOrgIds.visa)
  }
  if (normalized === 'UNIONPAY+万事达') {
    return resolveComboId(orgContext, orgContext.baseOrgIds.unionpay, orgContext.baseOrgIds.mastercard)
  }
  if (normalized === 'UNIONPAY+AE') {
    return resolveComboId(orgContext, orgContext.baseOrgIds.unionpay, orgContext.baseOrgIds.ae)
  }
  if (normalized === 'UNIONPAY+JCB') {
    return resolveComboId(orgContext, orgContext.baseOrgIds.unionpay, orgContext.baseOrgIds.jcb)
  }

  return null
}

/** 卡（可能存 ID、名称或组合串）→ 卡组织 ID 集合 */
function resolveCardOrganizationIds(raw: string | null | undefined, orgContext: CardOrganizationContext): string[] {
  if (!raw)
    return []
  const source = String(raw).trim()
  if (!source)
    return []
  const tokens = splitOrganizationSource(source)
  const ids = tokens
    .map(token => resolveOrganizationTokenToId(token, orgContext))
    .filter((id): id is string => Boolean(id))
  if (ids.length > 0)
    return Array.from(new Set(ids))

  const direct = resolveOrganizationTokenToId(source, orgContext)
  return direct ? [direct] : []
}

function toValidNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function isNationwideRegionCode(regionCode: string): boolean {
  return regionCode === NATIONWIDE_REGION_CODE
}

/** city(3) → parent(2) 上滚；level=2 返回自身；其余 null */
export function getProvinceCode(regionCode: string, regionMap: Map<string, RegionRowLike>): string | null {
  const region = regionMap.get(regionCode)
  if (!region)
    return null
  if (Number(region.level) === 2)
    return region.regionCode
  if (Number(region.level) === 3) {
    const parent = (region.parentCode || '').trim()
    return parent || null
  }
  return null
}

/**
 * 银行卡地区匹配（ADR-003）：
 * - 模板全国（100000 / 空）→ 全部匹配
 * - EXACT：regionCode 全等
 * - INCLUDE_ALL：同省即匹配
 * - EXCLUDE_PLAN_SINGLE_CITY：同省且（非计划单列市，或层级缺失时从宽）
 * - 未知策略按 EXACT 兜底
 */
export function isRegionMatched(
  templateRegionCode: string,
  regionMatchStrategy: string | null | undefined,
  cardRegionCode: string,
  regionMap: Map<string, RegionRowLike>,
): boolean {
  const tplCode = (templateRegionCode || '').trim()
  const cardCode = (cardRegionCode || '').trim()

  if (!tplCode || isNationwideRegionCode(tplCode))
    return true
  if (!cardCode)
    return false

  const strategy = (regionMatchStrategy || REGION_MATCH_STRATEGY.EXACT).trim().toUpperCase()

  if (strategy === REGION_MATCH_STRATEGY.EXACT) {
    return cardCode === tplCode
  }

  const templateProvinceCode = getProvinceCode(tplCode, regionMap)
  const cardProvinceCode = getProvinceCode(cardCode, regionMap)

  if (!templateProvinceCode || !cardProvinceCode || templateProvinceCode !== cardProvinceCode) {
    return false
  }

  if (strategy === REGION_MATCH_STRATEGY.INCLUDE_ALL) {
    return true
  }

  if (strategy === REGION_MATCH_STRATEGY.EXCLUDE_PLAN_SINGLE_CITY) {
    const cardRegion = regionMap.get(cardCode)
    if (!cardRegion)
      return true
    if (Number(cardRegion.level) !== 3)
      return true
    return Number(cardRegion.isPlanSingleCity || 0) !== 1
  }

  return cardCode === tplCode
}

/** 地区展示文案：全国 → ''；未知 → '区域活动'；省份 EXCLUDE 计划单列市 → 「XX除A、B外」 */
export function buildRegionDisplayText(
  templateRegionCode: string,
  regionMatchStrategy: string | null | undefined,
  regionMap: Map<string, RegionRowLike>,
  provincePlanSingleCityMap: Map<string, string[]>,
): string {
  const tplCode = (templateRegionCode || '').trim()
  if (!tplCode || isNationwideRegionCode(tplCode))
    return ''

  const region = regionMap.get(tplCode)
  const regionName = (region?.regionName || '').trim()
  if (!regionName)
    return '区域活动'

  const strategy = (regionMatchStrategy || REGION_MATCH_STRATEGY.EXACT).trim().toUpperCase()
  if (strategy === REGION_MATCH_STRATEGY.EXCLUDE_PLAN_SINGLE_CITY && Number(region?.level) === 2) {
    const excludedCities = (provincePlanSingleCityMap.get(tplCode) ?? []).filter(Boolean)
    if (excludedCities.length > 0) {
      return `${regionName}除${excludedCities.join('、')}外`
    }
  }

  return `${regionName}`
}

// ═════════════════════════ 服务函数（DB） ═════════════════════════

/**
 * 广场列表：visibility 过滤 →（customTabCode 时按 tab 的 templateIds 硬过滤）→
 * 解析富化 → 参数筛选 → groupId 聚合 →（customTabCode 时按 admin 配置顺序重排）。
 */
export async function getTaskTemplates(params: TaskTemplateFilterParams = {}): Promise<ParsedTemplate[]> {
  let templateIdOrder: number[] | null = null
  if (params.customTabCode) {
    const ids = await getCustomTabTemplateIds(params.customTabCode)
    if (!ids || ids.length === 0)
      return []
    templateIdOrder = ids
  }

  const list = templateIdOrder
    ? await db.select().from(taskTemplate).where(and(
        inArray(taskTemplate.id, templateIdOrder),
        visibilityWhere,
      ))
    : await db.select().from(taskTemplate).where(visibilityWhere).orderBy(desc(taskTemplate.id))

  const currentUserId = params.userId && params.userId > 0 ? params.userId : undefined
  // 列表接口不查点赞（ha 列表不展示点赞态）；详情接口 getTaskTemplateById 仍查
  const likedTemplateIds = undefined
  const context = await buildParseContext(list, likedTemplateIds, currentUserId)
  const parsed = list.map(row => parseTemplate(row, context))
  // 用户筛选活动类型时，把传入的 ID 展开为它自己 + 所有后代 ID（一级 → 一级 + 二级 + ...）
  // 模板存的多数是叶子级 id，只查一级时不展开会 silent 0 命中
  const activityRoots = [
    ...(params.activityCategoryId != null ? [Number(params.activityCategoryId)] : []),
    ...((params.activityCategoryIds ?? []).map(v => Number(v))),
  ]
  const allActivityCategories = Array.from((await resolveActivityCategories([])).values())
  const activityDescendants = expandActivityDescendantIds(activityRoots, allActivityCategories)
  const filtered = applyFilters(parsed, params, activityDescendants)
  const grouped = groupByActivity(filtered)

  // customTabCode 命中：按 admin 配置的 templateIds 顺序重排 activity 列表
  // 必须放在 groupByActivity 之后（groupByActivity 内部会按 rootId DESC 排序覆盖之前的顺序）
  if (templateIdOrder) {
    const orderMap = new Map(templateIdOrder.map((id, idx) => [id, idx]))
    return [...grouped].sort((a, b) => (orderMap.get(Number(a.id)) ?? 9999) - (orderMap.get(Number(b.id)) ?? 9999))
  }

  return grouped
}

/** 自定义 Tab 的 templateIds：生产要求 is_visible=1 且在起止时间内；本地调试全放行 */
async function getCustomTabTemplateIds(code: string): Promise<number[] | null> {
  const [row] = await db.select().from(plazaCustomTab).where(eq(plazaCustomTab.code, code)).limit(1)
  if (!row)
    return null
  if (!config.isLocal()) {
    const now = Date.now()
    if (row.isVisible !== 1)
      return null
    if (row.startTime != null && row.startTime > now)
      return null
    if (row.endTime != null && row.endTime <= now)
      return null
  }
  return row.templateIds
}

/** 活动详情：本行 + 同 groupId 兄弟行（都可见）聚合为 activity，附 per-user 点赞/置顶/提醒标记 */
export async function getTaskTemplateById(
  id: string,
  userId?: number,
): Promise<{ activity: ParsedTemplate, currentTemplate: ParsedTemplate } | null> {
  const templateId = Number(id)
  if (Number.isNaN(templateId))
    return null

  const [row] = await db.select().from(taskTemplate).where(and(
    eq(taskTemplate.id, templateId),
    visibilityWhere,
  )).limit(1)
  if (!row)
    return null

  // 同 groupId 的兄弟行属于同一聚合活动；groupId 为空则该行独立成活动
  // 兄弟也只取可见的，避免聚合卡里混入隐藏档位
  const siblingRows = row.groupId != null
    ? await db.select().from(taskTemplate).where(and(
        eq(taskTemplate.groupId, row.groupId),
        visibilityWhere,
      )).orderBy(asc(taskTemplate.id))
    : [row]

  const ids = siblingRows.map(r => Number(r.id)).filter(n => Number.isFinite(n) && n > 0)
  const likedTemplateIds = await getLikedTemplateIds(ids, userId)
  const userTaskFlags = await getUserTaskFlags(ids, userId)
  const context = await buildParseContext(siblingRows, likedTemplateIds, userId)
  const parsed = siblingRows.map((r) => {
    const dto = parseTemplate(r, context)
    const flags = userTaskFlags.get(Number(r.id))
    dto.hasPinned = flags?.hasPinned ?? false
    dto.hasReminder = flags?.hasReminder ?? false
    return dto
  })
  parsed.sort((a, b) => firstTierMinAmount(a) - firstTierMinAmount(b))

  const root = parsed[0]
  const currentTemplate = parsed.find(t => t.id === templateId) ?? root
  const activity = {
    ...root,
    rootId: row.groupId ?? row.id,
    templates: parsed,
  }
  return { activity, currentTemplate }
}

/**
 * 给定一组 templateId + userId，返回每个 templateId 的 hasPinned/hasReminder
 * - hasPinned：用户已为该模板创建过 kind='PIN' 的置顶任务
 * - hasReminder：用户已为该模板创建过 kind='REMINDER'（或兼容历史 NULL）的提醒任务
 */
async function getUserTaskFlags(
  templateIds: number[],
  userId?: number,
): Promise<Map<number, { hasPinned: boolean, hasReminder: boolean }>> {
  const result = new Map<number, { hasPinned: boolean, hasReminder: boolean }>()
  if (!userId || userId <= 0 || templateIds.length === 0)
    return result
  const tasks = await db.select({
    taskTemplateId: task.taskTemplateId,
    kind: task.kind,
  }).from(task).where(and(
    eq(task.userId, userId),
    inArray(task.taskTemplateId, templateIds),
  ))
  for (const t of tasks) {
    const tplId = Number(t.taskTemplateId)
    if (!result.has(tplId))
      result.set(tplId, { hasPinned: false, hasReminder: false })
    const flags = result.get(tplId)!
    if (t.kind === 'PIN')
      flags.hasPinned = true
    else flags.hasReminder = true
  }
  return result
}

/** Pin 模板：从模板字段直接生成一个 kind='PIN' 的置顶任务（不参与提醒，不可升级） */
export async function pinTaskTemplate(userId: number, id: string): Promise<{ id: number }> {
  const templateId = Number(id)
  if (!Number.isFinite(templateId) || templateId <= 0)
    throw new Error('模板 ID 不合法')
  const [row] = await db.select().from(taskTemplate).where(and(
    eq(taskTemplate.id, templateId),
    visibilityWhere,
  )).limit(1)
  if (!row)
    throw new Error('活动不存在')

  // 已 Pin 过 → 幂等：以 kind='PIN' 为唯一识别（不再依赖 reminderTime 是否为空）
  const [existing] = await db.select({ id: task.id }).from(task).where(and(
    eq(task.userId, userId),
    eq(task.taskTemplateId, templateId),
    eq(task.kind, 'PIN'),
  )).limit(1)
  if (existing)
    return { id: Number(existing.id) }

  // 拼装最小可用任务（旧 TaskService.createTask 对该 DTO 的落库语义）：
  // title/repeatType/dates 来自模板，kind=PIN，档位 0 的金额快照（如有）
  const tier0 = Array.isArray(row.tiers) ? row.tiers[0] : null
  const repeatType = row.repeatType || 'ONE_TIME'
  // ONE_TIME：date 用 startDate / 今天兜底；循环任务 date 也存 startDate
  const date = row.startDate ?? Date.now()
  const now = Date.now()

  const [created] = await db.insert(task).values({
    userId,
    title: row.title,
    description: null,
    date,
    repeatType,
    reminderTime: null,
    expireAt: null,
    bankId: row.bankId != null ? String(row.bankId) : null,
    frequencyControl: null,
    highPriority: 0,
    status: 'PENDING',
    createdAt: now,
    taskTemplateId: row.id,
    bankCardType: row.bankCardType ?? null,
    bankCardLevel: row.bankCardLevel ?? null,
    benefitCategoryId: row.benefitCategoryId ?? null,
    benefitPayPlatformId: row.benefitPayPlatformId ?? null,
    minAmount: toDecimalString(tier0?.minAmount),
    benefitAmountFixed: toDecimalString(tier0?.benefitAmountFixed),
    benefitAmountMin: toDecimalString(tier0?.benefitAmountMin),
    benefitAmountMax: toDecimalString(tier0?.benefitAmountMax),
    benefitVoucherDescription: tier0?.benefitDescription ?? null,
    quotaPerCycleText: tier0?.quotaPerCycleText ?? null,
    quotaTotalText: tier0?.quotaTotalText ?? null,
    cardOrganizations: null,
    kind: 'PIN',
    advanceReminderMinutes: 0,
    updatedAt: new Date(),
  }).$returningId()

  // 循环模板：补 task_recurring 规则（旧 upsertRecurringRule 语义；days 字段传的是模板原始
  // 字符串，旧 stringifyArray 对非数组一律落 null，这里保持一致）
  if (repeatType !== 'ONE_TIME') {
    await db.insert(taskRecurring).values({
      taskId: Number(created.id),
      repeatType,
      daysOfWeek: null,
      daysOfMonth: null,
      yearlyMonths: null,
      yearlyDaysOfMonth: null,
      startDate: row.startDate ?? date,
      endDate: row.endDate ?? null,
      reminderTime: null,
      createdAt: now,
      updatedAt: new Date(),
    })
  }

  return { id: Number(created.id) }
}

/** drizzle decimal 列按字符串写入（与 TypeORM 写 number 的落库结果一致） */
function toDecimalString(v: number | null | undefined): string | null {
  return v == null ? null : String(v)
}

export async function likeTaskTemplate(id: string, userId: number): Promise<{ liked: boolean, likes: number }> {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('未登录')
  }
  const templateId = Number(id)
  if (Number.isNaN(templateId)) {
    throw new TypeError('无效的模板 ID')
  }

  const [row] = await db.select().from(taskTemplate).where(eq(taskTemplate.id, templateId)).limit(1)
  if (!row) {
    throw new Error('Task template not found')
  }

  const [existing] = await db.select({ id: taskTemplateLike.id }).from(taskTemplateLike).where(and(
    eq(taskTemplateLike.taskTemplateId, templateId),
    eq(taskTemplateLike.userId, userId),
  )).limit(1)
  if (existing) {
    return { liked: true, likes: Number(row.likes || 0) }
  }

  await db.insert(taskTemplateLike).values({
    taskTemplateId: templateId,
    userId,
    createdAt: Date.now(),
  })

  const nextLikes = Number(row.likes || 0) + 1
  // 显式 SET updated_at = updated_at 让 MySQL 跳过 ON UPDATE CURRENT_TIMESTAMP，
  // 避免点赞污染「发布时间」（前端 publishTime 取自 updated_at）
  await db.update(taskTemplate).set({
    likes: sql`${taskTemplate.likes} + 1`,
    updatedAt: sql`${taskTemplate.updatedAt}`,
  }).where(eq(taskTemplate.id, templateId))

  return { liked: true, likes: nextLikes }
}

export async function unlikeTaskTemplate(id: string, userId: number): Promise<{ liked: boolean, likes: number }> {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('未登录')
  }
  const templateId = Number(id)
  if (Number.isNaN(templateId)) {
    throw new TypeError('无效的模板 ID')
  }

  const [row] = await db.select().from(taskTemplate).where(eq(taskTemplate.id, templateId)).limit(1)
  if (!row) {
    throw new Error('Task template not found')
  }

  const [existing] = await db.select({ id: taskTemplateLike.id }).from(taskTemplateLike).where(and(
    eq(taskTemplateLike.taskTemplateId, templateId),
    eq(taskTemplateLike.userId, userId),
  )).limit(1)
  if (!existing) {
    return { liked: false, likes: Number(row.likes || 0) }
  }

  await db.delete(taskTemplateLike).where(eq(taskTemplateLike.id, existing.id))
  const nextLikes = Math.max(0, Number(row.likes || 0) - 1)
  // 同 likeTaskTemplate：freeze updated_at，避免污染发布时间
  await db.update(taskTemplate).set({
    likes: nextLikes,
    updatedAt: sql`${taskTemplate.updatedAt}`,
  }).where(eq(taskTemplate.id, templateId))

  return { liked: false, likes: nextLikes }
}

// ---------- 解析上下文 ----------

async function getLikedTemplateIds(templateIds: number[], userId?: number): Promise<Set<number>> {
  if (templateIds.length === 0 || !userId || userId <= 0)
    return new Set<number>()
  const rows = await db.select().from(taskTemplateLike).where(and(
    inArray(taskTemplateLike.taskTemplateId, templateIds),
    eq(taskTemplateLike.userId, userId),
  ))
  return new Set(rows.map(item => Number(item.taskTemplateId)))
}

async function buildRegionContext(list: TaskTemplateRow[], bankCards: BankCardRow[]): Promise<RegionContext> {
  const directCodes = Array.from(
    new Set(
      [...list.map(item => (item.regionCode || '').trim()), ...bankCards.map(card => (card.regionCode || '').trim())]
        .filter(Boolean),
    ),
  )

  if (directCodes.length === 0) {
    return {
      regionMap: new Map<string, RegionRow>(),
      provincePlanSingleCityMap: new Map<string, string[]>(),
    }
  }

  // Region 静态字典走整表缓存，下面全部内存遍历，零 DB 查询。
  const { byCode, byParent } = await getRegionIndex()

  const regionMap = new Map<string, RegionRow>()
  const directRegions: RegionRow[] = []
  directCodes.forEach((code) => {
    const region = byCode.get(code)
    if (region) {
      regionMap.set(region.regionCode, region)
      directRegions.push(region)
    }
  })

  const provinceCodesToLoad = Array.from(
    new Set(
      directRegions
        .filter(item => Number(item.level) === 3)
        .map(item => (item.parentCode || '').trim())
        .filter(Boolean),
    ),
  ).filter(code => !regionMap.has(code))

  provinceCodesToLoad.forEach((code) => {
    const region = byCode.get(code)
    if (region)
      regionMap.set(region.regionCode, region)
  })

  const provinceCodes = Array.from(
    new Set(
      Array.from(regionMap.values())
        .filter(item => Number(item.level) === 2)
        .map(item => item.regionCode),
    ),
  )

  const provincePlanSingleCityMap = new Map<string, string[]>()
  if (provinceCodes.length > 0) {
    const grouped = new Map<string, string[]>()
    provinceCodes.forEach((provinceCode) => {
      const children = byParent.get(provinceCode) ?? []
      children.forEach((region) => {
        if (!regionMap.has(region.regionCode)) {
          regionMap.set(region.regionCode, region)
        }
        if (Number(region.level) !== 3 || Number(region.isPlanSingleCity || 0) !== 1)
          return
        const parentCode = (region.parentCode || '').trim()
        if (!parentCode)
          return
        const names = grouped.get(parentCode) ?? []
        names.push(region.regionName || '')
        grouped.set(parentCode, names)
      })
    })

    grouped.forEach((names, code) => {
      provincePlanSingleCityMap.set(code, names.filter(Boolean))
    })
  }

  return { regionMap, provincePlanSingleCityMap }
}

async function buildParseContext(
  templates: TaskTemplateRow[],
  likedTemplateIds?: Set<number>,
  currentUserId?: number,
): Promise<TaskTemplateParseContext> {
  const bankIds = uniqueValid(templates.map(item => toValidNumber(item.bankId)))

  const cardTemplateIds = uniqueValid(
    templates
      .map(item => item.bankCardTemplateId)
      .filter((id): id is number => id !== null && id !== undefined)
      .map(id => Number(id))
      .filter(id => !Number.isNaN(id)),
  )

  const cardTemplates = cardTemplateIds.length
    ? await db.select().from(bankCardTemplate).where(inArray(bankCardTemplate.id, cardTemplateIds))
    : []
  const cardTemplateMap = new Map<number, BankCardTemplateRow>(
    cardTemplates.map(item => [item.id, item]),
  )

  const extraBankIds = uniqueValid(cardTemplates.map(item => toValidNumber(item.bankId)))

  // 字典表统一走 referenceCache（全量缓存 + miss-fallback），不再每请求查 DB
  const allBankIds = Array.from(new Set([...bankIds, ...extraBankIds]))
  const bankMap = await resolveBanks(allBankIds)

  const bankCards = currentUserId
    ? await db.select().from(bankCard).where(eq(bankCard.userId, currentUserId)).orderBy(desc(bankCard.createdAt))
    : []
  const cardOrganizations = await getCardOrganizations()
  const cardOrganizationContext = buildCardOrganizationContext(cardOrganizations)
  const regionContext = await buildRegionContext(templates, bankCards)

  const benefitCategoryIds = uniqueValid(templates.map(item => toValidNumber(item.benefitCategoryId)))
  const benefitCategoryMap = await resolveBenefitCategories(benefitCategoryIds)

  const benefitPlatformIds = uniqueValid(templates.map(item => toValidNumber(item.benefitPayPlatformId)))
  const benefitPayPlatformMap = await resolveBenefitPayPlatforms(benefitPlatformIds)

  const benefitUsagePlatformIds = uniqueValid(templates.map(item => toValidNumber(item.benefitUsagePlatformId)))
  const benefitUsagePlatformMap = await resolveBenefitUsagePlatforms(benefitUsagePlatformIds)

  const activityCategoryIds = uniqueValid(templates.map(item => toValidNumber(item.activityCategoryId)))
  const activityCategoryMap = await resolveActivityCategories(activityCategoryIds)

  const adminUserIds = Array.from(
    new Set(
      templates
        .map(item => Number(item.adminUserId))
        .filter(id => Number.isFinite(id) && id > 0),
    ),
  )
  const adminUserMap = await resolveAdminUsers(adminUserIds)

  // 收集所有模板 linked_coupons 中的 couponId
  const couponIds = Array.from(
    new Set(
      templates
        .flatMap(item => Array.isArray(item.linkedCoupons) ? item.linkedCoupons : [])
        .map(c => Number(c?.couponId))
        .filter(id => Number.isFinite(id) && id > 0),
    ),
  )
  const couponCategoryMap = await resolveCouponCategories(couponIds)

  return {
    bankMap,
    cardTemplateMap,
    bankCards,
    cardOrganizationContext,
    benefitCategoryMap,
    benefitPayPlatformMap,
    benefitUsagePlatformMap,
    activityCategoryMap,
    adminUserMap,
    couponCategoryMap,
    regionContext,
    likedTemplateIds,
  }
}

/** 数字列表去重（过滤 null/NaN/0 以下） */
function uniqueValid(values: Array<number | null>): number[] {
  return Array.from(new Set(values.filter((id): id is number => id !== null)))
}

// ---------- DTO 解析 ----------

function parseTemplate(row: TaskTemplateRow, context: TaskTemplateParseContext): ParsedTemplate {
  const result: ParsedTemplate = { ...row }
  const {
    bankMap,
    cardTemplateMap,
    bankCards,
    cardOrganizationContext,
    benefitCategoryMap,
    benefitPayPlatformMap,
    benefitUsagePlatformMap,
    activityCategoryMap,
    adminUserMap,
    couponCategoryMap,
    regionContext,
    likedTemplateIds,
  } = context

  const cardTemplate = row.bankCardTemplateId != null
    ? cardTemplateMap.get(Number(row.bankCardTemplateId)) ?? null
    : null

  result.bankCardTemplate = cardTemplate
    ? {
        id: cardTemplate.id,
        bankId: cardTemplate.bankId,
        cardName: cardTemplate.cardName,
        cardType: cardTemplate.cardType,
        cardLevel: cardTemplate.cardLevel,
        cardOrganization: cardTemplate.cardOrganization,
        cover: cardTemplate.cover,
      }
    : null

  const resolvedBankId = toValidNumber(row.bankId) ?? toValidNumber(cardTemplate?.bankId)
  result.bankId = resolvedBankId != null ? String(resolvedBankId) : null

  const bank = resolvedBankId != null
    ? bankMap.get(resolvedBankId)
    : null

  result.bank = bank
    ? {
        id: String(bank.id),
        name: bank.name,
        shortName: bank.shortName,
        code: bank.code,
        logo: bank.logo,
        themeColor: bank.themeColor,
        isUnifiedBill: !!bank.isUnifiedBill,
      }
    : null

  const matchedCards = resolveMatchedCards(
    row,
    bankCards,
    resolvedBankId,
    regionContext.regionMap,
  )
  const bankCardMatch = buildBankCardMatch(
    row,
    cardTemplate,
    bankCards,
    resolvedBankId,
    regionContext.regionMap,
    regionContext.provincePlanSingleCityMap,
    cardOrganizationContext,
  )
  const preferredCard = matchedCards.find(card => String(card.id) === bankCardMatch.matchedCardId) ?? null
  const preferredBankName = preferredCard
    ? (
        bankMap.get(toValidNumber(preferredCard.bankId) ?? -1)?.name
        ?? preferredCard.bankId
      )
    : null

  result.userBankCard = preferredCard
    ? {
        id: String(preferredCard.id),
        bankId: preferredCard.bankId,
        bankName: preferredBankName,
        cardType: preferredCard.cardType,
        cardOrganization: preferredCard.cardOrganization,
        cardName: preferredCard.cardName,
        cardLastFour: preferredCard.cardLastFour,
        templateId: preferredCard.templateId,
      }
    : null

  result.bankCardMatch = bankCardMatch
  result.jobTemplateId = row.jobTemplateId ?? null
  result.activityCategoryId = row.activityCategoryId ?? null
  result.ruleBrief = (row.ruleBrief || '').trim() || null
  result.ruleDetail = row.ruleDetail ?? null
  result.ruleSource = row.ruleSource ?? null
  result.regionDisplayText = buildRegionDisplayText(
    row.regionCode,
    row.regionMatchStrategy,
    regionContext.regionMap,
    regionContext.provincePlanSingleCityMap,
  )

  result.daysOfWeek = parseJsonArray(row.daysOfWeek)
  result.daysOfMonth = parseJsonArray(row.daysOfMonth)
  result.yearlyMonths = parseJsonArray(row.yearlyMonths)
  result.yearlyDaysOfMonth = parseJsonArray(row.yearlyDaysOfMonth)
  result.cardOrganizations = parseJsonStringArray(row.cardOrganizations)
  const benefitCategory = toValidNumber(row.benefitCategoryId) != null
    ? benefitCategoryMap.get(Number(row.benefitCategoryId))
    : null
  result.benefitCategoryName = benefitCategory?.name ?? null
  result.benefitCategoryIcon = benefitCategory?.icon ?? null

  const benefitPayPlatform = toValidNumber(row.benefitPayPlatformId) != null
    ? benefitPayPlatformMap.get(Number(row.benefitPayPlatformId))
    : null
  result.benefitPayPlatform = benefitPayPlatform
    ? {
        id: benefitPayPlatform.id,
        code: benefitPayPlatform.code,
        name: benefitPayPlatform.name,
        icon: benefitPayPlatform.icon,
        sortOrder: benefitPayPlatform.sortOrder,
      }
    : null

  const benefitUsagePlatform = toValidNumber(row.benefitUsagePlatformId) != null
    ? benefitUsagePlatformMap.get(Number(row.benefitUsagePlatformId))
    : null
  result.benefitUsagePlatform = benefitUsagePlatform
    ? {
        id: benefitUsagePlatform.id,
        code: benefitUsagePlatform.code,
        name: benefitUsagePlatform.name,
        icon: benefitUsagePlatform.icon,
        remark: benefitUsagePlatform.remark,
      }
    : null

  const activityCategory = toValidNumber(row.activityCategoryId) != null
    ? activityCategoryMap.get(Number(row.activityCategoryId))
    : null
  result.activityCategory = activityCategory
    ? {
        id: activityCategory.id,
        code: activityCategory.code,
        name: activityCategory.name,
        icon: activityCategory.icon,
      }
    : null

  const adminUser = row.adminUserId != null ? adminUserMap.get(Number(row.adminUserId)) : null
  if (adminUser) {
    result.publisher = (adminUser.displayName || '').trim() || (adminUser.username || '').trim() || (row.publisher || '')
    result.publisherAvatar = adminUser.avatar ?? null
  }
  else {
    result.publisherAvatar = null
  }
  // 发布时间用 updated_at（行最近一次更新即为最近发布点；前端 dayjs 解析 ISO 字符串）
  result.publishTime = row.updatedAt
    ? new Date(row.updatedAt).toISOString()
    : null
  result.likedByCurrentUser = likedTemplateIds?.has(Number(row.id)) ?? false
  result.tiers = normalizeTiers(row.tiers)
  result.linkedCoupons = buildLinkedCouponsDto(row.linkedCoupons, couponCategoryMap)
  return result
}

function buildLinkedCouponsDto(
  raw: unknown,
  couponCategoryMap: Map<number, CouponCategoryRow>,
): Array<{
  couponId: number
  name: string
  logoUrl: string | null
  purchasePrice: number | null
  sku: string | null
  actualValue: number | null
}> {
  if (!Array.isArray(raw))
    return []
  return raw
    .map((item: any) => {
      const couponId = Number(item?.couponId)
      if (!Number.isFinite(couponId) || couponId <= 0)
        return null
      const cat = couponCategoryMap.get(couponId)
      if (!cat)
        return null
      return {
        couponId: cat.id,
        name: cat.name,
        logoUrl: cat.logoUrl,
        purchasePrice: toNumberOrNull(item.purchasePrice),
        sku: item.sku ?? null,
        actualValue: toNumberOrNull(item.actualValue),
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
}

// ---------- 银行卡匹配 ----------

function resolveRequiredCardType(row: TaskTemplateRow, cardTemplate: BankCardTemplateRow | null): 'CREDIT' | 'DEBIT' {
  const raw = (row.bankCardType || cardTemplate?.cardType || '').trim().toUpperCase()
  if (raw === 'DEBIT')
    return 'DEBIT'
  return 'CREDIT'
}

function resolveRequiredRegionCode(row: TaskTemplateRow): string | null {
  const code = (row.regionCode || '').trim()
  if (!code || isNationwideRegionCode(code))
    return null
  return code
}

function resolveRequiredRegionText(
  row: TaskTemplateRow,
  regionMap: Map<string, RegionRow>,
  provincePlanSingleCityMap: Map<string, string[]>,
): string | null {
  const code = resolveRequiredRegionCode(row)
  if (!code)
    return null
  const raw = buildRegionDisplayText(row.regionCode, row.regionMatchStrategy, regionMap, provincePlanSingleCityMap)
    .replace(/地区活动$/g, '')
    .replace(/活动$/g, '')
    .replace(/全国$/g, '全国')
    .trim()
  if (raw)
    return raw
  return (regionMap.get(code)?.regionName || '').trim() || null
}

function resolveRequiredOrganizationIds(
  row: TaskTemplateRow,
  cardTemplate: BankCardTemplateRow | null,
  orgContext: CardOrganizationContext,
): string[] {
  const sources: string[] = []
  if (typeof row.cardOrganizations === 'string' && row.cardOrganizations.trim().length > 0) {
    sources.push(row.cardOrganizations.trim())
  }
  if (sources.length === 0 && cardTemplate?.cardOrganization) {
    sources.push(String(cardTemplate.cardOrganization).trim())
  }

  const ids: string[] = []
  sources.forEach((source) => {
    splitOrganizationSource(source).forEach((token) => {
      const hit = resolveOrganizationTokenToId(token, orgContext)
      if (hit)
        ids.push(hit)
    })
  })
  return Array.from(new Set(ids))
}

function resolveRequiredOrganizationLogos(requiredOrganizationIds: string[], orgContext: CardOrganizationContext): string[] {
  const logos: string[] = []
  requiredOrganizationIds.forEach((orgId) => {
    const org = orgContext.orgById.get(orgId)
    if (!org)
      return
    const memberIds = parseCsv(org.memberOrgIds)
    if (memberIds.length > 1) {
      memberIds.forEach((id) => {
        const memberLogo = (orgContext.orgById.get(id)?.logo || '').trim()
        if (memberLogo)
          logos.push(memberLogo)
      })
      return
    }
    const ownLogo = (org.logo || '').trim()
    if (ownLogo)
      logos.push(ownLogo)
  })
  return Array.from(new Set(logos))
}

function isCardOrganizationMatched(
  card: BankCardRow,
  requiredOrganizationIds: string[],
  orgContext: CardOrganizationContext,
): boolean {
  if (requiredOrganizationIds.length === 0)
    return true
  const cardIds = resolveCardOrganizationIds(card.cardOrganization, orgContext)
  if (cardIds.length === 0)
    return false
  return cardIds.some(id => requiredOrganizationIds.includes(id))
}

/** 用户卡里优先挑「与卡模板同 templateId / 同行同名同类型」的那张 */
function resolveUserBankCardByTemplate(
  cardTemplate: BankCardTemplateRow | null,
  bankCards: BankCardRow[],
  orgContext?: CardOrganizationContext,
): BankCardRow | null {
  if (!cardTemplate)
    return null

  const templateId = Number(cardTemplate.id)
  const byTemplateId = bankCards.find(card => Number(card.templateId) === templateId)
  if (byTemplateId)
    return byTemplateId

  const templateBankId = (cardTemplate.bankId || '').trim()
  const templateCardName = (cardTemplate.cardName || '').trim()
  const templateCardType = (cardTemplate.cardType || '').trim().toUpperCase()
  const templateCardOrg = (cardTemplate.cardOrganization || '').trim().toUpperCase()

  return (
    bankCards.find((card) => {
      if (templateBankId && (card.bankId || '').trim() !== templateBankId)
        return false
      if (templateCardName && (card.cardName || '').trim() !== templateCardName)
        return false
      if (templateCardType && (card.cardType || '').trim().toUpperCase() !== templateCardType)
        return false
      if (templateCardOrg) {
        if (!orgContext) {
          if ((card.cardOrganization || '').trim().toUpperCase() !== templateCardOrg)
            return false
        }
        else {
          const templateOrgIds = resolveCardOrganizationIds(templateCardOrg, orgContext)
          if (templateOrgIds.length > 0) {
            const cardOrgIds = resolveCardOrganizationIds(card.cardOrganization, orgContext)
            if (!cardOrgIds.some(id => templateOrgIds.includes(id)))
              return false
          }
        }
      }
      return true
    }) ?? null
  )
}

function resolveMatchedCards(
  row: TaskTemplateRow,
  bankCards: BankCardRow[],
  resolvedBankId: number | null,
  regionMap: Map<string, RegionRow>,
): BankCardRow[] {
  return bankCards.filter((card) => {
    const cardBankId = toValidNumber(card.bankId)
    if (resolvedBankId != null && cardBankId !== resolvedBankId)
      return false
    return isRegionMatched(row.regionCode, row.regionMatchStrategy, card.regionCode, regionMap)
  })
}

function buildBankCardMatch(
  row: TaskTemplateRow,
  cardTemplate: BankCardTemplateRow | null,
  bankCards: BankCardRow[],
  resolvedBankId: number | null,
  regionMap: Map<string, RegionRow>,
  provincePlanSingleCityMap: Map<string, string[]>,
  orgContext: CardOrganizationContext,
): BankCardMatchResult {
  const requiredCardType = resolveRequiredCardType(row, cardTemplate)
  const requiredCardLabel = requiredCardType === 'DEBIT' ? '借记' : '信用'
  const requiredOrganizationIds = resolveRequiredOrganizationIds(row, cardTemplate, orgContext)
  const requiredOrganizationLogos = resolveRequiredOrganizationLogos(requiredOrganizationIds, orgContext)
  const requiredRegionCode = resolveRequiredRegionCode(row)
  const requiredRegionText = resolveRequiredRegionText(row, regionMap, provincePlanSingleCityMap)

  const cardsByBankAndType = bankCards.filter((card) => {
    const cardBankId = toValidNumber(card.bankId)
    const cardType = (card.cardType || '').trim().toUpperCase()
    if (resolvedBankId != null && cardBankId !== resolvedBankId)
      return false
    return cardType === requiredCardType
  })

  if (cardsByBankAndType.length === 0) {
    return {
      status: BANK_CARD_MATCH_STATUS.MISSING_BANK_CARD_TYPE,
      message: `您缺少该行的${requiredCardLabel}卡`,
      matchedCardId: null,
      matchedCardLastFour: null,
      requiredCardType,
      requiredOrganizationIds,
      requiredOrganizationLogos,
      requiredRegionCode,
      requiredRegionText,
      actions: buildMissingCardActions(row, resolvedBankId, requiredCardType, requiredOrganizationIds),
    }
  }

  const cardsByRegion = cardsByBankAndType.filter(card =>
    isRegionMatched(row.regionCode, row.regionMatchStrategy, card.regionCode, regionMap),
  )
  if (cardsByRegion.length === 0) {
    const regionLabel = requiredRegionText || '该'
    return {
      status: BANK_CARD_MATCH_STATUS.MISSING_REGION,
      message: `您缺少【${regionLabel}】地区的卡片`,
      matchedCardId: null,
      matchedCardLastFour: null,
      requiredCardType,
      requiredOrganizationIds,
      requiredOrganizationLogos,
      requiredRegionCode,
      requiredRegionText,
      actions: [],
    }
  }

  const cardsByOrganization = requiredOrganizationIds.length > 0
    ? cardsByRegion.filter(card => isCardOrganizationMatched(card, requiredOrganizationIds, orgContext))
    : cardsByRegion
  if (cardsByOrganization.length === 0) {
    return {
      status: BANK_CARD_MATCH_STATUS.MISSING_CARD_ORGANIZATION,
      message: `您缺少相应卡组织的${requiredCardLabel}卡`,
      matchedCardId: null,
      matchedCardLastFour: null,
      requiredCardType,
      requiredOrganizationIds,
      requiredOrganizationLogos,
      requiredRegionCode,
      requiredRegionText,
      actions: buildMissingCardActions(row, resolvedBankId, requiredCardType, requiredOrganizationIds),
    }
  }

  const preferredCard
    = resolveUserBankCardByTemplate(cardTemplate, cardsByOrganization, orgContext) ?? cardsByOrganization[0]
  return {
    status: BANK_CARD_MATCH_STATUS.MATCHED,
    message: preferredCard?.cardLastFour ? `你已有相匹配的卡片（尾号${preferredCard.cardLastFour}）` : '可参与',
    matchedCardId: preferredCard ? String(preferredCard.id) : null,
    matchedCardLastFour: preferredCard?.cardLastFour ?? null,
    requiredCardType,
    requiredOrganizationIds,
    requiredOrganizationLogos,
    requiredRegionCode,
    requiredRegionText,
    actions: [],
  }
}

function buildMissingCardActions(
  row: TaskTemplateRow,
  resolvedBankId: number | null,
  requiredCardType: 'CREDIT' | 'DEBIT',
  requiredOrganizationIds: string[],
): BankCardMatchAction[] {
  const bankId = resolvedBankId ?? toValidNumber(row.bankId)
  const basePayload = {
    bankId: bankId != null ? String(bankId) : null,
    requiredCardType,
    requiredOrganizationIds,
  }
  const applyUrl = row.ruleSource?.linkUrl || null
  return [
    {
      type: BANK_CARD_MATCH_ACTION.ADD_CARD,
      text: '添加卡片',
      payload: {
        ...basePayload,
      },
    },
    {
      type: BANK_CARD_MATCH_ACTION.APPLY_CARD,
      text: '去办卡',
      payload: {
        ...basePayload,
        applyUrl,
      },
    },
  ]
}
