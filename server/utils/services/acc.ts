// 记账域服务：记账成员/账本/分类/交易（移植自旧 how-api AccService，去类化）
// 旧 TypeORM 关联查询以 drizzle 显式 join 等价实现；VO 字段/中文报错保持与旧系统一致
import { and, asc, count, desc, eq, gte, lte, or } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { accCategory, accLedger, accTransaction, accUser } from '~/server/database/schema/acc.ts'
import { bank, bankCard, benefitPayPlatform } from '~/server/database/schema/plaza.ts'
import { Defaults } from '~/server/utils/defaults.ts'

type AccCategoryRow = typeof accCategory.$inferSelect
type AccLedgerRow = typeof accLedger.$inferSelect

/** 交易行 + 关联分类（等价旧 TypeORM leftJoinAndSelect('t.category') 的结构） */
export interface TxnWithCategory {
  txn: typeof accTransaction.$inferSelect
  category: AccCategoryRow | null
}

/** 记账成员 VO（旧 GET/PUT /acc/users 返回结构） */
export interface AccUserVO {
  id: number
  username: string
  avatar: string | null
}

/** 获取当前用户的记账成员（一个都没有时自动补默认成员） */
export async function getAccUsers(userId: number): Promise<AccUserVO[]> {
  await ensureDefaultAccUser(userId)
  const rows = await db.select().from(accUser).where(eq(accUser.userId, userId)).orderBy(asc(accUser.id))
  return rows.map(u => ({ id: u.id, username: u.username, avatar: u.avatar }))
}

/** 按月查询记账记录；月份边界与旧系统一致（服务器本地时区的自然月） */
export async function getTransactionsByMonth(
  userId: number,
  ledgerId: number,
  year: number,
  month: number,
): Promise<Record<string, unknown>[]> {
  await assertLedgerOwner(ledgerId, userId)

  const start = new Date(year, month - 1, 1, 0, 0, 0, 0).getTime()
  const end = new Date(year, month, 0, 23, 59, 59, 999).getTime()
  const rows = await db.select({ txn: accTransaction, category: accCategory })
    .from(accTransaction)
    .leftJoin(accCategory, eq(accCategory.id, accTransaction.categoryId))
    .where(and(
      eq(accTransaction.ledgerId, ledgerId),
      gte(accTransaction.transactionDate, start),
      lte(accTransaction.transactionDate, end),
    ))
    .orderBy(desc(accTransaction.transactionDate))
  return Promise.all(rows.map(r => parseTransactionAsync(r)))
}

/** 创建记账记录入参 */
export interface CreateTransactionInput {
  ledgerId: number
  categoryId: number
  type: 'INCOME' | 'EXPENSE'
  amount: number
  account?: string
  bankId?: string
  bankCardId?: number
  benefitPayPlatformId?: number
  sourceTaskId?: number
  relatedIncomeId?: number
  showInList?: number
  transactionDate?: number
  remark?: string
  accUserId?: number
}

/** 创建记账记录 */
export async function createTransaction(userId: number, data: CreateTransactionInput): Promise<Record<string, unknown>> {
  await assertLedgerOwner(data.ledgerId, userId)
  if (data.accUserId != null) {
    await assertAccUserOwner(data.accUserId, userId)
  }
  if (data.amount == null) {
    throw new Error('金额不能为空')
  }

  const now = Date.now()
  const [inserted] = await db.insert(accTransaction).values({
    ledgerId: data.ledgerId,
    categoryId: data.categoryId,
    type: data.type,
    amount: String(data.amount),
    account: data.account ?? null,
    bankId: data.bankId ?? null,
    bankCardId: data.bankCardId ?? null,
    benefitPayPlatformId: data.benefitPayPlatformId != null ? Number(data.benefitPayPlatformId) : null,
    sourceTaskId: data.sourceTaskId != null ? Number(data.sourceTaskId) : null,
    relatedIncomeId: data.relatedIncomeId != null ? Number(data.relatedIncomeId) : null,
    // 默认 1（独立显示）；新建关联支付时前端会显式传 0 表示合并
    showInList: data.showInList != null ? Number(data.showInList) : 1,
    transactionDate: data.transactionDate ?? Date.now(),
    remark: data.remark ?? null,
    accUserId: data.accUserId ?? null,
    createdAt: now,
    updatedAt: now,
  }).$returningId()

  const created = await findTransactionWithCategory(Number(inserted.id))
  if (!created) {
    throw new Error('记录不存在')
  }
  return parseTransactionAsync(created)
}

/**
 * 更新记账记录入参。
 * 注意：沿用旧系统「字段是否出现在对象里」的语义（'accUserId' in data）区分
 * 「清空可空字段」与「不修改」，路由层必须按旧 controller 的方式构造该对象。
 */
export interface UpdateTransactionInput {
  categoryId?: number
  type?: 'INCOME' | 'EXPENSE'
  amount?: number
  account?: string
  bankId?: string
  bankCardId?: number
  benefitPayPlatformId?: number
  sourceTaskId?: number | null
  relatedIncomeId?: number | null
  showInList?: number
  transactionDate?: number
  remark?: string
  accUserId?: number | null
}

/** 更新记账记录 */
export async function updateTransaction(userId: number, id: number, data: UpdateTransactionInput): Promise<Record<string, unknown>> {
  const txn = await findOwnedTransaction(id, userId)
  if (!txn) {
    throw new Error('记录不存在')
  }

  if ('accUserId' in data && data.accUserId != null) {
    await assertAccUserOwner(data.accUserId, userId)
  }

  const patch: Partial<typeof accTransaction.$inferInsert> = { updatedAt: Date.now() }
  if (data.categoryId != null)
    patch.categoryId = data.categoryId
  if (data.type != null)
    patch.type = data.type
  if (data.amount != null)
    patch.amount = String(data.amount)
  if (data.account !== undefined)
    patch.account = data.account ?? null
  if (data.bankId !== undefined)
    patch.bankId = data.bankId ?? null
  if (data.bankCardId !== undefined)
    patch.bankCardId = data.bankCardId ?? null
  if (data.benefitPayPlatformId !== undefined)
    patch.benefitPayPlatformId = data.benefitPayPlatformId != null ? Number(data.benefitPayPlatformId) : null
  if ('sourceTaskId' in data)
    patch.sourceTaskId = data.sourceTaskId != null ? Number(data.sourceTaskId) : null
  if ('relatedIncomeId' in data)
    patch.relatedIncomeId = data.relatedIncomeId != null ? Number(data.relatedIncomeId) : null
  if (data.showInList != null)
    patch.showInList = Number(data.showInList)
  if (data.transactionDate != null)
    patch.transactionDate = data.transactionDate
  if (data.remark !== undefined)
    patch.remark = data.remark ?? null
  if ('accUserId' in data)
    patch.accUserId = data.accUserId ?? null

  await db.update(accTransaction).set(patch).where(eq(accTransaction.id, txn.txn.id))

  const updated = await findTransactionWithCategory(id)
  if (!updated) {
    throw new Error('记录不存在')
  }
  return parseTransactionAsync(updated)
}

/** 删除记账记录（同时解除关联：以此收入为关联对象的成本支出，清除其 relatedIncomeId） */
export async function deleteTransaction(userId: number, id: number): Promise<null> {
  const txn = await findOwnedTransaction(id, userId)
  if (!txn) {
    throw new Error('记录不存在')
  }

  // 旧系统 query builder 批量清关联，不触碰 updated_at，保持一致
  await db.update(accTransaction).set({ relatedIncomeId: null }).where(eq(accTransaction.relatedIncomeId, id))
  await db.delete(accTransaction).where(eq(accTransaction.id, txn.txn.id))
  return null
}

/** 按 id 查单条记账记录（含分类信息与关联对象 enrichment） */
export async function getTransactionById(userId: number, id: number): Promise<Record<string, unknown>> {
  const txn = await findOwnedTransaction(id, userId)
  if (!txn) {
    throw new Error('记录不存在')
  }
  return parseTransactionAsync(txn)
}

/**
 * 交易 → API VO：联动查询优惠平台/银行/记账成员/银行卡后四位。
 * 字段与顺序与旧系统 parseTransactionAsync 完全一致（含恒为 null 的占位字段语义）。
 */
export async function parseTransactionAsync(txn: TxnWithCategory): Promise<Record<string, unknown>> {
  let benefitPlatformName: string | null = null
  let benefitPayPlatformIcon: string | null = null
  if (txn.txn.benefitPayPlatformId != null) {
    const [platform] = await db.select().from(benefitPayPlatform).where(eq(benefitPayPlatform.id, txn.txn.benefitPayPlatformId)).limit(1)
    benefitPlatformName = platform?.name ?? null
    benefitPayPlatformIcon = platform?.icon ?? null
  }

  let bankIconUrl: string | null = null
  let bankThemeColor: string | null = null
  let bankName: string | null = null
  if (txn.txn.bankId != null) {
    const bankIdNum = Number.parseInt(txn.txn.bankId, 10)
    if (!Number.isNaN(bankIdNum)) {
      const [b] = await db.select().from(bank).where(eq(bank.id, bankIdNum)).limit(1)
      bankName = b?.name ?? null
      bankIconUrl = b?.logo ?? null
      bankThemeColor = b?.themeColor ?? null
    }
  }

  let accUserAvatar: string | null = null
  let accUserUsername: string | null = null
  if (txn.txn.accUserId != null) {
    const [u] = await db.select().from(accUser).where(eq(accUser.id, txn.txn.accUserId)).limit(1)
    accUserAvatar = u?.avatar ?? null
    accUserUsername = u?.username ?? null
  }

  let bankCardLastFour: string | null = null
  if (txn.txn.bankCardId != null) {
    const [card] = await db.select().from(bankCard).where(eq(bankCard.id, txn.txn.bankCardId)).limit(1)
    bankCardLastFour = card?.cardLastFour ?? null
  }

  return {
    id: txn.txn.id,
    ledgerId: txn.txn.ledgerId,
    categoryId: txn.txn.categoryId,
    categoryName: txn.category?.name ?? null,
    categoryIcon: txn.category?.icon ?? null,
    type: txn.txn.type,
    amount: Number(txn.txn.amount),
    account: txn.txn.account,
    bankName,
    bankId: txn.txn.bankId,
    bankCardId: txn.txn.bankCardId,
    bankCardLastFour,
    benefitPayPlatformId: txn.txn.benefitPayPlatformId ?? null,
    sourceTaskId: txn.txn.sourceTaskId ?? null,
    benefitPlatformName,
    benefitPayPlatformIcon,
    bankIconUrl,
    bankThemeColor,
    accUserId: txn.txn.accUserId ?? null,
    accUserAvatar,
    accUserUsername,
    relatedIncomeId: txn.txn.relatedIncomeId ?? null,
    showInList: txn.txn.showInList ?? 1,
    transactionDate: Number(txn.txn.transactionDate),
    remark: txn.txn.remark,
    createdAt: Number(txn.txn.createdAt),
    updatedAt: Number(txn.txn.updatedAt),
  }
}

/** 分类 → API VO（isSystem/isVisible 序列化为 boolean） */
export function parseCategory(cat: AccCategoryRow): Record<string, unknown> {
  return {
    id: cat.id,
    userId: cat.userId,
    type: cat.type,
    name: cat.name,
    icon: cat.icon,
    sortOrder: cat.sortOrder,
    isSystem: cat.isSystem === 1,
    isVisible: cat.isVisible === 1,
  }
}

/** 获取分类：系统内置 + 当前用户自建，按 sort_order、id 升序 */
export async function getCategories(userId: number): Promise<Record<string, unknown>[]> {
  const rows = await db.select().from(accCategory).where(and(
    eq(accCategory.isVisible, 1),
    // 系统分类（is_system=1，userId 为 NULL）+ 当前用户自建分类
    or(
      eq(accCategory.isSystem, 1),
      and(eq(accCategory.isSystem, 0), eq(accCategory.userId, userId)),
    ),
  )).orderBy(asc(accCategory.sortOrder), asc(accCategory.id))
  return rows.map(parseCategory)
}

/** 创建自定义分类 */
export async function createCategory(data: {
  userId: number
  type: 'INCOME' | 'EXPENSE'
  name: string
  icon?: string
  sortOrder?: number
}): Promise<Record<string, unknown>> {
  const [inserted] = await db.insert(accCategory).values({
    userId: data.userId,
    type: data.type,
    name: data.name,
    icon: data.icon ?? null,
    sortOrder: data.sortOrder ?? 0,
    isSystem: 0,
    isVisible: 1,
    createdAt: Date.now(),
  }).$returningId()

  const [row] = await db.select().from(accCategory).where(eq(accCategory.id, Number(inserted.id))).limit(1)
  return parseCategory(row!)
}

/** 账本 → API VO */
export function parseLedger(l: AccLedgerRow): Record<string, unknown> {
  return {
    id: l.id,
    userId: l.userId,
    name: l.name,
    description: l.description,
    icon: l.icon,
    currency: l.currency,
    isDefault: l.isDefault === 1,
    createdAt: Number(l.createdAt),
    updatedAt: Number(l.updatedAt),
  }
}

/** 获取当前用户的账本：默认账本在前，其余按创建时间升序 */
export async function getLedgers(userId: number): Promise<Record<string, unknown>[]> {
  const rows = await db.select().from(accLedger).where(eq(accLedger.userId, userId)).orderBy(desc(accLedger.isDefault), asc(accLedger.createdAt))
  return rows.map(parseLedger)
}

/** 创建账本；isDefault=1 时先把该用户其它默认账本清掉 */
export async function createLedger(data: {
  userId: number
  name: string
  description?: string
  icon?: string
  currency?: string
  isDefault?: number
}): Promise<Record<string, unknown>> {
  if (data.isDefault === 1) {
    await db.update(accLedger).set({ isDefault: 0 }).where(and(eq(accLedger.userId, data.userId), eq(accLedger.isDefault, 1)))
  }

  const now = Date.now()
  const [inserted] = await db.insert(accLedger).values({
    userId: data.userId,
    name: data.name,
    description: data.description ?? null,
    icon: data.icon ?? null,
    currency: data.currency ?? 'CNY',
    isDefault: data.isDefault ?? 0,
    createdAt: now,
    updatedAt: now,
  }).$returningId()

  const [row] = await db.select().from(accLedger).where(eq(accLedger.id, Number(inserted.id))).limit(1)
  return parseLedger(row!)
}

/** 新用户初始化：默认记账成员「财务总监」+ 默认 CNY 账本「默认账本」，返回账本 id */
export async function initForNewUser(userId: number): Promise<{ ledgerId: number }> {
  const now = Date.now()
  await db.insert(accUser).values({
    userId,
    username: Defaults.accUser.username,
    avatar: Defaults.accUser.avatar,
    createdAt: now,
    updatedAt: now,
  })

  const ledger = await createLedger({
    userId,
    name: Defaults.ledger.name,
    icon: Defaults.ledger.icon,
    currency: 'CNY',
    isDefault: 1,
  })
  return { ledgerId: Number(ledger.id) }
}

/** 更新记账成员（用户名/头像）；不存在时按旧系统报「记账账号不存在」 */
export async function updateAccUser(userId: number, id: number, data: { username?: string, avatar?: string | null }): Promise<AccUserVO> {
  const [row] = await db.select().from(accUser).where(and(eq(accUser.id, id), eq(accUser.userId, userId))).limit(1)
  if (!row) {
    throw new Error('记账账号不存在')
  }

  const patch: Partial<typeof accUser.$inferInsert> = { updatedAt: Date.now() }
  if (data.username != null)
    patch.username = data.username
  if ('avatar' in data)
    patch.avatar = data.avatar ?? null
  await db.update(accUser).set(patch).where(eq(accUser.id, row.id))

  const [updated] = await db.select().from(accUser).where(eq(accUser.id, row.id)).limit(1)
  return { id: updated.id, username: updated.username, avatar: updated.avatar }
}

// ---------- 内部工具 ----------

/** 无任何记账成员时补插默认成员（与旧 ensureDefaultAccUser 一致） */
async function ensureDefaultAccUser(userId: number): Promise<void> {
  const [row] = await db.select({ c: count() }).from(accUser).where(eq(accUser.userId, userId))
  if (Number(row?.c ?? 0) > 0)
    return

  const now = Date.now()
  await db.insert(accUser).values({
    userId,
    username: Defaults.accUser.username,
    avatar: Defaults.accUser.avatar,
    createdAt: now,
    updatedAt: now,
  })
}

/** 校验账本归属，否则报「无权访问该账本」 */
async function assertLedgerOwner(ledgerId: number, userId: number): Promise<AccLedgerRow> {
  const [ledger] = await db.select().from(accLedger).where(and(eq(accLedger.id, ledgerId), eq(accLedger.userId, userId))).limit(1)
  if (!ledger) {
    throw new Error('无权访问该账本')
  }
  return ledger
}

/** 校验记账成员归属，否则报「无权使用该记账成员」 */
async function assertAccUserOwner(accUserId: number, userId: number): Promise<void> {
  const [row] = await db.select({ id: accUser.id }).from(accUser).where(and(eq(accUser.id, accUserId), eq(accUser.userId, userId))).limit(1)
  if (!row) {
    throw new Error('无权使用该记账成员')
  }
}

/** 按交易 id + 账本归属查交易（inner join 账本校验 user，left join 分类） */
async function findOwnedTransaction(id: number, userId: number): Promise<TxnWithCategory | null> {
  const [row] = await db.select({ txn: accTransaction, category: accCategory })
    .from(accTransaction)
    .innerJoin(accLedger, eq(accLedger.id, accTransaction.ledgerId))
    .leftJoin(accCategory, eq(accCategory.id, accTransaction.categoryId))
    .where(and(eq(accTransaction.id, id), eq(accLedger.userId, userId)))
    .limit(1)
  return row ?? null
}

/** 仅按 id 查交易 + 分类（创建后回读用，不再校验归属——创建前已 assert 过） */
async function findTransactionWithCategory(id: number): Promise<TxnWithCategory | null> {
  const [row] = await db.select({ txn: accTransaction, category: accCategory })
    .from(accTransaction)
    .leftJoin(accCategory, eq(accCategory.id, accTransaction.categoryId))
    .where(eq(accTransaction.id, id))
    .limit(1)
  return row ?? null
}
