// 用户银行卡服务：创建/更新/删除、排序、账单日还款规则、卡组织与地区 VO 装配
// 逐行对应旧 how-api src/service/bank_card.ts（TypeORM → drizzle），业务语义与错误文案保持一致
import { and, asc, count, eq, inArray, min, sql } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { bankCard, bankCardTemplate, cardOrganization, region } from '~/server/database/schema/plaza.ts'

type BankCardRow = typeof bankCard.$inferSelect
type CardOrganizationRow = typeof cardOrganization.$inferSelect
type TemplateRow = typeof bankCardTemplate.$inferSelect

export interface BankCardCreateDto {
  bankId: string
  regionCode: string
  cardType: string
  cardOrganization: string
  cardLastFour: string
  creditLimit?: number | null
  cardLevel?: string | null
  templateId?: number | null
  cardName?: string | null
  remark?: string | null
  cover?: string | null
  annualFeeInfo?: {
    feeType: string
    rigidAmount?: number | null
    waiverMethod?: string | null
    waiverValue?: number | null
  } | null
  feeCollectionDate?: { month: number, day: number } | null
  statementDay?: number | null
  repaymentRuleType?: 'FIXED_DAY' | 'AFTER_STATEMENT_DAYS' | null
  repaymentDay?: number | null
  repaymentOffsetDays?: number | null
  maxInterestFreeDays?: number | null
  currency?: string | null
  expiry?: string | null
}

export interface BankCardVo {
  id: number
  userId: number
  bankId: string
  regionCode: string
  regionName: string | null
  cardType: string
  cardOrganization: string
  cardOrganizationName: string | null
  cardLastFour: string
  creditLimit: number | null
  cardLevel: string | null
  templateId: number | null
  cardName: string | null
  remark: string | null
  cover: string | null
  annualFeeType: string | null
  rigidFeeAmount: number | null
  waiverMethod: string | null
  waiverValue: number | null
  feeMonth: number | null
  feeDay: number | null
  statementDay: number | null
  repaymentRuleType: string | null
  repaymentDay: number | null
  repaymentOffsetDays: number | null
  maxInterestFreeDays: number | null
  currency: string
  expiry: string | null
  createdAt: number
  updatedAt: number | null
  sortOrder: number | null
}

export async function createBankCard(userId: number, data: BankCardCreateDto): Promise<BankCardVo> {
  validateP0Fields(data)
  const cardOrganization = await validateCardOrganization(data.cardOrganization, data.cardType)
  const defaultTemplate = await resolveDefaultTemplate(data)
  const templateId = defaultTemplate?.id ?? data.templateId ?? null

  const now = Date.now()
  const [inserted] = await db.insert(bankCard).values({
    userId,
    bankId: data.bankId,
    cardType: data.cardType,
    cardOrganization: String(cardOrganization.id),
    regionCode: (data.regionCode || '').trim(),
    cardLastFour: data.cardLastFour,
    creditLimit: data.creditLimit ?? null,
    annualFeeType: data.annualFeeInfo?.feeType ?? null,
    rigidFeeAmount: data.annualFeeInfo?.rigidAmount ?? null,
    waiverMethod: data.annualFeeInfo?.waiverMethod ?? null,
    waiverValue: data.annualFeeInfo?.waiverValue ?? null,
    feeMonth: data.feeCollectionDate?.month ?? null,
    feeDay: data.feeCollectionDate?.day ?? null,
    statementDay: data.statementDay ?? null,
    repaymentRuleType: data.repaymentRuleType ?? null,
    repaymentDay: data.repaymentDay ?? null,
    repaymentOffsetDays: data.repaymentOffsetDays ?? null,
    maxInterestFreeDays: data.maxInterestFreeDays ?? null,
    currency: (data.currency || 'CNY').trim().toUpperCase() || 'CNY',
    expiry: data.expiry?.trim() || null,
    cardLevel: data.cardLevel ?? null,
    templateId,
    cardName: data.cardName ?? defaultTemplate?.cardName ?? null,
    remark: data.remark?.trim() || null,
    cover: data.cover ?? defaultTemplate?.cover ?? null,
    sortOrder: await resolveInitialSortOrder(userId),
    createdAt: now,
    updatedAt: now,
  }).$returningId()
  const [saved] = await db.select().from(bankCard).where(eq(bankCard.id, Number(inserted.id))).limit(1)

  // 关联模板计数 +1
  if (templateId) {
    await db.update(bankCardTemplate)
      .set({ relatedCount: sql`${bankCardTemplate.relatedCount} + 1` })
      .where(eq(bankCardTemplate.id, templateId))
  }

  return toVo(saved)
}

export async function getBankCards(userId: number): Promise<BankCardVo[]> {
  const list = await db.select().from(bankCard).where(eq(bankCard.userId, userId))
  const sortedList = [...list].sort(compareCardsForDisplay)
  const [cardOrganizationMap, regionMap] = await Promise.all([
    buildCardOrganizationMap(sortedList.map(c => c.cardOrganization)),
    buildRegionMap(sortedList.map(c => c.regionCode)),
  ])
  return sortedList.map(c => toVoWithMaps(c, cardOrganizationMap, regionMap))
}

export async function getBankCardById(userId: number, id: string): Promise<BankCardVo | null> {
  const numId = Number.parseInt(id, 10)
  if (Number.isNaN(numId))
    return null

  const [card] = await db.select().from(bankCard).where(and(eq(bankCard.id, numId), eq(bankCard.userId, userId))).limit(1)
  if (!card)
    return null
  return toVo(card)
}

export async function updateBankCard(userId: number, id: string, data: BankCardCreateDto): Promise<BankCardVo | null> {
  const numId = Number.parseInt(id, 10)
  if (Number.isNaN(numId))
    return null

  const [card] = await db.select().from(bankCard).where(and(eq(bankCard.id, numId), eq(bankCard.userId, userId))).limit(1)
  if (!card)
    return null

  validateP0Fields(data)
  const cardOrganization = await validateCardOrganization(data.cardOrganization, data.cardType)
  const defaultTemplate = await resolveDefaultTemplate(data)
  const templateId = defaultTemplate?.id ?? data.templateId ?? null

  await db.update(bankCard).set({
    bankId: data.bankId,
    cardType: data.cardType,
    cardOrganization: String(cardOrganization.id),
    regionCode: (data.regionCode || '').trim(),
    cardLastFour: data.cardLastFour,
    creditLimit: data.creditLimit ?? null,
    annualFeeType: data.annualFeeInfo?.feeType ?? null,
    rigidFeeAmount: data.annualFeeInfo?.rigidAmount ?? null,
    waiverMethod: data.annualFeeInfo?.waiverMethod ?? null,
    waiverValue: data.annualFeeInfo?.waiverValue ?? null,
    feeMonth: data.feeCollectionDate?.month ?? null,
    feeDay: data.feeCollectionDate?.day ?? null,
    statementDay: data.statementDay ?? null,
    repaymentRuleType: data.repaymentRuleType ?? null,
    repaymentDay: data.repaymentDay ?? null,
    repaymentOffsetDays: data.repaymentOffsetDays ?? null,
    maxInterestFreeDays: data.maxInterestFreeDays ?? null,
    currency: (data.currency || 'CNY').trim().toUpperCase() || 'CNY',
    expiry: data.expiry?.trim() || null,
    cardLevel: data.cardLevel ?? null,
    templateId,
    cardName: data.cardName ?? defaultTemplate?.cardName ?? null,
    remark: data.remark?.trim() || null,
    cover: data.cover ?? defaultTemplate?.cover ?? null,
    updatedAt: Date.now(),
  }).where(eq(bankCard.id, card.id))

  const [saved] = await db.select().from(bankCard).where(eq(bankCard.id, card.id)).limit(1)
  return toVo(saved)
}

export async function updateBillingRule(
  userId: number,
  id: string,
  data: {
    statementDay: number
    repaymentRuleType: 'FIXED_DAY' | 'AFTER_STATEMENT_DAYS'
    repaymentDay?: number | null
    repaymentOffsetDays?: number | null
  },
): Promise<BankCardVo | null> {
  const numId = Number.parseInt(id, 10)
  if (Number.isNaN(numId))
    return null

  const [card] = await db.select().from(bankCard).where(and(eq(bankCard.id, numId), eq(bankCard.userId, userId))).limit(1)
  if (!card)
    return null

  const rule = data.repaymentRuleType
  if (rule !== 'FIXED_DAY' && rule !== 'AFTER_STATEMENT_DAYS') {
    throw new Error('repaymentRuleType 非法')
  }
  if (!Number.isInteger(data.statementDay) || data.statementDay < 1 || data.statementDay > 31) {
    throw new Error('statementDay 必须在 1-31 之间')
  }
  if (rule === 'FIXED_DAY') {
    const d = data.repaymentDay ?? null
    if (d == null || !Number.isInteger(d) || d < 1 || d > 31) {
      throw new Error('repaymentDay 必须在 1-31 之间')
    }
  }
  if (rule === 'AFTER_STATEMENT_DAYS') {
    const d = data.repaymentOffsetDays ?? null
    if (d == null || !Number.isInteger(d) || d < 1 || d > 60) {
      throw new Error('repaymentOffsetDays 必须在 1-60 之间')
    }
  }

  await db.update(bankCard).set({
    statementDay: data.statementDay,
    repaymentRuleType: rule,
    repaymentDay: rule === 'FIXED_DAY' ? (data.repaymentDay ?? null) : null,
    repaymentOffsetDays: rule === 'AFTER_STATEMENT_DAYS' ? (data.repaymentOffsetDays ?? null) : null,
    updatedAt: Date.now(),
  }).where(eq(bankCard.id, card.id))

  const [saved] = await db.select().from(bankCard).where(eq(bankCard.id, card.id)).limit(1)
  return toVo(saved)
}

export async function reorderBankCards(userId: number, orderedIds: number[]): Promise<void> {
  const normalizedIds = Array.from(
    new Set(
      (orderedIds ?? [])
        .map(id => Number(id))
        .filter(id => Number.isInteger(id) && id > 0),
    ),
  )
  if (normalizedIds.length === 0) {
    throw new Error('orderedIds 不能为空')
  }

  const cards = await db.select().from(bankCard).where(eq(bankCard.userId, userId))
  if (cards.length !== normalizedIds.length) {
    throw new Error('排序列表不完整，请刷新后重试')
  }

  const idSet = new Set(cards.map(card => card.id))
  if (normalizedIds.some(id => !idSet.has(id))) {
    throw new Error('排序列表包含无效银行卡')
  }

  const orderMap = new Map<number, number>()
  normalizedIds.forEach((id, index) => orderMap.set(id, index + 1))
  const now = Date.now()

  await db.transaction(async (tx) => {
    for (const card of cards) {
      await tx.update(bankCard).set({
        sortOrder: orderMap.get(card.id) ?? null,
        updatedAt: now,
      }).where(eq(bankCard.id, card.id))
    }
  })
}

export async function deleteBankCard(userId: number, id: string): Promise<boolean> {
  const numId = Number.parseInt(id, 10)
  if (Number.isNaN(numId))
    return false

  const result = await db.delete(bankCard).where(and(eq(bankCard.id, numId), eq(bankCard.userId, userId)))
  return (result[0]?.affectedRows ?? 0) > 0
}

// ---------- VO 装配 ----------

async function toVo(card: BankCardRow): Promise<BankCardVo> {
  const [cardOrganizationMap, regionMap] = await Promise.all([
    buildCardOrganizationMap([card.cardOrganization]),
    buildRegionMap([card.regionCode]),
  ])
  return toVoWithMaps(card, cardOrganizationMap, regionMap)
}

function toVoWithMaps(
  card: BankCardRow,
  cardOrganizationMap: Map<string, CardOrganizationRow>,
  regionMap: Map<string, string | null>,
): BankCardVo {
  const cardOrganization = cardOrganizationMap.get(card.cardOrganization)

  return {
    id: card.id,
    userId: card.userId,
    bankId: card.bankId,
    regionCode: card.regionCode,
    regionName: regionMap.get(card.regionCode) ?? null,
    cardType: card.cardType,
    cardOrganization: card.cardOrganization,
    cardOrganizationName: cardOrganization?.name ?? null,
    cardLastFour: card.cardLastFour,
    creditLimit: card.creditLimit ?? null,
    cardLevel: card.cardLevel ?? null,
    templateId: card.templateId ?? null,
    cardName: card.cardName ?? null,
    remark: card.remark ?? null,
    cover: card.cover ?? null,
    annualFeeType: card.annualFeeType ?? null,
    rigidFeeAmount: card.rigidFeeAmount ?? null,
    waiverMethod: card.waiverMethod ?? null,
    waiverValue: card.waiverValue ?? null,
    feeMonth: card.feeMonth ?? null,
    feeDay: card.feeDay ?? null,
    statementDay: card.statementDay ?? null,
    repaymentRuleType: card.repaymentRuleType ?? null,
    repaymentDay: card.repaymentDay ?? null,
    repaymentOffsetDays: card.repaymentOffsetDays ?? null,
    maxInterestFreeDays: card.maxInterestFreeDays ?? null,
    currency: card.currency || 'CNY',
    expiry: card.expiry ?? null,
    createdAt: Number(card.createdAt),
    updatedAt: card.updatedAt != null ? Number(card.updatedAt) : null,
    sortOrder: card.sortOrder != null ? Number(card.sortOrder) : null,
  }
}

/** 展示排序：有 sortOrder 的在前（升序），其余按创建时间倒序、同刻按 id 升序 */
function compareCardsForDisplay(a: BankCardRow, b: BankCardRow): number {
  const aHasSort = a.sortOrder != null && Number.isFinite(Number(a.sortOrder))
  const bHasSort = b.sortOrder != null && Number.isFinite(Number(b.sortOrder))
  if (aHasSort && bHasSort && Number(a.sortOrder) !== Number(b.sortOrder)) {
    return Number(a.sortOrder) - Number(b.sortOrder)
  }
  if (aHasSort !== bHasSort) {
    return aHasSort ? -1 : 1
  }
  const createdDiff = Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0)
  if (createdDiff !== 0)
    return createdDiff
  return Number(a.id) - Number(b.id)
}

/** 新卡初始 sortOrder：已有手动排序时排在最前（最小值 - 1），否则无排序值 */
async function resolveInitialSortOrder(userId: number): Promise<number | null> {
  const [raw] = await db.select({
    minSort: min(bankCard.sortOrder),
    sortedCount: count(bankCard.sortOrder),
  }).from(bankCard).where(eq(bankCard.userId, userId))

  const sortedCount = Number(raw?.sortedCount ?? 0)
  if (!Number.isFinite(sortedCount) || sortedCount <= 0)
    return null

  const minSort = Number(raw?.minSort ?? 0)
  if (!Number.isFinite(minSort))
    return null
  return minSort - 1
}

async function resolveDefaultTemplate(data: BankCardCreateDto): Promise<TemplateRow | null> {
  const explicitTemplateId = Number(data.templateId)
  if (Number.isInteger(explicitTemplateId) && explicitTemplateId > 0) {
    const [row] = await db.select().from(bankCardTemplate).where(eq(bankCardTemplate.id, explicitTemplateId)).limit(1)
    return row ?? null
  }

  const cardType = (data.cardType || '').trim().toUpperCase()
  if (cardType !== 'DEBIT')
    return null

  const bankId = (data.bankId || '').trim()
  if (!bankId)
    return null

  // 借记卡默认模板：how2hao 自建数据，取 id 最小的一条
  const [row] = await db.select().from(bankCardTemplate).where(and(
    eq(bankCardTemplate.bankId, bankId),
    eq(bankCardTemplate.cardType, 'DEBIT'),
    eq(bankCardTemplate.dataSource, 'how2hao'),
  )).orderBy(asc(bankCardTemplate.id)).limit(1)
  return row ?? null
}

function parseCsv(raw: string | null | undefined): string[] {
  if (!raw || typeof raw !== 'string')
    return []
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

async function buildCardOrganizationMap(cardOrganizationIds: string[]): Promise<Map<string, CardOrganizationRow>> {
  const normalizedIds = Array.from(
    new Set(
      cardOrganizationIds
        .map(id => Number.parseInt((id || '').trim(), 10))
        .filter(id => Number.isFinite(id) && id > 0),
    ),
  )
  if (normalizedIds.length === 0)
    return new Map()

  const rows = await db.select().from(cardOrganization).where(inArray(cardOrganization.id, normalizedIds))

  const map = new Map<string, CardOrganizationRow>()
  rows.forEach(row => map.set(String(row.id), row))
  return map
}

async function buildRegionMap(regionCodes: string[]): Promise<Map<string, string | null>> {
  const codes = Array.from(new Set(regionCodes.filter(c => c && c.trim().length > 0)))
  if (codes.length === 0)
    return new Map()

  const rows = await db.select().from(region).where(inArray(region.regionCode, codes))
  const map = new Map<string, string | null>()
  rows.forEach(row => map.set(row.regionCode, row.regionName))
  return map
}

/** 卡组织校验：存在、启用、按是否组合组织校验卡片类型 */
async function validateCardOrganization(cardOrganizationId: string, cardType: string): Promise<CardOrganizationRow> {
  const normalizedCardType = (cardType || '').trim().toUpperCase()
  if (normalizedCardType !== 'CREDIT' && normalizedCardType !== 'DEBIT') {
    throw new Error('cardType 仅支持 CREDIT 或 DEBIT')
  }

  const parsedId = Number.parseInt((cardOrganizationId || '').trim(), 10)
  if (!Number.isFinite(parsedId) || parsedId <= 0) {
    throw new Error('cardOrganization 必须为有效的组织 ID')
  }

  const [row] = await db.select().from(cardOrganization).where(eq(cardOrganization.id, parsedId)).limit(1)
  if (!row) {
    throw new Error('cardOrganization 不存在')
  }

  const status = (row.status || 'ENABLED').trim().toUpperCase() || 'ENABLED'
  if (status !== 'ENABLED') {
    throw new Error('当前卡组织不可用，请重新选择')
  }

  const isComposite = parseCsv(row.memberOrgIds).length > 0
  if (isComposite) {
    if (normalizedCardType !== 'CREDIT') {
      throw new Error('组合卡组织仅支持信用卡')
    }
    return row
  }

  const supportedCardTypes = parseCsv(row.supportedCardTypes).map(item => item.toUpperCase())
  if (supportedCardTypes.length === 0 || !supportedCardTypes.includes(normalizedCardType)) {
    throw new Error('当前卡组织不支持该卡片类型')
  }
  return row
}

function validateP0Fields(data: BankCardCreateDto): void {
  const inRange = (v: number | null | undefined, minV: number, maxV: number) =>
    v == null || (Number.isInteger(v) && v >= minV && v <= maxV)

  if ((data.regionCode || '').trim().length === 0) {
    throw new Error('regionCode 不能为空')
  }

  if (data.remark != null && data.remark.trim().length > 40) {
    throw new Error('备注名最多 40 字符')
  }

  if (!inRange(data.statementDay, 1, 31)) {
    throw new Error('statementDay 必须在 1-31 之间')
  }
  if (!inRange(data.repaymentDay, 1, 31)) {
    throw new Error('repaymentDay 必须在 1-31 之间')
  }
  if (!inRange(data.repaymentOffsetDays, 1, 60)) {
    throw new Error('repaymentOffsetDays 必须在 1-60 之间')
  }
  if (!inRange(data.maxInterestFreeDays, 1, 60)) {
    throw new Error('maxInterestFreeDays 必须在 1-60 之间')
  }

  if (data.cardType === 'CREDIT' && (data.creditLimit == null || data.creditLimit < 0)) {
    throw new Error('信用卡额度为必填项')
  }

  if (data.currency != null && data.currency.trim().length === 0) {
    throw new Error('currency 不能为空字符串')
  }

  if (data.expiry != null && data.expiry !== '') {
    const expiry = data.expiry.trim()
    if (!/^\d{6}$/.test(expiry)) {
      throw new Error('expiry 必须为 YYYYMM 格式')
    }
    const year = Number(expiry.substring(0, 4))
    const month = Number(expiry.substring(4, 6))
    if (month < 1 || month > 12) {
      throw new Error('expiry 月份必须在 01-12 之间')
    }
    const now = new Date()
    const currentYm = now.getFullYear() * 100 + (now.getMonth() + 1)
    const valueYm = year * 100 + month
    if (valueYm < currentYm) {
      throw new Error('expiry 不能早于当前月份')
    }
  }

  const rule = data.repaymentRuleType
  if (rule != null) {
    if (rule !== 'FIXED_DAY' && rule !== 'AFTER_STATEMENT_DAYS') {
      throw new Error('repaymentRuleType 非法')
    }
    if (rule === 'FIXED_DAY' && data.repaymentOffsetDays != null) {
      throw new Error('FIXED_DAY 不可填写 repaymentOffsetDays')
    }
    if (rule === 'AFTER_STATEMENT_DAYS' && data.repaymentDay != null) {
      throw new Error('AFTER_STATEMENT_DAYS 不可填写 repaymentDay')
    }
  }
}
