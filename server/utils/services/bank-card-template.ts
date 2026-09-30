import type { SQL } from 'drizzle-orm'
import type { IPageData } from '~/server/utils/types.ts'
// 银行卡模板服务：模板列表、信用卡模板检索（热门/分页/按 id）、银行分组、封面同步
// 逐行对应旧 how-api src/service/bank_card_template.ts（TypeORM → drizzle），业务语义与错误文案保持一致
import { and, asc, count, desc, eq, gt, inArray, isNull, like, or, sql } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { bank, bankCard, bankCardTemplate, cardLevel, cardOrganization } from '~/server/database/schema/plaza.ts'

type TemplateRow = typeof bankCardTemplate.$inferSelect

export interface BankCardTemplateBankGroupVo {
  bankId: string
  bankName: string
  bankLogo: string | null
  count: number
}

export interface BankCardTemplateListItemVo {
  id: number
  bankId: string
  bankName: string | null
  bankLogo: string | null
  cardName: string
  alias: string | null
  cardLevel: string | null
  cardLevelName: string | null
  cardOrganization: string
  cardOrganizationName: string
  cover: string | null
  tags: string | null
  dataSource: string
}

/** 信用卡模板检索的固定列（与旧 createCreditCardTemplateQb 一致） */
interface TemplateRawRow {
  id: number
  bankId: string
  cardName: string
  alias: string | null
  cardLevel: string | null
  cardOrganization: string
  cover: string | null
  tags: string | null
  dataSource: string
}

function creditCardTemplateColumns() {
  return {
    id: bankCardTemplate.id,
    bankId: bankCardTemplate.bankId,
    cardName: bankCardTemplate.cardName,
    alias: bankCardTemplate.alias,
    cardLevel: bankCardTemplate.cardLevel,
    cardOrganization: bankCardTemplate.cardOrganization,
    cover: bankCardTemplate.cover,
    tags: bankCardTemplate.tags,
    dataSource: bankCardTemplate.dataSource,
  }
}

function buildCreditCardConditions(opts: { bankId?: string, keyword?: string, dataSource?: string, ids?: number[] }): SQL {
  const conds: SQL[] = [eq(bankCardTemplate.cardType, '1')]
  if (opts.bankId && opts.bankId.trim()) {
    conds.push(eq(bankCardTemplate.bankId, opts.bankId.trim()))
  }
  if (opts.keyword && opts.keyword.trim()) {
    const kw = `%${opts.keyword.trim()}%`
    conds.push(or(like(bankCardTemplate.cardName, kw), like(bankCardTemplate.alias, kw))!)
  }
  if (opts.dataSource && opts.dataSource.trim()) {
    conds.push(eq(bankCardTemplate.dataSource, opts.dataSource.trim()))
  }
  if (opts.ids && opts.ids.length > 0) {
    conds.push(inArray(bankCardTemplate.id, opts.ids))
  }
  return and(...conds)!
}

export async function getBankCardTemplates(bankId?: string): Promise<TemplateRow[]> {
  const where = bankId ? eq(bankCardTemplate.bankId, bankId) : undefined
  return db.select().from(bankCardTemplate).where(where).orderBy(asc(bankCardTemplate.id))
}

/** 信用卡模板按银行分组（card_type='1'，仅统计可见银行） */
export async function getCreditCardTemplateBankGroups(dataSource = 'flyert'): Promise<BankCardTemplateBankGroupVo[]> {
  const source = (dataSource || '').trim() || 'flyert'
  const rows = await db.select({
    bankId: bankCardTemplate.bankId,
    bankName: bank.name,
    bankLogo: bank.logo,
    count: count(),
  })
    .from(bankCardTemplate)
    .leftJoin(bank, eq(bank.id, sql`CAST(${bankCardTemplate.bankId} AS UNSIGNED)`))
    .where(and(
      eq(bankCardTemplate.cardType, '1'),
      eq(bankCardTemplate.dataSource, source),
      eq(bank.isVisible, 1),
    ))
    .groupBy(bankCardTemplate.bankId, bank.name, bank.logo)
    .orderBy(desc(sql`count(1)`), asc(sql`COALESCE(${bank.name}, ${bankCardTemplate.bankId})`))

  return rows.map(row => ({
    bankId: String(row.bankId),
    // 左连接可能取不到银行名 → 回退到 bank_id（与旧 COALESCE 一致）
    bankName: row.bankName ?? String(row.bankId),
    bankLogo: row.bankLogo ?? null,
    count: Number(row.count) || 0,
  }))
}

export async function getHotCreditCardTemplates(dataSource = 'flyert'): Promise<BankCardTemplateListItemVo[]> {
  const source = (dataSource || '').trim() || 'flyert'

  const rows = await db.select({ id: bankCardTemplate.id })
    .from(bankCardTemplate)
    .where(and(
      eq(bankCardTemplate.cardType, '1'),
      eq(bankCardTemplate.dataSource, source),
      gt(bankCardTemplate.relatedCount, 0),
    ))
    .orderBy(desc(bankCardTemplate.relatedCount))
    .limit(10)

  const ids = rows.map(r => Number(r.id)).filter(id => Number.isFinite(id) && id > 0)
  if (ids.length === 0)
    return []
  return getCreditCardTemplatesByIds(ids, source)
}

export async function getCreditCardTemplatesByBankPaged(
  bankId: string,
  page = 1,
  pageSize = 30,
  dataSource = 'flyert',
): Promise<IPageData<BankCardTemplateListItemVo>> {
  const safeBankId = (bankId || '').trim()
  if (!safeBankId) {
    return {
      list: [],
      total: 0,
      page: 1,
      pageSize: 30,
      totalPages: 0,
    }
  }

  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1
  const safePageSize = Number.isFinite(pageSize)
    ? Math.min(100, Math.max(1, Math.floor(pageSize)))
    : 30
  const source = (dataSource || '').trim() || 'flyert'

  const where = and(
    eq(bankCardTemplate.cardType, '1'),
    eq(bankCardTemplate.bankId, safeBankId),
    eq(bankCardTemplate.dataSource, source),
  )

  const [totalRow] = await db.select({ c: count() }).from(bankCardTemplate).where(where)
  const total = Number(totalRow?.c ?? 0)

  const rows = await db.select(creditCardTemplateColumns()).from(bankCardTemplate).where(where).orderBy(asc(bankCardTemplate.id)).limit(safePageSize).offset((safePage - 1) * safePageSize)

  const list = await parseRawRows(rows)
  const totalPages = total > 0 ? Math.ceil(total / safePageSize) : 0

  return {
    list,
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages,
  }
}

export async function getCreditCardTemplatesByIds(ids: number[], dataSource?: string): Promise<BankCardTemplateListItemVo[]> {
  const uniqIds = Array.from(
    new Set(
      (ids || [])
        .map(id => Number(id))
        .filter(id => Number.isFinite(id) && id > 0),
    ),
  )

  if (uniqIds.length === 0)
    return []

  const where = buildCreditCardConditions({ ids: uniqIds, dataSource })
  const rows = await db.select(creditCardTemplateColumns()).from(bankCardTemplate).where(where).orderBy(asc(bankCardTemplate.id))
  const parsed = await parseRawRows(rows)
  const parsedMap = new Map<number, BankCardTemplateListItemVo>(parsed.map(item => [item.id, item]))

  // 按调用方传入的 id 顺序返回（缺失的 id 直接跳过）
  return uniqIds
    .map(id => parsedMap.get(id) ?? null)
    .filter((item): item is BankCardTemplateListItemVo => item != null)
}

export async function getCreditCardTemplates(
  bankId?: string,
  keyword?: string,
  dataSource?: string,
): Promise<BankCardTemplateListItemVo[]> {
  const where = buildCreditCardConditions({ bankId, keyword, dataSource })
  const rows = await db.select(creditCardTemplateColumns()).from(bankCardTemplate).where(where).orderBy(asc(bankCardTemplate.id))
  return parseRawRows(rows)
}

/**
 * 装配模板列表 VO：卡等级 / 卡组织（支持逗号分隔多值，映射不到时保留原值）
 * 与银行（name/logo）联查。
 */
async function parseRawRows(rows: TemplateRawRow[]): Promise<BankCardTemplateListItemVo[]> {
  if (rows.length === 0)
    return []

  const bankIdNums = Array.from(
    new Set(
      rows
        .map(r => Number(r.bankId))
        .filter(n => Number.isFinite(n) && n > 0),
    ),
  )

  const [levelRows, orgRows, bankRows] = await Promise.all([
    db.select({ id: cardLevel.id, name: cardLevel.name }).from(cardLevel),
    db.select({ id: cardOrganization.id, name: cardOrganization.name }).from(cardOrganization),
    bankIdNums.length > 0
      ? db.select({ id: bank.id, name: bank.name, logo: bank.logo }).from(bank).where(inArray(bank.id, bankIdNums))
      : Promise.resolve([] as Array<{ id: number, name: string, logo: string | null }>),
  ])

  const levelMap = new Map<string, string>()
  for (const row of levelRows) {
    levelMap.set(String(row.id), row.name)
  }

  const orgMap = new Map<string, string>()
  for (const row of orgRows) {
    orgMap.set(String(row.id), row.name)
  }

  const bankMap = new Map<string, { name: string, logo: string | null }>()
  for (const row of bankRows) {
    bankMap.set(String(row.id), { name: row.name, logo: row.logo ?? null })
  }

  return rows.map((item) => {
    const rawLevel = item.cardLevel?.trim() || null
    const cardLevelName = rawLevel
      ? rawLevel.split(',').map(part => levelMap.get(part.trim()) ?? part.trim()).join('+')
      : null

    const rawOrg = item.cardOrganization?.trim() || ''
    const cardOrganizationName = rawOrg
      ? rawOrg.split(',').map(part => orgMap.get(part.trim()) ?? part.trim()).join('+')
      : ''

    const bankIdStr = String(item.bankId)
    const bankInfo = bankMap.get(bankIdStr)

    return {
      id: Number(item.id),
      bankId: bankIdStr,
      bankName: bankInfo?.name ?? null,
      bankLogo: bankInfo?.logo ?? null,
      cardName: item.cardName,
      alias: item.alias ?? null,
      cardLevel: rawLevel,
      cardLevelName,
      cardOrganization: rawOrg,
      cardOrganizationName,
      cover: item.cover ?? null,
      tags: item.tags ?? null,
      dataSource: item.dataSource,
    }
  })
}

/**
 * 设置模板封面并同步到所有关联的用户银行卡（仅更新 cover 为 NULL 的卡）。
 * 返回 { updatedCards } 表示本次同步的卡片数量。
 */
export async function setCover(templateId: number, cover: string): Promise<{ updatedCards: number }> {
  const [template] = await db.select().from(bankCardTemplate).where(eq(bankCardTemplate.id, templateId)).limit(1)
  if (!template)
    throw new Error(`模板 ${templateId} 不存在`)

  await db.update(bankCardTemplate).set({
    cover,
    updatedAt: Date.now(),
  }).where(eq(bankCardTemplate.id, templateId))

  const result = await db.update(bankCard).set({ cover }).where(and(
    eq(bankCard.templateId, templateId),
    isNull(bankCard.cover),
  ))

  return { updatedCards: result[0]?.affectedRows ?? 0 }
}
