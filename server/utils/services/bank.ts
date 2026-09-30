// 银行服务：银行列表（可见）、热门银行、分页搜索、按 code upsert
// 逐行对应旧 how-api src/service/bank.ts（TypeORM → drizzle），业务语义与错误文案保持一致
import { and, asc, count, desc, eq, inArray, like, or, sql } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { bank } from '~/server/database/schema/plaza.ts'

export type BankRow = typeof bank.$inferSelect

interface HotBankRule {
  codeIncludes: string[]
  nameIncludes: string[]
}

const HOT_BANK_RULES: HotBankRule[] = [
  { codeIncludes: ['icbc'], nameIncludes: ['工商银行'] },
  { codeIncludes: ['abc'], nameIncludes: ['农业银行'] },
  { codeIncludes: ['ccb'], nameIncludes: ['建设银行'] },
  { codeIncludes: ['boc'], nameIncludes: ['中国银行'] },
  { codeIncludes: ['cmb'], nameIncludes: ['招商银行'] },
  { codeIncludes: ['bocomm', 'bocom'], nameIncludes: ['交通银行'] },
  { codeIncludes: ['psbc'], nameIncludes: ['邮政储蓄银行', '邮储银行'] },
  { codeIncludes: ['cib'], nameIncludes: ['兴业银行'] },
  { codeIncludes: ['citic'], nameIncludes: ['中信银行'] },
  { codeIncludes: ['spdb', 'spd'], nameIncludes: ['浦发银行'] },
]

/** /bank 接口的固定序列化字段（与旧 controller 一致） */
export function serializeBank(b: BankRow) {
  return {
    id: b.id,
    name: b.name,
    shortName: b.shortName ?? null,
    code: b.code ?? null,
    logo: b.logo ?? null,
    themeColor: b.themeColor ?? null,
    pinyinIndex: b.pinyinIndex ?? null,
    isUnifiedBill: !!b.isUnifiedBill,
    bankType: b.bankType ?? null,
  }
}

/** 账单合一银行：仅招商银行（name 或 code=CMB 命中） */
function isUnifiedBillBank(name?: string | null, code?: string | null): boolean {
  const normalizedName = (name || '').trim()
  const normalizedCode = (code || '').trim().toUpperCase()
  return normalizedName.includes('招商银行') || normalizedCode === 'CMB'
}

export async function getBanks(bankType?: string): Promise<BankRow[]> {
  const trimmedType = (bankType || '').trim()
  const where = trimmedType
    ? and(eq(bank.isVisible, 1), eq(bank.bankType, trimmedType))
    : eq(bank.isVisible, 1)
  const list = await db.select().from(bank).where(where).orderBy(desc(bank.createdAt))

  // 存量数据兜底：命中「账单合一」规则的银行顺手回写 is_unified_bill（与旧系统一致）
  const needDefaultUnified = list.filter(item => !item.isUnifiedBill && isUnifiedBillBank(item.name, item.code))
  for (const item of needDefaultUnified) {
    item.isUnifiedBill = 1
    await db.update(bank).set({ isUnifiedBill: 1, updatedAt: new Date() }).where(eq(bank.id, item.id))
  }
  return list
}

export async function getHotBanks(): Promise<BankRow[]> {
  const all = await db.select().from(bank).where(eq(bank.isVisible, 1))
  const chosen: BankRow[] = []
  for (const rule of HOT_BANK_RULES) {
    const matched = all.find((item) => {
      const code = (item.code || '').trim().toLowerCase()
      const name = (item.name || '').trim()
      return rule.codeIncludes.some(c => code.includes(c)) || rule.nameIncludes.some(n => name.includes(n))
    })
    if (matched && !chosen.some(b => b.id === matched.id)) {
      chosen.push(matched)
    }
  }
  return chosen
}

export async function getBanksPaged(keyword: string, page: number, pageSize: number): Promise<{ items: BankRow[], total: number }> {
  const kw = (keyword || '').trim()
  const likeKw = `%${kw}%`
  const where = kw
    ? and(
        eq(bank.isVisible, 1),
        or(like(bank.name, likeKw), like(bank.code, likeKw), like(bank.pinyinIndex, likeKw)),
      )
    : eq(bank.isVisible, 1)

  const [totalRow] = await db.select({ c: count() }).from(bank).where(where)
  const items = await db.select().from(bank).where(where).orderBy(asc(sql`COALESCE(${bank.pinyinIndex}, ${bank.name})`)).limit(pageSize).offset((page - 1) * pageSize)

  return { items, total: Number(totalRow?.c ?? 0) }
}

export async function getBankById(id: string): Promise<BankRow | null> {
  const numId = Number.parseInt(id, 10)
  if (Number.isNaN(numId))
    return null
  const [row] = await db.select().from(bank).where(eq(bank.id, numId)).limit(1)
  return row ?? null
}

export async function getBanksByIds(ids: number[]): Promise<BankRow[]> {
  const uniq = Array.from(new Set(ids.filter(id => Number.isFinite(id) && id > 0)))
  if (uniq.length === 0)
    return []
  return db.select().from(bank).where(inArray(bank.id, uniq))
}

/**
 * 按 code 存在则更新 name、logo、themeColor，否则新建
 */
export async function upsertByCode(data: {
  name: string
  code: string
  logo: string
  themeColor?: string | null
  isUnifiedBill?: boolean
}): Promise<BankRow> {
  const fallbackUnified = isUnifiedBillBank(data.name, data.code)
  const [existing] = await db.select().from(bank).where(eq(bank.code, data.code)).limit(1)

  if (existing) {
    const isUnifiedBill = data.isUnifiedBill ?? (existing.isUnifiedBill === 1 || fallbackUnified)
    await db.update(bank).set({
      name: data.name,
      logo: data.logo,
      themeColor: data.themeColor ?? null,
      isUnifiedBill: isUnifiedBill ? 1 : 0,
      updatedAt: new Date(),
    }).where(eq(bank.id, existing.id))
    return {
      ...existing,
      name: data.name,
      logo: data.logo,
      themeColor: data.themeColor ?? null,
      isUnifiedBill: isUnifiedBill ? 1 : 0,
    }
  }

  const isUnifiedBill = data.isUnifiedBill ?? fallbackUnified
  const [inserted] = await db.insert(bank).values({
    name: data.name,
    code: data.code,
    logo: data.logo,
    themeColor: data.themeColor ?? null,
    isUnifiedBill: isUnifiedBill ? 1 : 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).$returningId()
  const [row] = await db.select().from(bank).where(eq(bank.id, Number(inserted.id))).limit(1)
  return row!
}
