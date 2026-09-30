import type { IPageData, ITaskMonthData, ITaskMonthSummary, ITaskOccurrenceItem } from '~/server/utils/types.ts'
// 任务服务：任务 CRUD、按月/按日展开循环 occurrence、任务状态、账单还款提醒
// 逐行对应旧 how-api src/service/task.ts（TypeORM → drizzle），业务语义与错误文案保持一致
import { and, count, desc, eq, gte, inArray } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { bankCard, benefitCategory } from '~/server/database/schema/plaza.ts'
import { jobRecurringOccurrence, task, taskRecurring, taskRecurringOccurrence, taskTemplate } from '~/server/database/schema/task.ts'

type TaskRow = typeof task.$inferSelect
type TaskRecurringRow = typeof taskRecurring.$inferSelect
type TaskRecurringOccurrenceRow = typeof taskRecurringOccurrence.$inferSelect

/** getTemplateMap 只取这几列（与旧 select 一致） */
interface TemplateLite {
  id: number
  endDate: number | null
  reminderTime: string | null
  isVisible: number | null
}

// ---------- 纯函数（无 db，供 occurrence 展开与测试复用） ----------

export function normalizeTimestampToMillis(value: unknown): number | null {
  if (value == null || value === '')
    return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function startOfDay(value: number): number {
  const d = new Date(value)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
}

export function endOfDay(value: number): number {
  const d = new Date(value)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 0).getTime()
}

export function getMonthStart(year: number, month: number): number {
  return new Date(year, month - 1, 1, 0, 0, 0, 0).getTime()
}

export function getMonthEnd(year: number, month: number): number {
  return new Date(year, month, 0, 23, 59, 59, 999).getTime()
}

export function getTodayStart(): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
}

export function buildMonthDays(year: number, month: number): Date[] {
  const lastDay = new Date(year, month, 0).getDate()
  const list: Date[] = []
  for (let day = 1; day <= lastDay; day++) {
    list.push(new Date(year, month - 1, day, 0, 0, 0, 0))
  }
  return list
}

export function formatMonthDay(dayStart: number): string {
  const d = new Date(dayStart)
  const year = d.getFullYear()
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${year}-${m}-${day}`
}

/** 循环规则 days 字段是 JSON 数组字符串，解析回 number[]（脏数据返回 []） */
export function parseJsonArray(s: string | null | undefined): number[] {
  if (!s || typeof s !== 'string')
    return []
  try {
    const arr = JSON.parse(s)
    return Array.isArray(arr)
      ? arr.map((x: any) => Number(x)).filter((n: number) => !Number.isNaN(n))
      : []
  }
  catch {
    return []
  }
}

export function stringifyArray(arr: unknown): string | null {
  if (!Array.isArray(arr))
    return null
  return JSON.stringify(arr)
}

/**
 * 计算任务在某月的所有发生日（当天 0 点时间戳）。
 * 循环任务以 recurring 规则为准（date 仅作 ONE_TIME 回退）；时间线排序键比较。
 */
/** 循环规则最小结构（TaskRecurringRow 与测试字面量均满足） */
export interface OccurrenceRuleSource {
  repeatType: string
  daysOfWeek?: string | null
  daysOfMonth?: string | null
  yearlyMonths?: string | null
  yearlyDaysOfMonth?: string | null
  startDate?: number | null
  endDate?: number | null
}

export function getOccurrenceDaysInMonth(
  taskDto: any,
  recurring: OccurrenceRuleSource | null,
  year: number,
  month: number,
  monthStart: number,
  monthEnd: number,
  lastDay: number,
): number[] {
  const source = recurring
    ? {
        repeatType: recurring.repeatType,
        daysOfWeek: parseJsonArray(recurring.daysOfWeek),
        daysOfMonth: parseJsonArray(recurring.daysOfMonth),
        yearlyMonths: parseJsonArray(recurring.yearlyMonths),
        yearlyDaysOfMonth: parseJsonArray(recurring.yearlyDaysOfMonth),
        startDate: recurring.startDate,
        endDate: recurring.endDate,
        date: taskDto.date,
      }
    : taskDto

  const startDate = source.startDate != null ? Number(source.startDate) : null
  const endDate = source.endDate != null ? Number(source.endDate) : null

  const inRange = (dayStart: number) => {
    if (startDate != null && dayStart < startDate)
      return false
    if (endDate != null && dayStart > endDate)
      return false
    return true
  }

  switch (source.repeatType) {
    case 'ONE_TIME': {
      const date = source.date != null ? Number(source.date) : null
      if (date == null)
        return []
      const dayStart = new Date(date).setHours(0, 0, 0, 0)
      if (dayStart >= monthStart && dayStart <= monthEnd && inRange(dayStart)) {
        return [dayStart]
      }
      return []
    }
    case 'DAILY': {
      const out: number[] = []
      for (let d = 1; d <= lastDay; d++) {
        const dayStart = new Date(year, month - 1, d, 0, 0, 0, 0).getTime()
        if (inRange(dayStart))
          out.push(dayStart)
      }
      return out
    }
    case 'WEEKLY': {
      const daysOfWeek = Array.isArray(source.daysOfWeek) ? source.daysOfWeek : []
      const out: number[] = []
      for (let d = 1; d <= lastDay; d++) {
        const dayStart = new Date(year, month - 1, d, 0, 0, 0, 0).getTime()
        const w = new Date(dayStart).getDay()
        const composeDay = w === 0 ? 7 : w
        if (daysOfWeek.length === 0 || daysOfWeek.includes(composeDay)) {
          if (inRange(dayStart))
            out.push(dayStart)
        }
      }
      return out
    }
    case 'MONTHLY': {
      const daysOfMonth = Array.isArray(source.daysOfMonth) ? source.daysOfMonth : []
      const days = daysOfMonth.length > 0 ? daysOfMonth : [1]
      const out: number[] = []
      for (const d of days) {
        if (d < 1 || d > lastDay)
          continue
        const dayStart = new Date(year, month - 1, d, 0, 0, 0, 0).getTime()
        if (inRange(dayStart))
          out.push(dayStart)
      }
      return out
    }
    case 'YEARLY': {
      const yearlyMonths = Array.isArray(source.yearlyMonths) ? source.yearlyMonths : []
      const yearlyDays = Array.isArray(source.yearlyDaysOfMonth) ? source.yearlyDaysOfMonth : []
      if (yearlyMonths.length > 0 && !yearlyMonths.includes(month))
        return []
      const months = yearlyMonths.length > 0 ? yearlyMonths : [month]
      if (!months.includes(month))
        return []
      const days = yearlyDays.length > 0 ? yearlyDays : [1]
      const out: number[] = []
      for (const d of days) {
        if (d < 1 || d > lastDay)
          continue
        const dayStart = new Date(year, month - 1, d, 0, 0, 0, 0).getTime()
        if (inRange(dayStart))
          out.push(dayStart)
      }
      return out
    }
    default:
      return []
  }
}

/** 时间线排序：reminderTime（EXPIRY_REMINDER 用 expireAt 的 HH:mm）升序，EXPIRY_REMINDER 同刻靠后 */
export function compareTasksForTimeline(a: any, b: any): number {
  const timeCompare = getTaskTimelineSortKey(a).localeCompare(getTaskTimelineSortKey(b))
  if (timeCompare !== 0)
    return timeCompare
  const aRank = a?.kind === 'EXPIRY_REMINDER' ? 1 : 0
  const bRank = b?.kind === 'EXPIRY_REMINDER' ? 1 : 0
  return aRank - bRank
}

function getTaskTimelineSortKey(taskDto: any): string {
  if (taskDto?.kind === 'EXPIRY_REMINDER') {
    return formatTimeFromTimestamp(taskDto.expireAt) ?? '23:59'
  }
  return taskDto?.reminderTime || '99:99'
}

function formatTimeFromTimestamp(value: any): string | null {
  const ts = normalizeTimestampToMillis(value)
  if (ts == null)
    return null
  const d = new Date(ts)
  const hour = `${d.getHours()}`.padStart(2, '0')
  const minute = `${d.getMinutes()}`.padStart(2, '0')
  return `${hour}:${minute}`
}

/** 没有 occurrence 记录时：ONE_TIME 完成状态在 task.status，循环任务视为未完成 */
function applyOccurrenceState(taskDto: any, occurrence: TaskRecurringOccurrenceRow | null): any {
  if (!occurrence) {
    if (taskDto.repeatType === 'ONE_TIME') {
      return taskDto
    }
    return {
      ...taskDto,
      isCompleted: false,
      status: 'PENDING',
    }
  }
  return {
    ...taskDto,
    isCompleted: !!occurrence.isCompleted,
    status: occurrence.status || (occurrence.isCompleted ? 'COMPLETED' : 'PENDING'),
  }
}

function toDecimalString(value: unknown): string | null {
  return value == null ? null : String(value)
}

// ---------- DTO → task 表字段映射（保持 TypeORM「undefined=不改列」语义） ----------

function mapDtoToTaskPatch(existing: TaskRow | null, data: any): Partial<typeof task.$inferInsert> {
  const patch: Record<string, unknown> = {}
  const isNewTask = !existing

  if (data.title !== undefined)
    patch.title = data.title
  if (data.description !== undefined)
    patch.description = data.description

  const repeatType = (data.repeatType || 'ONE_TIME').toUpperCase()
  patch.repeatType = repeatType
  const prevKind = existing?.kind ?? null
  const requestedKind = data.kind !== undefined
    ? data.kind
    : prevKind ?? (isNewTask ? 'REMINDER' : null)
  const prevExpireAt = existing?.expireAt ?? null
  const normalizedExpireAt = normalizeTimestampToMillis(data.expireAt)

  if (data.reminderTime !== undefined)
    patch.reminderTime = data.reminderTime
  if (requestedKind === 'EXPIRY_REMINDER') {
    if (normalizedExpireAt != null) {
      patch.expireAt = normalizedExpireAt
    }
    else if (data.expireAt === undefined && data.date === undefined && prevExpireAt != null) {
      patch.expireAt = prevExpireAt
    }
    else {
      const baseAt = normalizeTimestampToMillis(data.date) ?? prevExpireAt ?? Date.now()
      patch.expireAt = endOfDay(baseAt)
    }
  }
  else if (data.expireAt !== undefined || isNewTask) {
    patch.expireAt = null
  }
  if (data.bankId !== undefined)
    patch.bankId = data.bankId
  patch.taskTemplateId = data.taskTemplateId ?? null
  patch.reminderTemplateId = data.reminderTemplateId ?? null
  patch.sourceJobId = data.sourceJobId ?? null
  patch.sourceJobOccurrenceId = data.sourceJobOccurrenceId ?? null
  patch.bankCardType = data.bankCardType ?? null
  patch.bankCardLevel = data.bankCardLevel ?? null
  patch.bankCardId = data.bankCardId != null ? Number(data.bankCardId) : null
  if ('benefitCategoryId' in data) {
    patch.benefitCategoryId = data.benefitCategoryId != null ? Number(data.benefitCategoryId) : null
  }
  patch.minAmount = toDecimalString(data.minAmount ?? null)
  // benefitAmount / benefitDescription 是 ha AddTaskRequest 的字段名，
  // benefitAmountFixed / benefitVoucherDescription 是实体列名，两者互为 fallback
  patch.benefitAmountFixed = toDecimalString(data.benefitAmountFixed ?? data.benefitAmount ?? null)
  patch.benefitAmountMin = toDecimalString(data.benefitAmountMin ?? null)
  patch.benefitAmountMax = toDecimalString(data.benefitAmountMax ?? null)
  patch.benefitVoucherDescription = data.benefitVoucherDescription ?? data.benefitDescription ?? null
  patch.quotaPerCycleText = data.quotaPerCycleText ?? null
  patch.quotaTotalText = data.quotaTotalText ?? null
  patch.benefitPayPlatformId = data.benefitPayPlatformId != null ? Number(data.benefitPayPlatformId) : null
  patch.highPriority = (data.highPriority ?? false) ? 1 : 0

  // kind 字段：dto 显式传 → 直接覆盖（pinTaskTemplate 传 'PIN'）；
  //   未传且新建 → 默认 REMINDER；未传且更新 → 保留原值（防止 update 误把 PIN 重置）
  if (requestedKind != null)
    patch.kind = requestedKind
  // 如果是从模板创建且未传提前提醒值，默认给 2 分钟
  const advanceReminderMinutes = data.advanceReminderMinutes ?? (data.taskTemplateId ? 2 : undefined)
  if (advanceReminderMinutes !== undefined)
    patch.advanceReminderMinutes = advanceReminderMinutes

  if (repeatType === 'ONE_TIME') {
    const mappedExpireAt = patch.expireAt !== undefined ? patch.expireAt : prevExpireAt
    const mappedKind = patch.kind !== undefined ? patch.kind : prevKind
    if (mappedKind === 'EXPIRY_REMINDER' && mappedExpireAt != null) {
      patch.date = startOfDay(Number(mappedExpireAt))
    }
    else if (data.date != null) {
      patch.date = data.date
    }
    // ONE_TIME 任务：status 来自请求，或根据 isCompleted 推导
    const isCompleted = data.isCompleted ?? false
    patch.status = data.status || (isCompleted ? 'COMPLETED' : 'PENDING')
  }
  else {
    // 循环任务：date 存 startDate（便于 getOccurrenceDaysInMonth ONE_TIME 回退），status 固定 PENDING
    const startDate = data.startDate ?? data.date
    if (startDate != null)
      patch.date = startDate
    patch.status = 'PENDING'
  }

  if (data.frequencyControl != null && typeof data.frequencyControl === 'object') {
    patch.frequencyControl = JSON.stringify(data.frequencyControl)
  }
  else if (data.frequencyControl == null) {
    patch.frequencyControl = null
  }
  if (data.cardOrganizations != null && Array.isArray(data.cardOrganizations)) {
    patch.cardOrganizations = JSON.stringify(data.cardOrganizations)
  }
  else if (data.cardOrganizations == null) {
    patch.cardOrganizations = null
  }
  return patch
}

/** EXPIRY_REMINDER 且未指定类目时默认挂「立减金」类目 */
async function applyExpiryReminderDefaults(
  patch: Partial<typeof task.$inferInsert>,
  existing: TaskRow | null,
): Promise<void> {
  const kind = patch.kind !== undefined ? patch.kind : existing?.kind ?? null
  const benefitCategoryId = patch.benefitCategoryId !== undefined
    ? patch.benefitCategoryId
    : existing?.benefitCategoryId ?? null
  if (kind !== 'EXPIRY_REMINDER' || benefitCategoryId != null)
    return
  const [category] = await db.select({ id: benefitCategory.id })
    .from(benefitCategory)
    .where(eq(benefitCategory.name, '立减金'))
    .limit(1)
  patch.benefitCategoryId = category?.id ?? null
}

/** task 与 task_recurring 1:1：非循环任务删除残留规则 */
export async function upsertRecurringRule(taskId: number, data: any): Promise<TaskRecurringRow | null> {
  const repeatType = (data.repeatType || 'ONE_TIME').toUpperCase()
  const isRecurring = repeatType !== 'ONE_TIME'

  const [exists] = await db.select().from(taskRecurring).where(eq(taskRecurring.taskId, taskId)).limit(1)
  if (!isRecurring) {
    if (exists) {
      await db.delete(taskRecurring).where(eq(taskRecurring.id, exists.id))
    }
    return null
  }

  const startDate = data.startDate ?? data.date ?? null
  const endDate = data.endDate ?? null
  const values = {
    taskId,
    repeatType: repeatType as 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY',
    daysOfWeek: stringifyArray(data.daysOfWeek),
    daysOfMonth: stringifyArray(data.daysOfMonth),
    yearlyMonths: stringifyArray(data.yearlyMonths),
    yearlyDaysOfMonth: stringifyArray(data.yearlyDaysOfMonth),
    startDate: startDate == null ? null : Number(startDate),
    endDate: endDate == null ? null : Number(endDate),
    reminderTime: data.reminderTime ?? null,
    createdAt: exists?.createdAt ?? Date.now(),
    updatedAt: new Date(),
  }

  if (exists) {
    await db.update(taskRecurring).set(values).where(eq(taskRecurring.id, exists.id))
    return { ...exists, ...values }
  }
  const [inserted] = await db.insert(taskRecurring).values(values).$returningId()
  return { id: Number(inserted.id), ...values }
}

// ---------- 批量预加载（避免循环内 N 次单查） ----------

async function getTemplateMap(templateIds: Array<number | null | undefined>): Promise<Map<number, TemplateLite>> {
  const ids = Array.from(new Set(templateIds.filter((id): id is number => Number.isFinite(id as number) && Number(id) > 0)))
  if (ids.length === 0)
    return new Map<number, TemplateLite>()
  const rows = await db.select({
    id: taskTemplate.id,
    endDate: taskTemplate.endDate,
    reminderTime: taskTemplate.reminderTime,
    isVisible: taskTemplate.isVisible,
  }).from(taskTemplate).where(inArray(taskTemplate.id, ids))
  return new Map<number, TemplateLite>(rows.map(t => [t.id, t]))
}

async function getRecurringMap(taskIds: number[]): Promise<Map<number, TaskRecurringRow>> {
  const ids = Array.from(new Set(taskIds.filter(id => Number.isFinite(id))))
  if (ids.length === 0)
    return new Map<number, TaskRecurringRow>()
  const rows = await db.select().from(taskRecurring).where(inArray(taskRecurring.taskId, ids))
  return new Map<number, TaskRecurringRow>(rows.map(item => [item.taskId, item]))
}

async function getBankCardMap(userId: number, bankCardIds: number[]): Promise<Map<number, { id: number, cardLastFour: string }>> {
  const ids = Array.from(new Set(bankCardIds.filter(id => Number.isFinite(id))))
  if (ids.length === 0)
    return new Map()
  const rows = await db.select({ id: bankCard.id, cardLastFour: bankCard.cardLastFour })
    .from(bankCard)
    .where(and(inArray(bankCard.id, ids), eq(bankCard.userId, userId)))
  return new Map(rows.map(card => [card.id, card]))
}

async function getSourceJobProgressAmountMap(sourceJobOccurrenceIds: Array<number | null | undefined>): Promise<Map<number, number>> {
  const ids = Array.from(new Set(
    sourceJobOccurrenceIds
      .filter((id): id is number => Number.isFinite(id as number) && Number(id) > 0)
      .map(id => Number(id)),
  ))
  if (ids.length === 0)
    return new Map<number, number>()
  const rows = await db.select({ id: jobRecurringOccurrence.id, progressAmount: jobRecurringOccurrence.progressAmount })
    .from(jobRecurringOccurrence)
    .where(inArray(jobRecurringOccurrence.id, ids))
  return new Map<number, number>(rows.map(row => [row.id, Number(row.progressAmount ?? 0)]))
}

/** 写操作前的归属断言：银行卡不存在或不属于该用户 → 拒绝 */
async function assertBankCardOwnership(userId: number, bankCardId?: number | null): Promise<void> {
  if (bankCardId == null)
    return
  const parsed = Number(bankCardId)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('bankCardId 非法')
  }
  const [card] = await db.select({ id: bankCard.id })
    .from(bankCard)
    .where(and(eq(bankCard.id, parsed), eq(bankCard.userId, userId)))
    .limit(1)
  if (!card) {
    throw new Error('无权使用该银行卡')
  }
}

// ---------- 序列化 ----------

async function parseTaskAsync(
  row: TaskRow,
  recurring: TaskRecurringRow | null,
  bankCardLastFour: string | null = null,
): Promise<any> {
  const sourceJobProgressAmount = row.sourceJobOccurrenceId != null
    ? (await getSourceJobProgressAmountMap([row.sourceJobOccurrenceId])).get(row.sourceJobOccurrenceId) ?? null
    : null
  return parseTask(row, recurring, bankCardLastFour, sourceJobProgressAmount)
}

function parseTask(
  row: TaskRow,
  recurring: TaskRecurringRow | null,
  bankCardLastFour: string | null = null,
  sourceJobProgressAmount: number | null = null,
  template: TemplateLite | null = null,
): any {
  const result: any = { ...row }

  if (recurring) {
    result.repeatType = recurring.repeatType
    result.daysOfWeek = parseJsonArray(recurring.daysOfWeek)
    result.daysOfMonth = parseJsonArray(recurring.daysOfMonth)
    result.yearlyMonths = parseJsonArray(recurring.yearlyMonths)
    result.yearlyDaysOfMonth = parseJsonArray(recurring.yearlyDaysOfMonth)
    result.startDate = recurring.startDate != null ? Number(recurring.startDate) : null
    result.endDate = recurring.endDate != null ? Number(recurring.endDate) : null
    result.reminderTime = recurring.reminderTime || result.reminderTime
  }
  else {
    // ONE_TIME / 无循环记录任务：循环相关字段返回空；endDate 从 task_template 兜底
    result.daysOfWeek = []
    result.daysOfMonth = []
    result.yearlyMonths = []
    result.yearlyDaysOfMonth = []
    result.startDate = null
    result.endDate = template?.endDate != null ? Number(template.endDate) : null
  }

  // isCompleted 由 status 推导（ONE_TIME 任务不再依赖 task.is_completed 列）
  result.isCompleted = result.status === 'COMPLETED'

  if (typeof row.frequencyControl === 'string' && row.frequencyControl) {
    try {
      result.frequencyControl = JSON.parse(row.frequencyControl)
    }
    catch {
      result.frequencyControl = null
    }
  }
  else {
    result.frequencyControl = null
  }

  if (typeof row.cardOrganizations === 'string' && row.cardOrganizations) {
    try {
      result.cardOrganizations = JSON.parse(row.cardOrganizations)
    }
    catch {
      result.cardOrganizations = row.cardOrganizations.split(',').filter(Boolean)
    }
  }
  else {
    result.cardOrganizations = []
  }

  result.benefitPayPlatformId = row.benefitPayPlatformId != null ? Number(row.benefitPayPlatformId) : null

  if (result.date != null)
    result.date = Number(result.date)
  if (result.expireAt != null)
    result.expireAt = Number(result.expireAt)
  if (result.createdAt != null)
    result.createdAt = Number(result.createdAt)
  if (result.minAmount != null)
    result.minAmount = Number(result.minAmount)
  if (result.benefitAmountFixed != null)
    result.benefitAmountFixed = Number(result.benefitAmountFixed)
  if (result.benefitAmountMin != null)
    result.benefitAmountMin = Number(result.benefitAmountMin)
  if (result.benefitAmountMax != null)
    result.benefitAmountMax = Number(result.benefitAmountMax)

  // 关联银行卡尾四位（bank_card.card_last_four）
  result.bankCardLastFour = bankCardLastFour
  result.sourceJobProgressAmount = sourceJobProgressAmount != null ? Number(sourceJobProgressAmount) : null

  return result
}

// ---------- 任务 CRUD ----------

export async function createTask(userId: number, data: any): Promise<any> {
  await assertBankCardOwnership(userId, data.bankCardId)
  const patch = mapDtoToTaskPatch(null, data)
  await applyExpiryReminderDefaults(patch, null)
  const [inserted] = await db.insert(task).values({
    ...patch,
    userId,
    createdAt: data.createdAt ?? Date.now(),
    updatedAt: new Date(),
  } as typeof task.$inferInsert).$returningId()
  const [savedTask] = await db.select().from(task).where(eq(task.id, Number(inserted.id))).limit(1)

  // PIN 类型与 REMINDER 类型独立存在，互不升级（plan: kind='PIN' 不可转 REMINDER）
  // 历史的「Pin → Reminder 自动清理」逻辑已移除

  const recurring = await upsertRecurringRule(savedTask.id, data)
  const bankCardLastFour = savedTask.bankCardId != null
    ? (await getBankCardMap(userId, [savedTask.bankCardId])).get(savedTask.bankCardId)?.cardLastFour ?? null
    : null
  return parseTaskAsync(savedTask, recurring, bankCardLastFour)
}

export async function updateTask(userId: number, id: string, data: any): Promise<any | null> {
  const parsedId = Number.parseInt(id, 10)
  if (!Number.isFinite(parsedId))
    return null
  const [existing] = await db.select().from(task).where(and(eq(task.id, parsedId), eq(task.userId, userId))).limit(1)
  if (!existing)
    return null

  await assertBankCardOwnership(userId, data.bankCardId)
  const patch = mapDtoToTaskPatch(existing, data)
  await applyExpiryReminderDefaults(patch, existing)
  await db.update(task).set({ ...patch, updatedAt: new Date() }).where(eq(task.id, existing.id))
  const [savedTask] = await db.select().from(task).where(eq(task.id, existing.id)).limit(1)

  const recurring = await upsertRecurringRule(savedTask.id, data)
  const bankCardLastFour = savedTask.bankCardId != null
    ? (await getBankCardMap(userId, [savedTask.bankCardId])).get(savedTask.bankCardId)?.cardLastFour ?? null
    : null
  return parseTaskAsync(savedTask, recurring, bankCardLastFour)
}

export async function getTasks(userId: number, page = 1, pageSize = 20): Promise<IPageData<any>> {
  const [totalRow] = await db.select({ c: count() }).from(task).where(eq(task.userId, userId))
  const total = Number(totalRow?.c ?? 0)
  const list = await db.select().from(task).where(eq(task.userId, userId)).orderBy(desc(task.createdAt)).limit(pageSize).offset((page - 1) * pageSize)

  const recurringMap = await getRecurringMap(list.map(item => item.id))
  const bankCardIds = list.map(t => t.bankCardId).filter((id): id is number => id != null)
  const bankCardMap = await getBankCardMap(userId, bankCardIds)
  const sourceJobProgressAmountMap = await getSourceJobProgressAmountMap(list.map(item => item.sourceJobOccurrenceId))
  const templateMap = await getTemplateMap(list.map(t => t.taskTemplateId))

  return {
    list: list.map((t) => {
      const parsed = parseTask(
        t,
        recurringMap.get(t.id) ?? null,
        t.bankCardId != null ? bankCardMap.get(t.bankCardId)?.cardLastFour ?? null : null,
        t.sourceJobOccurrenceId != null ? sourceJobProgressAmountMap.get(t.sourceJobOccurrenceId) : null,
        t.taskTemplateId != null ? templateMap.get(t.taskTemplateId) ?? null : null,
      )
      return parsed
    }),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  }
}

// ---------- 按月 / 按日展开 ----------

export async function getTasksByMonth(userId: number, year: number, month: number, options?: { includePast?: boolean }): Promise<ITaskMonthData> {
  const includePast = options?.includePast === true
  const monthStart = getMonthStart(year, month)
  const monthEnd = getMonthEnd(year, month)
  const lastDay = new Date(year, month, 0).getDate()

  const allTasks = await db.select().from(task).where(eq(task.userId, userId)).orderBy(desc(task.createdAt))
  const recurringMap = await getRecurringMap(allTasks.map(item => item.id))
  const bankCardIds = allTasks.map(t => t.bankCardId).filter((id): id is number => id != null)
  const bankCardMap = await getBankCardMap(userId, bankCardIds)
  const sourceJobProgressAmountMap = await getSourceJobProgressAmountMap(allTasks.map(item => item.sourceJobOccurrenceId))
  const templateMap = await getTemplateMap(allTasks.map(t => t.taskTemplateId))

  const recurringTaskIds = Array.from(recurringMap.keys())
  // 同时包含旧数据格式（task.repeat_type != ONE_TIME 但无 task_recurring 记录）的任务 id
  const allRecurringTaskIds = Array.from(new Set([
    ...recurringTaskIds,
    ...allTasks.filter(t => t.repeatType && t.repeatType !== 'ONE_TIME').map(t => t.id),
  ]))
  const monthDayTimestamps = buildMonthDays(year, month).map(day => day.getTime())
  const occurrenceRows = allRecurringTaskIds.length
    ? await db.select().from(taskRecurringOccurrence).where(and(
        inArray(taskRecurringOccurrence.taskId, allRecurringTaskIds),
        inArray(taskRecurringOccurrence.occurrenceDate, monthDayTimestamps),
      ))
    : []

  const occurrenceMap = new Map<string, TaskRecurringOccurrenceRow>(
    occurrenceRows.map(row => [`${row.taskId}_${Number(row.occurrenceDate)}`, row]),
  )

  const todayStart = getTodayStart()
  const isRequestedCurrentMonth
    = new Date().getFullYear() === year && new Date().getMonth() + 1 === month

  const todayList: ITaskOccurrenceItem[] = []
  const dayToItems = new Map<number, ITaskOccurrenceItem[]>()

  for (const row of allTasks) {
    // PIN 任务跟随模板可见性：模板被隐藏/删除则不出现在日历
    if (row.kind === 'PIN' && row.taskTemplateId != null) {
      const tmpl = templateMap.get(row.taskTemplateId)
      if (!tmpl || !tmpl.isVisible)
        continue
    }
    const recurring = recurringMap.get(row.id) ?? null
    const parsedTask = parseTask(
      row,
      recurring,
      row.bankCardId != null ? bankCardMap.get(row.bankCardId)?.cardLastFour ?? null : null,
      row.sourceJobOccurrenceId != null ? sourceJobProgressAmountMap.get(row.sourceJobOccurrenceId) : null,
      row.taskTemplateId != null ? templateMap.get(row.taskTemplateId) ?? null : null,
    )
    const occurrenceDays = getOccurrenceDaysInMonth(parsedTask, recurring, year, month, monthStart, monthEnd, lastDay)

    for (const dayStart of occurrenceDays) {
      const occurrence = occurrenceMap.get(`${row.id}_${dayStart}`) ?? null
      const taskWithOccurrenceState = applyOccurrenceState(parsedTask, occurrence)
      if (taskWithOccurrenceState.status === 'CANCELLED')
        continue
      const item: ITaskOccurrenceItem = {
        task: taskWithOccurrenceState,
        occurrenceDate: dayStart,
        occurrenceId: occurrence?.id ?? null,
      }

      if (isRequestedCurrentMonth && dayStart === todayStart) {
        todayList.push(item)
      }
      else if (dayStart > todayStart || !isRequestedCurrentMonth || includePast) {
        // includePast=true 时把当前月今天之前的日期也收入 otherDays（日历圆点用）
        const list = dayToItems.get(dayStart) || []
        list.push(item)
        dayToItems.set(dayStart, list)
      }
    }
  }

  const sortedDays = Array.from(dayToItems.keys()).sort((a, b) => a - b)
  const otherDays = sortedDays.map(dayStart => ({
    date: formatMonthDay(dayStart),
    dateTimestamp: dayStart,
    tasks: (dayToItems.get(dayStart) || []).sort(
      (a, b) => compareTasksForTimeline(a.task, b.task),
    ),
  }))

  todayList.sort((a, b) => compareTasksForTimeline(a.task, b.task))

  return { today: todayList, otherDays }
}

/**
 * 摘要模式：只返回 today 详情 + otherDays 的任务总数（不返回 otherDays 详情）
 * 用于首屏快速加载，otherDays 明细由用户展开时再按需请求
 */
export async function getTasksByMonthSummary(userId: number, year: number, month: number): Promise<ITaskMonthSummary> {
  const full = await getTasksByMonth(userId, year, month)
  const otherDaysCount = full.otherDays.reduce((acc, g) => acc + g.tasks.length, 0)
  return { today: full.today, otherDaysCount }
}

/**
 * 按单日返回当天的任务（含循环任务展开成的当日 occurrence）。
 * 返回扁平数组，每个元素是 task DTO + occurrenceDate / occurrenceId 元信息。
 * date 形如 'YYYY-MM-DD'。
 */
export async function getTasksByDate(userId: number, date: string): Promise<any[]> {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match)
    return []
  const year = Number.parseInt(match[1], 10)
  const month = Number.parseInt(match[2], 10)
  const day = Number.parseInt(match[3], 10)
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day))
    return []

  const dayStart = new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
  const monthStart = getMonthStart(year, month)
  const monthEnd = getMonthEnd(year, month)
  const lastDay = new Date(year, month, 0).getDate()

  const allTasks = await db.select().from(task).where(eq(task.userId, userId)).orderBy(desc(task.createdAt))
  const recurringMap = await getRecurringMap(allTasks.map(item => item.id))
  const bankCardIds = allTasks.map(t => t.bankCardId).filter((id): id is number => id != null)
  const bankCardMap = await getBankCardMap(userId, bankCardIds)
  const sourceJobProgressAmountMap = await getSourceJobProgressAmountMap(allTasks.map(item => item.sourceJobOccurrenceId))
  const templateMap = await getTemplateMap(allTasks.map(t => t.taskTemplateId))

  const recurringTaskIds = Array.from(recurringMap.keys())
  const allRecurringTaskIds = Array.from(new Set([
    ...recurringTaskIds,
    ...allTasks.filter(t => t.repeatType && t.repeatType !== 'ONE_TIME').map(t => t.id),
  ]))

  const occurrenceRows = allRecurringTaskIds.length
    ? await db.select().from(taskRecurringOccurrence).where(and(
        inArray(taskRecurringOccurrence.taskId, allRecurringTaskIds),
        eq(taskRecurringOccurrence.occurrenceDate, dayStart),
      ))
    : []
  const occurrenceMap = new Map<string, TaskRecurringOccurrenceRow>(
    occurrenceRows.map(row => [`${row.taskId}_${Number(row.occurrenceDate)}`, row]),
  )

  const result: any[] = []
  for (const row of allTasks) {
    if (row.kind === 'PIN' && row.taskTemplateId != null) {
      const tmpl = templateMap.get(row.taskTemplateId)
      if (!tmpl || !tmpl.isVisible)
        continue
    }
    const recurring = recurringMap.get(row.id) ?? null
    const parsedTask = parseTask(
      row,
      recurring,
      row.bankCardId != null ? bankCardMap.get(row.bankCardId)?.cardLastFour ?? null : null,
      row.sourceJobOccurrenceId != null ? sourceJobProgressAmountMap.get(row.sourceJobOccurrenceId) : null,
      row.taskTemplateId != null ? templateMap.get(row.taskTemplateId) ?? null : null,
    )
    const occurrenceDays = getOccurrenceDaysInMonth(parsedTask, recurring, year, month, monthStart, monthEnd, lastDay)
    if (!occurrenceDays.includes(dayStart))
      continue

    const occurrence = occurrenceMap.get(`${row.id}_${dayStart}`) ?? null
    const taskWithOccurrenceState = applyOccurrenceState(parsedTask, occurrence)
    if (taskWithOccurrenceState.status === 'CANCELLED')
      continue
    result.push({
      ...taskWithOccurrenceState,
      occurrenceDate: dayStart,
      occurrenceId: occurrence?.id ?? null,
    })
  }

  result.sort((a, b) => compareTasksForTimeline(a, b))
  return result
}

// ---------- 单任务查询 / 状态 ----------

export async function getTaskById(userId: number, id: string): Promise<any | null> {
  const parsedId = Number.parseInt(id, 10)
  if (!Number.isFinite(parsedId))
    return null
  const [row] = await db.select().from(task).where(and(eq(task.id, parsedId), eq(task.userId, userId))).limit(1)
  if (!row)
    return null

  const [recurring] = await db.select().from(taskRecurring).where(eq(taskRecurring.taskId, row.id)).limit(1)
  const bankCardLastFour = row.bankCardId != null
    ? (await getBankCardMap(userId, [row.bankCardId])).get(row.bankCardId)?.cardLastFour ?? null
    : null
  return parseTaskAsync(row, recurring, bankCardLastFour)
}

export async function updateTaskStatus(userId: number, id: string, status: string, occurrenceDate?: number): Promise<any | null> {
  const parsedId = Number.parseInt(id, 10)
  if (!Number.isFinite(parsedId))
    return null
  const [taskRow] = await db.select().from(task).where(and(eq(task.id, parsedId), eq(task.userId, userId))).limit(1)
  if (!taskRow)
    return null

  const [recurring] = await db.select().from(taskRecurring).where(eq(taskRecurring.taskId, taskRow.id)).limit(1)
  const isRecurring = taskRow.repeatType !== 'ONE_TIME' || recurring != null

  if (isRecurring && occurrenceDate != null) {
    const [existingOccurrence] = await db.select().from(taskRecurringOccurrence).where(and(
      eq(taskRecurringOccurrence.taskId, taskRow.id),
      eq(taskRecurringOccurrence.occurrenceDate, Number(occurrenceDate)),
    )).limit(1)

    const isCompleted = status === 'COMPLETED'
    if (existingOccurrence) {
      await db.update(taskRecurringOccurrence).set({
        status: status as 'PENDING' | 'EXPIRED' | 'COMPLETED' | 'CANCELLED',
        isCompleted: isCompleted ? 1 : 0,
        completedAt: isCompleted ? Date.now() : null,
        updatedAt: new Date(),
      }).where(eq(taskRecurringOccurrence.id, existingOccurrence.id))
    }
    else {
      await db.insert(taskRecurringOccurrence).values({
        taskId: taskRow.id,
        occurrenceDate: Number(occurrenceDate),
        status: status as 'PENDING' | 'EXPIRED' | 'COMPLETED' | 'CANCELLED',
        isCompleted: isCompleted ? 1 : 0,
        completedAt: isCompleted ? Date.now() : null,
        createdAt: Date.now(),
        updatedAt: new Date(),
      })
    }

    // BILL_REMINDER 完成一次即表示本期账单已还款，关闭该账期内其余提醒
    if (taskRow.kind === 'BILL_REMINDER' && status === 'COMPLETED' && recurring != null) {
      const DAY_MS = 86_400_000
      const startMs = startOfDay(Number(recurring.startDate))
      const endMs = startOfDay(Number(recurring.endDate))
      const completedDate = startOfDay(Number(occurrenceDate))
      const now = Date.now()

      const siblingDates: number[] = []
      for (let cur = startMs; cur <= endMs; cur += DAY_MS) {
        if (cur !== completedDate)
          siblingDates.push(cur)
      }

      if (siblingDates.length > 0) {
        const existingOccurrences = await db.select().from(taskRecurringOccurrence).where(and(
          eq(taskRecurringOccurrence.taskId, taskRow.id),
          inArray(taskRecurringOccurrence.occurrenceDate, siblingDates),
        ))
        const existingMap = new Map(existingOccurrences.map(o => [startOfDay(Number(o.occurrenceDate)), o]))

        const toInsert: Array<typeof taskRecurringOccurrence.$inferInsert> = []
        for (const date of siblingDates) {
          const occ = existingMap.get(date)
          if (!occ) {
            toInsert.push({
              taskId: taskRow.id,
              occurrenceDate: date,
              status: 'COMPLETED',
              isCompleted: 1,
              completedAt: now,
              createdAt: now,
              updatedAt: new Date(),
            })
            continue
          }
          if (occ.status !== 'COMPLETED') {
            await db.update(taskRecurringOccurrence).set({
              status: 'COMPLETED',
              isCompleted: 1,
              completedAt: now,
              updatedAt: new Date(),
            }).where(eq(taskRecurringOccurrence.id, occ.id))
          }
        }
        if (toInsert.length > 0) {
          await db.insert(taskRecurringOccurrence).values(toInsert)
        }
      }

      taskRow.status = 'COMPLETED'
      await db.update(task).set({ status: 'COMPLETED', updatedAt: new Date() }).where(eq(task.id, taskRow.id))
    }

    const parsed = await parseTaskAsync(taskRow, recurring)
    return {
      ...parsed,
      status,
      isCompleted: status === 'COMPLETED',
    }
  }

  // ONE_TIME 任务直接更新 task.status
  await db.update(task).set({ status: status as 'PENDING' | 'EXPIRED' | 'COMPLETED', updatedAt: new Date() }).where(eq(task.id, taskRow.id))
  const saved = { ...taskRow, status: status as TaskRow['status'] }
  const bankCardLastFour = saved.bankCardId != null
    ? (await getBankCardMap(userId, [saved.bankCardId])).get(saved.bankCardId)?.cardLastFour ?? null
    : null
  return parseTaskAsync(saved, recurring, bankCardLastFour)
}

export async function deleteTask(
  userId: number,
  id: string,
  options?: { occurrenceDate?: number | null, deleteFuture?: boolean },
): Promise<boolean> {
  const taskId = Number.parseInt(id, 10)
  if (!Number.isFinite(taskId))
    return false
  const [taskRow] = await db.select().from(task).where(and(eq(task.id, taskId), eq(task.userId, userId))).limit(1)
  if (!taskRow)
    return false
  const [recurring] = await db.select().from(taskRecurring).where(eq(taskRecurring.taskId, taskId)).limit(1)

  if (options?.deleteFuture && recurring != null) {
    const occurrenceDate = normalizeTimestampToMillis(options.occurrenceDate)
    if (occurrenceDate != null) {
      const currentDay = startOfDay(occurrenceDate)
      const recurringStart = recurring.startDate != null ? startOfDay(Number(recurring.startDate)) : null
      if (recurringStart == null || currentDay <= recurringStart) {
        await db.delete(taskRecurring).where(eq(taskRecurring.taskId, taskId))
        await db.delete(taskRecurringOccurrence).where(eq(taskRecurringOccurrence.taskId, taskId))
        const result = await db.delete(task).where(eq(task.id, taskId))
        return result[0].affectedRows > 0
      }

      // 截断循环：规则结束日提前到发生日前一天，并清理该日及之后的 occurrence
      await db.update(taskRecurring).set({
        endDate: currentDay - 86_400_000,
        updatedAt: new Date(),
      }).where(eq(taskRecurring.id, recurring.id))
      await db.delete(taskRecurringOccurrence).where(and(
        eq(taskRecurringOccurrence.taskId, taskId),
        gte(taskRecurringOccurrence.occurrenceDate, currentDay),
      ))
      return true
    }
  }

  await db.delete(taskRecurring).where(eq(taskRecurring.taskId, taskId))
  await db.delete(taskRecurringOccurrence).where(eq(taskRecurringOccurrence.taskId, taskId))
  const result = await db.delete(task).where(eq(task.id, taskId))
  return result[0].affectedRows > 0
}

// ---------- 账单还款提醒（kind='BILL_REMINDER'） ----------

export async function getBillReminderTasks(userId: number): Promise<any[]> {
  const tasks = await db.select().from(task).where(and(
    eq(task.userId, userId),
    eq(task.kind, 'BILL_REMINDER'),
  )).orderBy(desc(task.createdAt))
  const recurringMap = await getRecurringMap(tasks.map(t => t.id))
  const bankCardIds = tasks.map(t => t.bankCardId).filter((id): id is number => id != null)
  const bankCardMap = await getBankCardMap(userId, bankCardIds)
  return tasks.map((taskRow) => {
    const recurring = recurringMap.get(taskRow.id) ?? null
    const bankCardLastFour = taskRow.bankCardId != null
      ? bankCardMap.get(taskRow.bankCardId)?.cardLastFour ?? null
      : null
    return parseTask(taskRow, recurring, bankCardLastFour)
  })
}

export async function createBillReminderTask(userId: number, body: any): Promise<{ created: boolean, taskId: number }> {
  const bankCardId = Number(body.bankCardId)
  const repaymentAt = startOfDay(Number(body.repaymentAt))
  const statementAt = startOfDay(Number(body.statementAt))
  const benefitAmount = Number(body.benefitAmount)
  const reminderMode: 'SINGLE' | 'MULTIPLE' = body.reminderMode === 'SINGLE' ? 'SINGLE' : 'MULTIPLE'
  const reminderTime = typeof body.reminderTime === 'string' && body.reminderTime ? body.reminderTime : '12:00'
  const beforeDays = Math.min(Math.max(Number(body.beforeDays) || 3, 1), 3)
  const afterDays = Math.min(Math.max(Number(body.afterDays) || 3, 1), 3)

  if (!Number.isFinite(bankCardId) || bankCardId <= 0)
    throw new Error('bankCardId 无效')
  if (!Number.isFinite(repaymentAt))
    throw new Error('repaymentAt 无效')
  if (!Number.isFinite(statementAt))
    throw new Error('statementAt 无效')
  if (!Number.isFinite(benefitAmount) || benefitAmount <= 0)
    throw new Error('账单金额必须大于 0')

  await assertBankCardOwnership(userId, bankCardId)

  // 幂等：当前账期已有还款提醒任务时直接返回
  const existingTasks = await db.select().from(task).where(and(
    eq(task.userId, userId),
    eq(task.bankCardId, bankCardId),
    eq(task.kind, 'BILL_REMINDER'),
  ))
  if (existingTasks.length > 0) {
    const recurringMap = await getRecurringMap(existingTasks.map(t => t.id))
    for (const t of existingTasks) {
      const recurring = recurringMap.get(t.id)
      if (t.repeatType === 'ONE_TIME' && t.date != null && startOfDay(Number(t.date)) === repaymentAt) {
        return { created: false, taskId: t.id }
      }
      if (recurring && recurring.startDate != null && recurring.endDate != null) {
        const start = startOfDay(Number(recurring.startDate))
        const end = startOfDay(Number(recurring.endDate))
        if (start <= repaymentAt && repaymentAt <= end) {
          return { created: false, taskId: t.id }
        }
      }
    }
  }

  const DAY_MS = 86_400_000
  const isDaily = reminderMode === 'MULTIPLE'
  const startDate = isDaily ? startOfDay(repaymentAt - beforeDays * DAY_MS) : repaymentAt
  const endDate = isDaily ? startOfDay(repaymentAt + afterDays * DAY_MS) : repaymentAt

  const [card] = await db.select({ remark: bankCard.remark, cardLastFour: bankCard.cardLastFour })
    .from(bankCard)
    .where(and(eq(bankCard.id, bankCardId), eq(bankCard.userId, userId)))
    .limit(1)
  const cardLabel = card?.remark?.trim() || card?.cardLastFour || '信用卡'
  const stmtDate = new Date(statementAt)
  const title = `${cardLabel} 还款提醒 · ${stmtDate.getMonth() + 1}月账单`

  const [inserted] = await db.insert(task).values({
    userId,
    title,
    kind: 'BILL_REMINDER',
    bankCardId,
    benefitAmountFixed: String(benefitAmount),
    reminderTime,
    createdAt: Date.now(),
    status: 'PENDING',
    repeatType: isDaily ? 'DAILY' : 'ONE_TIME',
    date: isDaily ? startDate : repaymentAt,
    updatedAt: new Date(),
  } as typeof task.$inferInsert).$returningId()
  const savedTaskId = Number(inserted.id)

  if (isDaily) {
    await upsertRecurringRule(savedTaskId, {
      repeatType: 'DAILY',
      startDate,
      endDate,
      reminderTime,
    })
  }

  return { created: true, taskId: savedTaskId }
}

export async function updateBillReminderAmount(userId: number, id: string, amount: number): Promise<{ taskId: number, benefitAmountFixed: number }> {
  const parsedId = Number.parseInt(id, 10)
  if (!Number.isFinite(parsedId))
    throw new Error('task id 无效')
  const [taskRow] = await db.select().from(task).where(and(
    eq(task.id, parsedId),
    eq(task.userId, userId),
    eq(task.kind, 'BILL_REMINDER'),
  )).limit(1)
  if (!taskRow)
    throw new Error('未找到对应的还款提醒任务')
  await db.update(task).set({
    benefitAmountFixed: String(amount),
    updatedAt: new Date(),
  }).where(eq(task.id, taskRow.id))
  return { taskId: taskRow.id, benefitAmountFixed: amount }
}
