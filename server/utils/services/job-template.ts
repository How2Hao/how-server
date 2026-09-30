import type { bank } from '~/server/database/schema/plaza.ts'
// 达标 Job 模板服务：模板列表、月视图混合展示（TEMPLATE_CANDIDATE / USER_JOB）、
// 还款 job（REPAYMENT）账期 upsert 与提醒、活动 job 达标进度 / 达标后提醒、周期实例管理
// 逐行对应旧 how-api src/service/job_template.ts（TypeORM → drizzle），业务语义与错误文案保持一致
//
// 鉴权注意：/job-template 域在旧系统不在鉴权中间件白名单内，旧处理器 getCurrentUserId() 未登录时
// throw '未登录' 被控制器捕获 → HTTP 200 { success:false, message:'未登录', data:null }。
// 路由层用 getAuth + fail('未登录') 复刻，勿改成 requireAuth（那是 401 语义）。
import type { JobRewardWindowRule, JobTemplateTier, TaskTemplateTier } from '~/server/database/schema/task.ts'
import { and, asc, count, desc, eq, inArray, ne } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { bankCard } from '~/server/database/schema/plaza.ts'
import { job, jobRecurring, jobRecurringOccurrence, jobTemplate, reminderTemplate, task, taskTemplate } from '~/server/database/schema/task.ts'
import { resolveBanks } from '~/server/utils/services/reference-cache.ts'
import { createTask, deleteTask } from '~/server/utils/services/task.ts'

type JobRow = typeof job.$inferSelect
type JobRecurringRow = typeof jobRecurring.$inferSelect
type JobRecurringOccurrenceRow = typeof jobRecurringOccurrence.$inferSelect
type JobTemplateRow = typeof jobTemplate.$inferSelect
type ReminderTemplateRow = typeof reminderTemplate.$inferSelect
type TaskTemplateRow = typeof taskTemplate.$inferSelect
type BankRow = typeof bank.$inferSelect

type JobDisplayItemType = 'TEMPLATE_CANDIDATE' | 'USER_JOB'
export type RepaymentSubjectType = 'BANK' | 'BANK_CARD'

export interface RepaymentInput {
  clientKey: string
  subjectType: RepaymentSubjectType
  subjectId: number
  title: string
  bankName: string | null
  statementAt: number
  repaymentAt: number
  progressAmount?: number | null
}

/** 发生窗口（cycleKey + 起止） */
export interface OccurrenceWindow { cycleKey: string, startAt: number, endAt: number }
/** 权益窗口 */
export interface RewardWindow { startAt: number, endAt: number }

/** 只关心进度字段的结构（job_recurring_occurrence 行与测试字面量均满足） */
export interface OccurrenceProgressLike {
  progressAmount?: string | number | null
  progressCount?: number | null
}

/** 权益窗口计算所需的 occurrence 形状 */
export interface OccurrenceRewardWindowLike extends OccurrenceProgressLike {
  occurrenceStartAt: number | string
  occurrenceEndAt: number | string
  rewardStartAt?: number | string | null
  rewardEndAt?: number | string | null
  completedAt?: number | null
}

/** job_template 行的最小结构（JobTemplateRow 与测试字面量均满足） */
export interface JobTemplateLike {
  repeatType?: string | null
  date?: number | null
  startDate?: number | null
  endDate?: number | null
  daysOfWeek?: string | null
  daysOfMonth?: string | null
  yearlyMonths?: string | null
  yearlyDaysOfMonth?: string | null
  rewardWindowRule?: JobRewardWindowRule | null
}

/** job_recurring 行的最小结构 */
export interface JobRecurringLike {
  repeatType?: string | null
  daysOfWeek?: string | null
  daysOfMonth?: string | null
  yearlyMonths?: string | null
  yearlyDaysOfMonth?: string | null
  startDate?: number | null
  endDate?: number | null
}

/** reminder_template 行的最小结构 */
export interface ReminderTemplateLike {
  repeatType?: string | null
  date?: number | null
  startDate?: number | null
  endDate?: number | null
  daysOfWeek?: string | null
  daysOfMonth?: string | null
  yearlyMonths?: string | null
  yearlyDaysOfMonth?: string | null
  reminderTime?: string | null
}

// ---------- 纯函数（无 db，供周期窗口 / 权益窗口 / 达标判定与测试复用） ----------

/**
 * 时间戳归一到毫秒：秒（<1e11）×1000、微秒（≥1e14）÷1000、毫秒原样。
 * 注意与 task.ts 的同名概念不同（那边只做 Number()），此处保留旧 job_template 服务的三段式换算。
 */
export function normalizeTsToMillis(value: unknown): number | null {
  if (value == null)
    return null
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric))
    return null
  const abs = Math.abs(numeric)
  if (abs < 1e11)
    return Math.trunc(numeric * 1000)
  if (abs >= 1e14)
    return Math.trunc(numeric / 1000)
  return Math.trunc(numeric)
}

export function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
}

export function endOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime()
}

export function startOfWeek(ms: number, weekStartsOn = 1): number {
  const d = new Date(startOfDay(ms))
  const day = d.getDay() === 0 ? 7 : d.getDay()
  const normalizedWeekStartsOn = weekStartsOn >= 1 && weekStartsOn <= 7 ? weekStartsOn : 1
  const diff = day >= normalizedWeekStartsOn
    ? normalizedWeekStartsOn - day
    : normalizedWeekStartsOn - day - 7
  d.setDate(d.getDate() + diff)
  return d.getTime()
}

/** 当月 1 号 0 点 */
export function startOfMonth(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime()
}

/** 当月最后一天 0 点（旧实现如此，不带 23:59:59） */
export function endOfMonth(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 0, 0, 0, 0).getTime()
}

export function startOfYear(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0).getTime()
}

/** 当年 12-31 0 点（旧实现如此） */
export function endOfYear(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), 11, 31, 0, 0, 0, 0).getTime()
}

/** 加 N 天并归到当天 0 点 */
export function addDays(ms: number, days: number): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + days)
  return startOfDay(d.getTime())
}

/** 加 N 个月（落在 1 号 0 点） */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth() + months, 1, 0, 0, 0, 0).getTime()
}

export function formatYMD(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function formatYM(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 短日期文案：M/D */
export function formatShortDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** ISO 周几：周一=1 … 周日=7 */
export function getIsoWeekDay(ms: number): number {
  const day = new Date(ms).getDay()
  return day === 0 ? 7 : day
}

export function formatIsoWeekDayText(day: number): string {
  const labels = ['一', '二', '三', '四', '五', '六', '日']
  return labels[Math.min(Math.max(day, 1), 7) - 1]
}

export function uniqueSortedNumbers(values: number[]): number[] {
  return Array.from(new Set(values)).sort((a, b) => a - b)
}

/** 夹取整数到 [min, max]，非法输入返回 fallback */
export function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Math.trunc(Number(value))
  if (!Number.isFinite(numeric))
    return fallback
  return Math.min(Math.max(numeric, min), max)
}

/** 循环规则 days 字段：JSON 数组字符串或 '1,2' 裸串，解析回 number[] */
export function parseNumberList(raw: string | null | undefined): number[] {
  const text = raw?.trim()
  if (!text)
    return []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) {
      return parsed.map(item => Number(item)).filter(item => Number.isInteger(item))
    }
  }
  catch {}
  return text
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map(item => Number(item.replace(/"/g, '').trim()))
    .filter(item => Number.isInteger(item))
}

export function parseReminderTime(value: string | null | undefined): { hour: number, minute: number, second: number } {
  const parts = String(value || '09:00').split(':').map(item => Number(item))
  const hour = Number.isFinite(parts[0]) ? Math.min(Math.max(Math.trunc(parts[0]), 0), 23) : 9
  const minute = Number.isFinite(parts[1]) ? Math.min(Math.max(Math.trunc(parts[1]), 0), 59) : 0
  const second = Number.isFinite(parts[2]) ? Math.min(Math.max(Math.trunc(parts[2]), 0), 59) : 0
  return { hour, minute, second }
}

/** 归一为 HH:mm 文案（缺省 09:00） */
export function normalizeReminderTime(value: string | null | undefined): string {
  const { hour, minute } = parseReminderTime(value)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** 当天 0 点 + 提醒时刻 → 具体时间戳 */
export function applyReminderTime(dayStart: number, reminderTime: string | null | undefined): number {
  const { hour, minute, second } = parseReminderTime(reminderTime)
  const d = new Date(startOfDay(dayStart))
  d.setHours(hour, minute, second, 0)
  return d.getTime()
}

export function buildRepaymentSubjectKey(subjectType: RepaymentSubjectType, subjectId: number): string {
  return `${subjectType}:${subjectId}`
}

/** 还款账期唯一键：R:<subjectType>:<subjectId>:<账单日 YMD>:<还款日 YMD>（clientKey 缺省时的幂等键） */
export function buildRepaymentCycleKey(
  input: Pick<RepaymentInput, 'subjectType' | 'subjectId' | 'statementAt' | 'repaymentAt'>,
): string {
  return `R:${input.subjectType}:${input.subjectId}:${formatYMD(input.statementAt)}:${formatYMD(input.repaymentAt)}`
}

export function normalizeRepaymentInputs(rawItems: any): RepaymentInput[] {
  if (!Array.isArray(rawItems))
    return []
  return rawItems
    .map(item => normalizeRepaymentInput(item))
    .filter((item): item is RepaymentInput => item != null)
}

/** 还款条目归一：时间戳归毫秒 + 取当天 0 点；clientKey 缺省时用账期键兜底；非法返回 null */
export function normalizeRepaymentInput(raw: any): RepaymentInput | null {
  if (!raw || typeof raw !== 'object')
    return null
  const subjectType = raw.subjectType === 'BANK' || raw.subjectType === 'BANK_CARD'
    ? raw.subjectType as RepaymentSubjectType
    : null
  const subjectId = Number(raw.subjectId)
  const statementAt = normalizeTsToMillis(raw.statementAt)
  const repaymentAt = normalizeTsToMillis(raw.repaymentAt)
  if (!subjectType || !Number.isFinite(subjectId) || subjectId <= 0 || statementAt == null || repaymentAt == null) {
    return null
  }
  const progressAmount = raw.progressAmount == null
    ? null
    : Math.max(Number(raw.progressAmount), 0)
  return {
    bankName: typeof raw.bankName === 'string' && raw.bankName.trim() ? raw.bankName.trim() : null,
    clientKey: typeof raw.clientKey === 'string' && raw.clientKey.trim()
      ? raw.clientKey.trim()
      : buildRepaymentCycleKey({
          subjectType,
          subjectId,
          statementAt: startOfDay(statementAt),
          repaymentAt: startOfDay(repaymentAt),
        } as RepaymentInput),
    progressAmount: progressAmount != null && Number.isFinite(progressAmount) ? progressAmount : null,
    repaymentAt: startOfDay(repaymentAt),
    statementAt: startOfDay(statementAt),
    subjectId: Math.trunc(subjectId),
    subjectType,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : '信用卡还款',
  }
}

/** 还款账期状态：已完成为准；过还款日整天 → EXPIRED；有金额 → IN_PROGRESS；否则 PENDING */
export function resolveRepaymentOccurrenceStatus(occurrence: {
  status?: string | null
  occurrenceEndAt: number | string
  progressAmount?: string | number | null
}): 'COMPLETED' | 'EXPIRED' | 'IN_PROGRESS' | 'PENDING' {
  if (occurrence.status === 'COMPLETED')
    return 'COMPLETED'
  const repaymentEnd = endOfDay(Number(occurrence.occurrenceEndAt))
  if (Date.now() > repaymentEnd)
    return 'EXPIRED'
  return Number(occurrence.progressAmount ?? 0) > 0 ? 'IN_PROGRESS' : 'PENDING'
}

/**
 * 由模板 repeatType + 选中日期推导发生窗口与周期键（cycleKey）：
 * ONE_TIME → ONCE:<起YMD>:<止YMD>；DAILY → D:<YMD>；WEEKLY → W:<周一YMD>；
 * MONTHLY → M:<YM>；YEARLY → Y:<年>。窗口会向模板有效期收拢，收拢后倒挂返回 null。
 */
export function buildOccurrenceWindow(
  template: JobTemplateLike | null | undefined,
  selectedAt: number,
  recurring?: JobRecurringLike | null,
): OccurrenceWindow | null {
  const selectedDay = startOfDay(normalizeTsToMillis(selectedAt) ?? Date.now())
  const templateStart = normalizeTsToMillis(
    recurring?.startDate ?? template?.startDate ?? template?.date,
  )
  const templateEnd = normalizeTsToMillis(
    recurring?.endDate ?? template?.endDate ?? template?.date,
  )
  if (templateStart != null && selectedDay < startOfDay(templateStart))
    return null
  if (templateEnd != null && selectedDay > startOfDay(templateEnd))
    return null

  const repeatType = recurring?.repeatType ?? template?.repeatType ?? 'ONE_TIME'
  let startAt = selectedDay
  let endAt = selectedDay
  let cycleKey = formatYMD(selectedDay)

  if (repeatType === 'ONE_TIME') {
    startAt = startOfDay(templateStart ?? selectedDay)
    endAt = startOfDay(templateEnd ?? templateStart ?? selectedDay)
    cycleKey = `ONCE:${formatYMD(startAt)}:${formatYMD(endAt)}`
  }
  else if (repeatType === 'WEEKLY') {
    startAt = startOfWeek(selectedDay)
    endAt = addDays(startAt, 6)
    cycleKey = `W:${formatYMD(startAt)}`
  }
  else if (repeatType === 'MONTHLY') {
    startAt = startOfMonth(selectedDay)
    endAt = endOfMonth(selectedDay)
    cycleKey = `M:${formatYM(selectedDay)}`
  }
  else if (repeatType === 'YEARLY') {
    startAt = startOfYear(selectedDay)
    endAt = endOfYear(selectedDay)
    cycleKey = `Y:${new Date(selectedDay).getFullYear()}`
  }
  else {
    cycleKey = `D:${formatYMD(selectedDay)}`
  }

  if (templateStart != null)
    startAt = Math.max(startAt, startOfDay(templateStart))
  if (templateEnd != null)
    endAt = Math.min(endAt, startOfDay(templateEnd))
  if (startAt > endAt)
    return null

  return { cycleKey, startAt, endAt }
}

/** 结构化权益窗口规则 → 具体窗口（NEXT_WEEK / NEXT_MONTH / AFTER_COMPLETION_DAYS / FIXED） */
export function buildRewardWindow(
  rule: JobRewardWindowRule | null | undefined,
  occurrenceWindow: { startAt: number, endAt: number },
  completedAt: number | null,
): RewardWindow | null {
  if (!rule)
    return null
  if (rule.mode === 'NEXT_WEEK') {
    const weekStartsOn = typeof rule.weekStartsOn === 'number' ? rule.weekStartsOn : 1
    const nextWeekStart = addDays(startOfWeek(occurrenceWindow.startAt, weekStartsOn), 7)
    return {
      startAt: nextWeekStart,
      endAt: endOfDay(addDays(nextWeekStart, 6)),
    }
  }

  if (rule.mode === 'NEXT_MONTH') {
    const base = new Date(occurrenceWindow.startAt)
    const lastDay = new Date(base.getFullYear(), base.getMonth() + 2, 0).getDate()
    const startDay = typeof rule.startDay === 'number' ? Math.min(Math.max(rule.startDay, 1), lastDay) : 1
    const endDay = typeof rule.endDay === 'number' ? Math.min(Math.max(rule.endDay, 1), lastDay) : lastDay
    const startAt = new Date(base.getFullYear(), base.getMonth() + 1, startDay, 0, 0, 0, 0).getTime()
    const endAt = endOfDay(new Date(base.getFullYear(), base.getMonth() + 1, endDay, 0, 0, 0, 0).getTime())
    return startAt <= endAt ? { startAt, endAt } : null
  }

  if (rule.mode === 'AFTER_COMPLETION_DAYS') {
    if (completedAt == null)
      return null
    const startOffsetDays = typeof rule.startOffsetDays === 'number' ? rule.startOffsetDays : 0
    const durationDays = typeof rule.durationDays === 'number' && rule.durationDays > 0 ? rule.durationDays : 1
    const startAt = addDays(startOfDay(completedAt), startOffsetDays)
    return {
      startAt,
      endAt: endOfDay(addDays(startAt, durationDays - 1)),
    }
  }

  if (rule.mode === 'FIXED') {
    const startAt = normalizeTsToMillis(rule.startAt)
    const endAt = normalizeTsToMillis(rule.endAt)
    if (startAt == null || endAt == null)
      return null
    return { startAt: startOfDay(startAt), endAt: endOfDay(endAt) }
  }

  return null
}

/** 优先沿用 occurrence 上已有的权益窗口；否则按规则 + 完成时间现算 */
export function ensureOccurrenceRewardWindow(
  rule: JobRewardWindowRule | null | undefined,
  occurrence: OccurrenceRewardWindowLike,
): RewardWindow | null {
  const existingStart = normalizeTsToMillis(occurrence.rewardStartAt)
  const existingEnd = normalizeTsToMillis(occurrence.rewardEndAt)
  if (existingStart != null && existingEnd != null) {
    return { startAt: existingStart, endAt: existingEnd }
  }
  return buildRewardWindow(
    rule,
    {
      startAt: Number(occurrence.occurrenceStartAt),
      endAt: Number(occurrence.occurrenceEndAt),
    },
    occurrence.completedAt != null ? Number(occurrence.completedAt) : null,
  )
}

/** 达标判定：过滤掉无门槛档，按 logic 求值，命中档里取 minAmount 最高的 */
export function getAchievedTier(
  tiers: JobTemplateTier[] | null | undefined,
  occurrence: OccurrenceProgressLike,
): JobTemplateTier | null {
  const validTiers = [...(tiers ?? [])]
    .filter(tier => tier.minAmount != null || tier.minCount != null)
  if (validTiers.length === 0)
    return null
  const progressAmount = Number(occurrence.progressAmount ?? 0)
  const progressCount = Number(occurrence.progressCount ?? 0)
  return validTiers
    .filter((tier) => {
      const amountOk = tier.minAmount == null || progressAmount >= Number(tier.minAmount)
      const countOk = tier.minCount == null || progressCount >= Number(tier.minCount)
      return tier.logic === 'OR' ? amountOk || countOk : amountOk && countOk
    })
    .sort((a, b) => Number(b.minAmount ?? 0) - Number(a.minAmount ?? 0))[0] ?? null
}

export function isOccurrenceCompleted(
  tiers: JobTemplateTier[] | null | undefined,
  occurrence: OccurrenceProgressLike,
): boolean {
  return !!getAchievedTier(tiers, occurrence)
}

/** task_template 档位匹配：minAmount 为 null 取第一档；否则取 ≤ 达标金额的最大档，兜底第一档 */
export function findTaskTemplateTier(
  tiers: TaskTemplateTier[] | null | undefined,
  minAmount: number | null,
): TaskTemplateTier | null {
  const validTiers = [...(tiers ?? [])]
  if (validTiers.length === 0)
    return null
  if (minAmount == null)
    return validTiers[0] ?? null
  return validTiers
    .filter(tier => tier.minAmount == null || Number(tier.minAmount) <= Number(minAmount))
    .sort((a, b) => Number(b.minAmount ?? 0) - Number(a.minAmount ?? 0))[0] ?? validTiers[0] ?? null
}

/** 循环规则生效类型：DAILY/WEEKLY/MONTHLY/YEARLY 之一；ONE_TIME（或未知）返回 null */
export function getRecurringRepeatType(
  job: { repeatType?: string | null },
  template?: JobTemplateLike | null,
): 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY' | null {
  const repeatType = template?.repeatType ?? job.repeatType
  if (
    repeatType === 'DAILY'
    || repeatType === 'WEEKLY'
    || repeatType === 'MONTHLY'
    || repeatType === 'YEARLY'
  ) {
    return repeatType
  }
  return null
}

/**
 * 提醒模板在权益窗口内的具体提醒时间展开（当天 0 点 + reminderTime，窗口向模板有效期收拢）。
 * ONE_TIME 用锚点日期；DAILY 每天一次；WEEKLY 按 daysOfWeek（ISO 1-7）；
 * MONTHLY 按 daysOfMonth（缺省用模板 date 的“日”）；YEARLY 按 月+日 组合。
 */
export function expandReminderTemplateDates(
  reminderTemplate: ReminderTemplateLike,
  rewardWindow: RewardWindow,
): number[] {
  const templateStart = normalizeTsToMillis(reminderTemplate.startDate)
  const templateEnd = normalizeTsToMillis(reminderTemplate.endDate)
  const startAt = Math.max(rewardWindow.startAt, templateStart ?? rewardWindow.startAt)
  const endAt = Math.min(rewardWindow.endAt, templateEnd ?? rewardWindow.endAt)
  if (startAt > endAt)
    return []

  const repeatType = reminderTemplate.repeatType ?? 'ONE_TIME'
  const dates: number[] = []
  const pushIfInWindow = (dayStart: number) => {
    const exactAt = applyReminderTime(dayStart, reminderTemplate.reminderTime)
    if (exactAt >= startAt && exactAt <= endAt)
      dates.push(exactAt)
  }

  if (repeatType === 'ONE_TIME') {
    const anchor = normalizeTsToMillis(reminderTemplate.date) ?? startAt
    pushIfInWindow(startOfDay(anchor))
    return uniqueSortedNumbers(dates)
  }

  if (repeatType === 'DAILY') {
    for (let day = startOfDay(startAt); day <= startOfDay(endAt); day = addDays(day, 1)) {
      pushIfInWindow(day)
    }
    return uniqueSortedNumbers(dates)
  }

  if (repeatType === 'WEEKLY') {
    const daysOfWeek = parseNumberList(reminderTemplate.daysOfWeek)
    for (let day = startOfDay(startAt); day <= startOfDay(endAt); day = addDays(day, 1)) {
      const weekDay = getIsoWeekDay(day)
      if (daysOfWeek.length === 0 || daysOfWeek.includes(weekDay))
        pushIfInWindow(day)
    }
    return uniqueSortedNumbers(dates)
  }

  if (repeatType === 'MONTHLY') {
    const daysOfMonth = parseNumberList(reminderTemplate.daysOfMonth)
    const fallbackDay = reminderTemplate.date != null
      ? new Date(Number(reminderTemplate.date)).getDate()
      : 1
    let cursor = startOfMonth(startAt)
    const endMonth = startOfMonth(endAt)
    while (cursor <= endMonth) {
      const base = new Date(cursor)
      const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()
      const days = daysOfMonth.length > 0 ? daysOfMonth : [fallbackDay]
      for (const day of days) {
        if (day < 1 || day > lastDay)
          continue
        pushIfInWindow(new Date(base.getFullYear(), base.getMonth(), day, 0, 0, 0, 0).getTime())
      }
      cursor = addMonths(cursor, 1)
    }
    return uniqueSortedNumbers(dates)
  }

  if (repeatType === 'YEARLY') {
    const months = parseNumberList(reminderTemplate.yearlyMonths)
    const days = parseNumberList(reminderTemplate.yearlyDaysOfMonth)
    const startYear = new Date(startAt).getFullYear()
    const endYear = new Date(endAt).getFullYear()
    for (let year = startYear; year <= endYear; year++) {
      const targetMonths = months.length > 0 ? months : [new Date(reminderTemplate.date ?? startAt).getMonth() + 1]
      for (const month of targetMonths) {
        const lastDay = new Date(year, month, 0).getDate()
        const targetDays = days.length > 0 ? days : [new Date(reminderTemplate.date ?? startAt).getDate()]
        for (const day of targetDays) {
          if (day < 1 || day > lastDay)
            continue
          pushIfInWindow(new Date(year, month - 1, day, 0, 0, 0, 0).getTime())
        }
      }
    }
  }

  return uniqueSortedNumbers(dates)
}

/** 月视图/详情里的提醒节奏文案，如「每天 09:00」「每月1日、15日 12:00」 */
export function buildReminderScheduleLabel(reminderTemplate: ReminderTemplateLike | null): string | null {
  if (!reminderTemplate)
    return null
  const time = normalizeReminderTime(reminderTemplate.reminderTime)
  const timeText = time ? ` ${time}` : ''
  const repeatType = reminderTemplate.repeatType ?? 'ONE_TIME'

  if (repeatType === 'DAILY') {
    return `每天${timeText}`
  }

  if (repeatType === 'WEEKLY') {
    const days = parseNumberList(reminderTemplate.daysOfWeek)
    const dayText = days.length > 0
      ? days.map(day => formatIsoWeekDayText(day)).join('、')
      : ''
    return `每周${dayText}${timeText}`
  }

  if (repeatType === 'MONTHLY') {
    const days = parseNumberList(reminderTemplate.daysOfMonth)
    const dayText = days.length > 0
      ? `${days.join('、')}日`
      : '指定日期'
    return `每月${dayText}${timeText}`
  }

  if (repeatType === 'YEARLY') {
    const months = parseNumberList(reminderTemplate.yearlyMonths)
    const days = parseNumberList(reminderTemplate.yearlyDaysOfMonth)
    const monthText = months.length > 0 ? `${months.join('、')}月` : ''
    const dayText = days.length > 0 ? `${days.join('、')}日` : ''
    const dateText = `${monthText}${dayText}`
    return dateText ? `每年${dateText}${timeText}` : `每年${timeText}`
  }

  return `指定时间${timeText}`
}

// ---------- DB 层 ----------

/** 模板列表：上架（isVisible=1）的 job_template，附银行摘要 */
export async function getJobTemplates() {
  const templates = await db.select().from(jobTemplate).where(eq(jobTemplate.isVisible, 1)).orderBy(asc(jobTemplate.id))

  const bankIds = templates
    .map(t => t.bankId)
    .filter((id): id is number => id != null)

  const bankMap: Map<number, BankRow> = bankIds.length
    ? await resolveBanks(bankIds)
    : new Map()

  return templates.map((t) => {
    const bankRow = t.bankId ? bankMap.get(t.bankId) : null
    return {
      id: t.id,
      title: t.title,
      repeatType: t.repeatType,
      date: t.date ? Number(t.date) : null,
      startDate: t.startDate ? Number(t.startDate) : null,
      endDate: t.endDate ? Number(t.endDate) : null,
      tiers: t.tiers,
      bank: bankRow ? { id: bankRow.id, name: bankRow.name, logo: bankRow.logo } : null,
    }
  })
}

function getTemplateBankId(template: JobTemplateRow, taskTemplateMap: Map<number, TaskTemplateRow>): number | null {
  if (template.taskTemplateId) {
    const taskTemplateRow = taskTemplateMap.get(template.taskTemplateId)
    if (taskTemplateRow?.bankId != null)
      return Number(taskTemplateRow.bankId)
  }
  return template.bankId ?? null
}

function getJobBankId(
  jobRow: JobRow,
  template: JobTemplateRow | null | undefined,
  taskTemplateMap: Map<number, TaskTemplateRow>,
): number | null {
  const taskTemplateId = jobRow.taskTemplateId ?? template?.taskTemplateId ?? null
  if (taskTemplateId) {
    const taskTemplateRow = taskTemplateMap.get(taskTemplateId)
    if (taskTemplateRow?.bankId != null)
      return Number(taskTemplateRow.bankId)
  }
  return template?.bankId ?? null
}

/** 保证 job_recurring 行存在（循环 job）；唯一键冲突时回读已插入的行 */
async function ensureJobRecurring(
  jobRow: JobRow,
  template?: JobTemplateRow | null,
): Promise<JobRecurringRow | null> {
  const repeatType = getRecurringRepeatType(jobRow, template)
  if (!repeatType)
    return null

  const [existing] = await db.select().from(jobRecurring).where(eq(jobRecurring.jobId, jobRow.id)).limit(1)
  if (existing)
    return existing

  const values = {
    jobId: jobRow.id,
    repeatType,
    daysOfWeek: template?.daysOfWeek ?? null,
    daysOfMonth: template?.daysOfMonth ?? null,
    yearlyMonths: template?.yearlyMonths ?? null,
    yearlyDaysOfMonth: template?.yearlyDaysOfMonth ?? null,
    startDate: template?.startDate ?? template?.date ?? null,
    endDate: template?.endDate ?? null,
    createdAt: Date.now(),
    updatedAt: new Date(),
  }

  try {
    const [inserted] = await db.insert(jobRecurring).values(values).$returningId()
    const [row] = await db.select().from(jobRecurring).where(eq(jobRecurring.id, Number(inserted.id))).limit(1)
    return row ?? null
  }
  catch (e) {
    const [found] = await db.select().from(jobRecurring).where(eq(jobRecurring.jobId, jobRow.id)).limit(1)
    if (found)
      return found
    throw e
  }
}

/** 按“选中日期所在周期”取 occurrence；createIfMissing=true 时落库新周期实例（ACTIVITY 语义） */
async function getOrCreateOccurrenceForDate(
  jobRow: JobRow,
  template: JobTemplateRow | null | undefined,
  selectedAt: number,
  recurring?: JobRecurringRow | null,
  createIfMissing = true,
): Promise<JobRecurringOccurrenceRow | null> {
  const window = buildOccurrenceWindow(template, selectedAt, recurring)
  if (!window)
    return null

  const [existing] = await db.select().from(jobRecurringOccurrence).where(and(
    eq(jobRecurringOccurrence.jobId, jobRow.id),
    eq(jobRecurringOccurrence.cycleKey, window.cycleKey),
  )).limit(1)
  if (existing)
    return existing
  if (!createIfMissing)
    return null

  const rewardWindow = buildRewardWindow(template?.rewardWindowRule ?? null, window, null)
  const [inserted] = await db.insert(jobRecurringOccurrence).values({
    jobId: jobRow.id,
    cycleKey: window.cycleKey,
    occurrenceStartAt: window.startAt,
    occurrenceEndAt: window.endAt,
    rewardStartAt: rewardWindow?.startAt ?? null,
    rewardEndAt: rewardWindow?.endAt ?? null,
    status: 'IN_PROGRESS',
    progressAmount: '0.00',
    progressCount: 0,
    completedAt: null,
    createdAt: Date.now(),
    updatedAt: new Date(),
  }).$returningId()
  const [row] = await db.select().from(jobRecurringOccurrence).where(eq(jobRecurringOccurrence.id, Number(inserted.id))).limit(1)
  return row ?? null
}

/** 提醒创建时的周期定位：优先 occurrenceId，否则按 body.date 所在周期（只查不建） */
async function resolveUserOccurrence(
  jobRow: JobRow,
  template: JobTemplateRow | null,
  recurring: JobRecurringRow | null,
  body: any,
): Promise<JobRecurringOccurrenceRow | null> {
  const occurrenceId = Number(body?.occurrenceId)
  if (Number.isFinite(occurrenceId) && occurrenceId > 0) {
    const [occurrence] = await db.select().from(jobRecurringOccurrence).where(and(
      eq(jobRecurringOccurrence.id, occurrenceId),
      eq(jobRecurringOccurrence.jobId, jobRow.id),
    )).limit(1)
    if (occurrence)
      return occurrence
  }
  return getOrCreateOccurrenceForDate(
    jobRow,
    template,
    normalizeTsToMillis(body?.date) ?? Date.now(),
    recurring,
    false,
  )
}

/** 月视图：可见模板（候选）+ 用户已添加 job（USER_JOB）混合列表 */
export async function getJobDisplayItems(userId: number, selectedAt?: number) {
  const targetAt = normalizeTsToMillis(selectedAt) ?? Date.now()
  const [visibleTemplates, jobs] = await Promise.all([
    db.select().from(jobTemplate).where(eq(jobTemplate.isVisible, 1)).orderBy(asc(jobTemplate.id)),
    db.select().from(job).where(and(
      eq(job.userId, userId),
      eq(job.sourceType, 'ACTIVITY'),
      ne(job.status, 'ARCHIVED'),
    )).orderBy(asc(job.id)),
  ])

  const visibleTemplateMap = new Map(visibleTemplates.map(t => [t.id, t]))
  const linkedTemplateIds = Array.from(new Set(
    jobs
      .map(j => j.jobTemplateId)
      .filter((id): id is number => id != null),
  ))
  const missingLinkedTemplateIds = linkedTemplateIds
    .filter(id => !visibleTemplateMap.has(id))
  const linkedTemplates = missingLinkedTemplateIds.length
    ? await db.select().from(jobTemplate).where(inArray(jobTemplate.id, missingLinkedTemplateIds))
    : []
  const templates = [
    ...visibleTemplates,
    ...linkedTemplates.filter(t => !visibleTemplateMap.has(t.id)),
  ]
  const templateMap = new Map(templates.map(t => [t.id, t]))
  const reminderTemplateIds = Array.from(new Set(
    templates
      .map(t => t.reminderTemplateId)
      .filter((id): id is number => id != null),
  ))
  const reminderTemplateRows = reminderTemplateIds.length
    ? await db.select().from(reminderTemplate).where(inArray(reminderTemplate.id, reminderTemplateIds))
    : []
  const reminderTemplateMap = new Map(reminderTemplateRows.map(t => [t.id, t]))
  const jobsByTemplateId = new Map<number, JobRow[]>()
  for (const jobRow of jobs) {
    if (jobRow.jobTemplateId == null)
      continue
    const arr = jobsByTemplateId.get(jobRow.jobTemplateId) ?? []
    arr.push(jobRow)
    jobsByTemplateId.set(jobRow.jobTemplateId, arr)
  }

  const taskTemplateIds = Array.from(new Set([
    ...templates.map(t => t.taskTemplateId),
    ...jobs.map(j => j.taskTemplateId),
  ].filter((id): id is number => id != null)))

  const taskTemplateRows = taskTemplateIds.length
    ? await db.select().from(taskTemplate).where(inArray(taskTemplate.id, taskTemplateIds))
    : []
  const taskTemplateMap = new Map(taskTemplateRows.map(t => [t.id, t]))

  const bankIds = Array.from(new Set([
    ...templates.map(t => getTemplateBankId(t, taskTemplateMap)),
    ...jobs.map((j) => {
      const template = j.jobTemplateId ? templateMap.get(j.jobTemplateId) : null
      return getJobBankId(j, template, taskTemplateMap)
    }),
  ].filter((id): id is number => id != null)))
  const bankMap: Map<number, BankRow> = bankIds.length
    ? await resolveBanks(bankIds)
    : new Map()
  const recurringPairs = await Promise.all(
    jobs.map(async (jobRow) => {
      const template = jobRow.jobTemplateId ? templateMap.get(jobRow.jobTemplateId) : undefined
      const recurring = await ensureJobRecurring(jobRow, template)
      return [jobRow.id, recurring] as const
    }),
  )
  const recurringMap = new Map(recurringPairs)
  const occurrencePairs = await Promise.all(
    jobs.map(async (jobRow) => {
      const template = jobRow.jobTemplateId ? templateMap.get(jobRow.jobTemplateId) : undefined
      const occurrence = await getOrCreateOccurrenceForDate(
        jobRow,
        template,
        targetAt,
        recurringMap.get(jobRow.id) ?? null,
        false,
      )
      return [jobRow.id, occurrence] as const
    }),
  )
  const occurrenceMap = new Map(occurrencePairs)
  const occurrenceIds = Array.from(occurrenceMap.values())
    .filter((item): item is JobRecurringOccurrenceRow => item != null)
    .map(item => item.id)
  const reminderTasks = occurrenceIds.length
    ? await db.select().from(task).where(and(
        eq(task.userId, userId),
        inArray(task.sourceJobOccurrenceId, occurrenceIds),
      ))
    : []
  const reminderTaskCountMap = new Map<number, number>()
  for (const reminderTask of reminderTasks) {
    if (reminderTask.sourceJobOccurrenceId == null)
      continue
    reminderTaskCountMap.set(
      reminderTask.sourceJobOccurrenceId,
      (reminderTaskCountMap.get(reminderTask.sourceJobOccurrenceId) ?? 0) + 1,
    )
  }

  const pickJobForTemplate = (templateId: number): JobRow | null => {
    const templateJobs = jobsByTemplateId.get(templateId) ?? []
    return templateJobs.find(j => occurrenceMap.get(j.id)) ?? templateJobs[0] ?? null
  }

  const visibleItems = visibleTemplates
    .map((template) => {
      const jobRow = pickJobForTemplate(template.id)
      const occurrence = jobRow ? occurrenceMap.get(jobRow.id) : null
      if (jobRow && occurrence) {
        return toDisplayItem({
          itemType: 'USER_JOB',
          job: jobRow,
          template,
          occurrence,
          reminderTaskCount: reminderTaskCountMap.get(occurrence.id) ?? 0,
          taskTemplateMap,
          bankMap,
          reminderTemplateMap,
        })
      }
      return toDisplayItem({
        itemType: 'TEMPLATE_CANDIDATE',
        template,
        taskTemplateMap,
        bankMap,
        reminderTemplateMap,
      })
    })
    .filter((item): item is NonNullable<typeof item> => item != null)

  const hiddenUserItems = linkedTemplates
    .filter(template => !visibleTemplateMap.has(template.id))
    .map((template) => {
      const jobRow = pickJobForTemplate(template.id)
      if (!jobRow)
        return null
      const occurrence = occurrenceMap.get(jobRow.id)
      if (!occurrence)
        return null
      return toDisplayItem({
        itemType: 'USER_JOB',
        job: jobRow,
        template,
        occurrence,
        reminderTaskCount: reminderTaskCountMap.get(occurrence.id) ?? 0,
        taskTemplateMap,
        bankMap,
        reminderTemplateMap,
      })
    })
    .filter((item): item is NonNullable<typeof item> => item != null)

  return [...visibleItems, ...hiddenUserItems]
}

/** 月视图单条 VO（TEMPLATE_CANDIDATE 无 job/occurrence；USER_JOB 带周期与达标进度） */
function toDisplayItem(params: {
  itemType: JobDisplayItemType
  job?: JobRow
  template?: JobTemplateRow
  occurrence?: JobRecurringOccurrenceRow | null
  taskTemplateMap: Map<number, TaskTemplateRow>
  bankMap: Map<number, BankRow>
  reminderTemplateMap: Map<number, ReminderTemplateRow>
  reminderTaskCount?: number
}) {
  const { itemType, job, template, occurrence, taskTemplateMap, bankMap, reminderTemplateMap, reminderTaskCount = 0 } = params
  if (!template && !job)
    return null

  const bankId = job
    ? getJobBankId(job, template, taskTemplateMap)
    : template
      ? getTemplateBankId(template, taskTemplateMap)
      : null
  const bank = bankId ? bankMap.get(bankId) : null
  const repeatType = template?.repeatType ?? job?.repeatType ?? 'ONE_TIME'
  const title = job?.title ?? template?.title ?? ''
  const taskTemplateId = job?.taskTemplateId ?? template?.taskTemplateId ?? null
  const reminderTemplateId = template?.reminderTemplateId ?? null
  const reminderTemplate = reminderTemplateId != null
    ? reminderTemplateMap.get(reminderTemplateId) ?? null
    : null

  return {
    id: job ? `job:${job.id}` : `template:${template?.id}`,
    itemType,
    canAdd: itemType === 'TEMPLATE_CANDIDATE',
    jobId: job?.id ?? null,
    jobTemplateId: template?.id ?? job?.jobTemplateId ?? null,
    taskTemplateId,
    reminderTemplateId,
    title,
    repeatType,
    date: template?.date ? Number(template.date) : null,
    startDate: template?.startDate ? Number(template.startDate) : null,
    endDate: template?.endDate ? Number(template.endDate) : null,
    tiers: template?.tiers ?? [],
    rewardDescription: template?.rewardDescription ?? null,
    bank: bank ? { id: bank.id, name: bank.name, logo: bank.logo } : null,
    occurrenceId: occurrence?.id ?? null,
    occurrenceStartAt: occurrence?.occurrenceStartAt ? Number(occurrence.occurrenceStartAt) : null,
    occurrenceEndAt: occurrence?.occurrenceEndAt ? Number(occurrence.occurrenceEndAt) : null,
    rewardStartAt: occurrence?.rewardStartAt ? Number(occurrence.rewardStartAt) : null,
    rewardEndAt: occurrence?.rewardEndAt ? Number(occurrence.rewardEndAt) : null,
    progressAmount: Number(occurrence?.progressAmount ?? 0),
    progressCount: Number(occurrence?.progressCount ?? 0),
    status: occurrence?.status ?? job?.status ?? 'PENDING',
    reminderTaskCount,
    reminderScheduleLabel: buildReminderScheduleLabel(reminderTemplate),
    canCreateReminder: itemType === 'USER_JOB'
      && occurrence?.status === 'COMPLETED'
      && !!reminderTemplateId
      && reminderTaskCount === 0,
  }
}

/** 还款账期批量展示：按 subject 找 job，再按账期键找 occurrence，附提醒任务数 */
export async function getRepaymentJobDisplayItems(userId: number, body: any) {
  const inputs = normalizeRepaymentInputs(body?.items)
  if (inputs.length === 0)
    return []

  const jobs = await db.select().from(job).where(and(
    eq(job.userId, userId),
    eq(job.sourceType, 'REPAYMENT'),
    ne(job.status, 'ARCHIVED'),
  )).orderBy(asc(job.id))
  const jobMap = new Map(
    jobs.map(jobRow => [buildRepaymentSubjectKey(jobRow.subjectType as RepaymentSubjectType, jobRow.subjectId), jobRow]),
  )

  const occurrencePairs = await Promise.all(inputs.map(async (input) => {
    const jobRow = jobMap.get(buildRepaymentSubjectKey(input.subjectType, input.subjectId)) ?? null
    if (!jobRow)
      return [input.clientKey, { input, job: null, occurrence: null }] as const
    const cycleKey = buildRepaymentCycleKey(input)
    const [occurrence] = await db.select().from(jobRecurringOccurrence).where(and(
      eq(jobRecurringOccurrence.jobId, jobRow.id),
      eq(jobRecurringOccurrence.cycleKey, cycleKey),
    )).limit(1)
    return [input.clientKey, { input, job: jobRow, occurrence: occurrence ?? null }] as const
  }))

  const occurrenceIds = occurrencePairs
    .map(([, value]) => value.occurrence?.id)
    .filter((id): id is number => id != null)
  const reminderTasks = occurrenceIds.length
    ? await db.select().from(task).where(and(
        eq(task.userId, userId),
        inArray(task.sourceJobOccurrenceId, occurrenceIds),
      ))
    : []
  const reminderCountMap = new Map<number, number>()
  for (const reminderTask of reminderTasks) {
    if (reminderTask.sourceJobOccurrenceId == null)
      continue
    reminderCountMap.set(
      reminderTask.sourceJobOccurrenceId,
      (reminderCountMap.get(reminderTask.sourceJobOccurrenceId) ?? 0) + 1,
    )
  }

  return occurrencePairs.map(([, value]) => toRepaymentDisplayItem(
    value.input,
    value.job,
    value.occurrence,
    value.occurrence ? reminderCountMap.get(value.occurrence.id) ?? 0 : 0,
  ))
}

function toRepaymentDisplayItem(
  input: RepaymentInput,
  job: JobRow | null,
  occurrence: JobRecurringOccurrenceRow | null,
  reminderTaskCount: number,
) {
  return {
    clientKey: input.clientKey,
    jobId: job?.id ?? null,
    occurrenceId: occurrence?.id ?? null,
    occurrenceStartAt: occurrence?.occurrenceStartAt ? Number(occurrence.occurrenceStartAt) : input.statementAt,
    occurrenceEndAt: occurrence?.occurrenceEndAt ? Number(occurrence.occurrenceEndAt) : input.repaymentAt,
    progressAmount: Number(occurrence?.progressAmount ?? 0),
    progressCount: Number(occurrence?.progressCount ?? 0),
    reminderTaskCount,
    status: occurrence?.status ?? null,
  }
}

/** 还款账期 upsert：job（按 subject）+ job_recurring + 账期 occurrence 全部幂等（clientKey=账期键） */
export async function upsertRepaymentJobOccurrence(userId: number, body: any) {
  const input = normalizeRepaymentInput(body)
  if (!input)
    throw new Error('还款任务参数无效')
  await resolveRepaymentBankContext(userId, input.subjectType, input.subjectId)

  let [jobRow] = await db.select().from(job).where(and(
    eq(job.userId, userId),
    eq(job.sourceType, 'REPAYMENT'),
    eq(job.subjectType, input.subjectType),
    eq(job.subjectId, input.subjectId),
    ne(job.status, 'ARCHIVED'),
  )).orderBy(desc(job.id)).limit(1)

  let jobCreated = false
  if (!jobRow) {
    const [inserted] = await db.insert(job).values({
      userId,
      jobTemplateId: null,
      taskTemplateId: null,
      sourceType: 'REPAYMENT',
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      title: input.title,
      description: input.bankName ? `${input.bankName}信用卡还款任务` : '信用卡还款任务',
      repeatType: 'MONTHLY',
      status: 'IN_PROGRESS',
      createdAt: Date.now(),
      updatedAt: new Date(),
    }).$returningId()
    const [created] = await db.select().from(job).where(eq(job.id, Number(inserted.id))).limit(1)
    jobRow = created
    jobCreated = true
  }
  else if (input.title && input.title !== jobRow.title) {
    await db.update(job).set({ title: input.title, updatedAt: new Date() }).where(eq(job.id, jobRow.id))
    jobRow = { ...jobRow, title: input.title }
  }

  await ensureRepaymentJobRecurring(jobRow)
  const cycleKey = buildRepaymentCycleKey(input)
  let [occurrence] = await db.select().from(jobRecurringOccurrence).where(and(
    eq(jobRecurringOccurrence.jobId, jobRow.id),
    eq(jobRecurringOccurrence.cycleKey, cycleKey),
  )).limit(1)

  let occurrenceCreated = false
  if (!occurrence) {
    occurrenceCreated = true
    // 新账期：状态在插入前按“未完成 + 新还款日/金额”现算（对应旧实体字段先赋值后 save）
    const [inserted] = await db.insert(jobRecurringOccurrence).values({
      jobId: jobRow.id,
      cycleKey,
      occurrenceStartAt: input.statementAt,
      occurrenceEndAt: input.repaymentAt,
      rewardStartAt: null,
      rewardEndAt: null,
      progressAmount: String(input.progressAmount ?? 0),
      progressCount: 0,
      status: resolveRepaymentOccurrenceStatus({
        occurrenceEndAt: input.repaymentAt,
        progressAmount: input.progressAmount ?? 0,
      }),
      completedAt: null,
      createdAt: Date.now(),
      updatedAt: new Date(),
    }).$returningId()
    const [created] = await db.select().from(jobRecurringOccurrence).where(eq(jobRecurringOccurrence.id, Number(inserted.id))).limit(1)
    occurrence = created
  }
  else {
    const patch: Partial<typeof jobRecurringOccurrence.$inferInsert> = {
      occurrenceStartAt: input.statementAt,
      occurrenceEndAt: input.repaymentAt,
      updatedAt: new Date(),
    }
    if (input.progressAmount != null)
      patch.progressAmount = String(input.progressAmount)
    // 状态按更新后的还款日/金额重算（对应旧实体先改字段再 save）
    patch.status = resolveRepaymentOccurrenceStatus({
      status: occurrence.status,
      occurrenceEndAt: input.repaymentAt,
      progressAmount: input.progressAmount ?? occurrence.progressAmount,
    })
    await db.update(jobRecurringOccurrence).set(patch).where(eq(jobRecurringOccurrence.id, occurrence.id))
    const [updated] = await db.select().from(jobRecurringOccurrence).where(eq(jobRecurringOccurrence.id, occurrence.id)).limit(1)
    occurrence = updated
  }

  const [countRow] = await db.select({ c: count() }).from(task).where(and(
    eq(task.userId, userId),
    eq(task.sourceJobOccurrenceId, occurrence.id),
  ))
  const reminderTaskCount = Number(countRow?.c ?? 0)

  return {
    ...toRepaymentDisplayItem(input, jobRow, occurrence, reminderTaskCount),
    created: occurrenceCreated,
    jobCreated,
  }
}

/** 还款 job 账期提醒：一档（还款日当天）/ 多档（还款日前 N 天 ~ 后 N 天，每天一次） */
export async function createReminderTaskForRepaymentJobOccurrence(userId: number, jobId: number, body: any) {
  if (!Number.isFinite(jobId) || jobId <= 0) {
    throw new Error('job_id 无效')
  }
  const [jobRow] = await db.select().from(job).where(and(
    eq(job.id, jobId),
    eq(job.userId, userId),
    eq(job.sourceType, 'REPAYMENT'),
    ne(job.status, 'ARCHIVED'),
  )).limit(1)
  if (!jobRow)
    throw new Error('还款任务不存在')

  const occurrenceId = Number(body?.occurrenceId)
  if (!Number.isFinite(occurrenceId) || occurrenceId <= 0) {
    throw new Error('还款账期不存在')
  }
  const [occurrence] = await db.select().from(jobRecurringOccurrence).where(and(
    eq(jobRecurringOccurrence.id, occurrenceId),
    eq(jobRecurringOccurrence.jobId, jobRow.id),
  )).limit(1)
  if (!occurrence)
    throw new Error('还款账期不存在')

  const existingTasks = await db.select().from(task).where(and(
    eq(task.userId, userId),
    eq(task.sourceJobOccurrenceId, occurrence.id),
  ))
  if (existingTasks.length > 0) {
    return {
      created: false,
      createdCount: 0,
      existingCount: existingTasks.length,
      totalCount: existingTasks.length,
      taskIds: existingTasks.map(t => t.id),
    }
  }

  const context = await resolveRepaymentBankContext(
    userId,
    jobRow.subjectType as RepaymentSubjectType,
    jobRow.subjectId,
  )
  const reminderMode = body?.reminderMode === 'SINGLE' ? 'SINGLE' : 'MULTIPLE'
  const beforeDays = clampInteger(body?.beforeDays, 1, 3, 3)
  const afterDays = clampInteger(body?.afterDays, 1, 3, 3)
  const reminderTime = normalizeReminderTime(body?.reminderTime ?? '12:00')
  const repaymentAt = startOfDay(Number(occurrence.occurrenceEndAt))
  const rawStartDate = reminderMode === 'SINGLE'
    ? repaymentAt
    : addDays(repaymentAt, -beforeDays)
  const endDate = reminderMode === 'SINGLE'
    ? repaymentAt
    : addDays(repaymentAt, afterDays)
  const todayStart = startOfDay(Date.now())
  const todayReminderAt = applyReminderTime(todayStart, reminderTime)
  // 今天的提醒时刻已过 → 从明天开始（避免创建即过期）
  const earliestStartDate = Date.now() >= todayReminderAt
    ? addDays(todayStart, 1)
    : todayStart
  const startDate = reminderMode === 'SINGLE'
    ? rawStartDate
    : Math.max(rawStartDate, earliestStartDate)
  const isOneTime = reminderMode === 'SINGLE'
  if (!isOneTime && startDate > endDate) {
    throw new Error('当前账期已无可创建的未来提醒')
  }
  const title = `${jobRow.title}还款提醒`
  const description = [
    context.bankName ? `${context.bankName}信用卡还款提醒` : '信用卡还款提醒',
    `账单日 ${formatShortDate(Number(occurrence.occurrenceStartAt))}，还款日 ${formatShortDate(repaymentAt)}`,
    isOneTime
      ? `提醒时间 ${formatShortDate(startDate)} ${reminderTime}`
      : `提醒时间段 ${formatShortDate(startDate)} 至 ${formatShortDate(endDate)}，每天 ${reminderTime}`,
  ].join('。')

  const created = await createTask(userId, {
    title,
    description,
    repeatType: isOneTime ? 'ONE_TIME' : 'DAILY',
    date: isOneTime ? startDate : null,
    startDate: isOneTime ? null : startDate,
    endDate: isOneTime ? null : endDate,
    reminderTime,
    bankId: context.bankId,
    ...(context.bankCardId ? { bankCardId: context.bankCardId } : {}),
    benefitCategoryId: 7,
    kind: 'BILL_REMINDER',
    sourceJobId: jobRow.id,
    sourceJobOccurrenceId: occurrence.id,
    status: 'PENDING',
  })

  return {
    created: true,
    createdCount: 1,
    existingCount: 0,
    totalCount: 1,
    taskIds: [created.id],
  }
}

/** 从模板一键添加活动 job：建 job + job_recurring + 选中周期的 occurrence（幂等） */
export async function addJobFromTemplate(userId: number, templateId: number, selectedAt?: number) {
  if (!Number.isFinite(templateId) || templateId <= 0) {
    throw new Error('job_template_id 无效')
  }
  const targetAt = normalizeTsToMillis(selectedAt) ?? Date.now()

  const [template] = await db.select().from(jobTemplate).where(and(
    eq(jobTemplate.id, templateId),
    eq(jobTemplate.isVisible, 1),
  )).limit(1)
  if (!template) {
    throw new Error('Job 模板不存在或未上架')
  }
  if (!buildOccurrenceWindow(template, targetAt, null)) {
    throw new Error('选中日期不在 Job 模板周期内')
  }

  const [existing] = await db.select().from(job).where(and(
    eq(job.userId, userId),
    eq(job.sourceType, 'ACTIVITY'),
    eq(job.jobTemplateId, template.id),
    ne(job.status, 'ARCHIVED'),
  )).orderBy(desc(job.id)).limit(1)
  let jobRow: JobRow
  let jobCreated = false
  if (existing) {
    await ensureJobRecurring(existing, template)
    jobRow = existing
  }
  else {
    const [inserted] = await db.insert(job).values({
      userId,
      jobTemplateId: template.id,
      taskTemplateId: template.taskTemplateId ?? null,
      sourceType: 'ACTIVITY',
      subjectType: 'TASK_TEMPLATE',
      // 老模板可能还没反向关联 task_template，先用模板 id 占位，避免添加入口被数据迁移卡住。
      subjectId: template.taskTemplateId ?? template.id,
      title: template.title,
      description: template.description ?? null,
      repeatType: template.repeatType,
      status: 'IN_PROGRESS',
      createdAt: Date.now(),
      updatedAt: new Date(),
    }).$returningId()
    const [created] = await db.select().from(job).where(eq(job.id, Number(inserted.id))).limit(1)
    jobRow = created
    jobCreated = true
  }

  const recurring = await ensureJobRecurring(jobRow, template)
  const existingOccurrence = await getOrCreateOccurrenceForDate(
    jobRow,
    template,
    targetAt,
    recurring,
    false,
  )
  if (existingOccurrence) {
    return {
      id: jobRow.id,
      created: false,
      jobCreated,
      occurrenceId: existingOccurrence.id,
      cycleKey: existingOccurrence.cycleKey,
    }
  }

  const occurrence = await getOrCreateOccurrenceForDate(
    jobRow,
    template,
    targetAt,
    recurring,
    true,
  )
  if (!occurrence) {
    throw new Error('选中日期不在 Job 模板周期内')
  }
  return {
    id: jobRow.id,
    created: true,
    jobCreated,
    occurrenceId: occurrence.id,
    cycleKey: occurrence.cycleKey,
    occurrenceStartAt: Number(occurrence.occurrenceStartAt),
    occurrenceEndAt: Number(occurrence.occurrenceEndAt),
    rewardStartAt: occurrence.rewardStartAt ? Number(occurrence.rewardStartAt) : null,
    rewardEndAt: occurrence.rewardEndAt ? Number(occurrence.rewardEndAt) : null,
  }
}

/** 更新达标进度：金额/笔数 → 重新判定达标 → 达标时落权益窗口 */
export async function updateJobProgress(userId: number, jobId: number, body: any) {
  if (!Number.isFinite(jobId) || jobId <= 0) {
    throw new Error('job_id 无效')
  }

  const [jobRow] = await db.select().from(job).where(and(
    eq(job.id, jobId),
    eq(job.userId, userId),
    eq(job.sourceType, 'ACTIVITY'),
    ne(job.status, 'ARCHIVED'),
  )).limit(1)
  if (!jobRow) {
    throw new Error('Job 不存在')
  }

  const template = jobRow.jobTemplateId
    ? (await db.select().from(jobTemplate).where(eq(jobTemplate.id, jobRow.jobTemplateId)).limit(1))[0] ?? null
    : null
  const recurring = await ensureJobRecurring(jobRow, template)
  const occurrence = await getOrCreateOccurrenceForDate(
    jobRow,
    template,
    normalizeTsToMillis(body?.date) ?? Date.now(),
    recurring,
    false,
  )
  if (!occurrence) {
    throw new Error('请先添加当前周期的 Job')
  }

  const patch: Partial<typeof jobRecurringOccurrence.$inferInsert> = { updatedAt: new Date() }
  if (body?.progressAmount != null) {
    const amount = Number(body.progressAmount)
    patch.progressAmount = String(Number.isFinite(amount) && amount >= 0 ? amount : 0)
  }
  if (body?.progressCount != null) {
    const progressCount = Math.trunc(Number(body.progressCount))
    patch.progressCount = Number.isFinite(progressCount) && progressCount >= 0 ? progressCount : 0
  }

  const completed = isOccurrenceCompleted(template?.tiers, occurrence)
  patch.status = completed ? 'COMPLETED' : 'IN_PROGRESS'
  patch.completedAt = completed ? occurrence.completedAt ?? Date.now() : null

  if (completed) {
    const rewardWindow = ensureOccurrenceRewardWindow(template?.rewardWindowRule ?? null, occurrence)
    patch.rewardStartAt = rewardWindow?.startAt ?? occurrence.rewardStartAt ?? null
    patch.rewardEndAt = rewardWindow?.endAt ?? occurrence.rewardEndAt ?? null
  }

  await db.update(jobRecurringOccurrence).set(patch).where(eq(jobRecurringOccurrence.id, occurrence.id))
  const [saved] = await db.select().from(jobRecurringOccurrence).where(eq(jobRecurringOccurrence.id, occurrence.id)).limit(1)
  return {
    occurrenceId: saved.id,
    progressAmount: Number(saved.progressAmount ?? 0),
    progressCount: Number(saved.progressCount ?? 0),
    status: saved.status,
    rewardStartAt: saved.rewardStartAt ? Number(saved.rewardStartAt) : null,
    rewardEndAt: saved.rewardEndAt ? Number(saved.rewardEndAt) : null,
  }
}

/** 达标后提醒：按 reminder_template 在权益窗口内展开提醒任务（按日期去重、幂等） */
export async function createReminderTasksForJobOccurrence(userId: number, jobId: number, body: any) {
  if (!Number.isFinite(jobId) || jobId <= 0) {
    throw new Error('job_id 无效')
  }

  const [jobRow] = await db.select().from(job).where(and(
    eq(job.id, jobId),
    eq(job.userId, userId),
    eq(job.sourceType, 'ACTIVITY'),
    ne(job.status, 'ARCHIVED'),
  )).limit(1)
  if (!jobRow)
    throw new Error('Job 不存在')

  const template = jobRow.jobTemplateId
    ? (await db.select().from(jobTemplate).where(eq(jobTemplate.id, jobRow.jobTemplateId)).limit(1))[0] ?? null
    : null
  if (!template?.reminderTemplateId) {
    throw new Error('当前 Job 未绑定达标后提醒模板')
  }

  const recurring = await ensureJobRecurring(jobRow, template)
  const occurrence = await resolveUserOccurrence(jobRow, template, recurring, body)
  if (!occurrence)
    throw new Error('请先添加当前周期的 Job')
  if (occurrence.status !== 'COMPLETED')
    throw new Error('当前周期尚未达标')

  const [reminderTemplateRow] = await db.select().from(reminderTemplate).where(eq(reminderTemplate.id, template.reminderTemplateId)).limit(1)
  if (!reminderTemplateRow)
    throw new Error('提醒模板不存在')

  const rewardWindow = ensureOccurrenceRewardWindow(template.rewardWindowRule, occurrence)
  if (!rewardWindow)
    throw new Error('当前周期未配置可生成提醒的目标周期')
  if (occurrence.rewardStartAt == null || occurrence.rewardEndAt == null) {
    await db.update(jobRecurringOccurrence).set({
      rewardStartAt: rewardWindow.startAt,
      rewardEndAt: rewardWindow.endAt,
      updatedAt: new Date(),
    }).where(eq(jobRecurringOccurrence.id, occurrence.id))
  }

  const taskTemplateRow = template.taskTemplateId
    ? (await db.select().from(taskTemplate).where(eq(taskTemplate.id, template.taskTemplateId)).limit(1))[0] ?? null
    : null
  const reminderDates = expandReminderTemplateDates(reminderTemplateRow, rewardWindow)
  if (reminderDates.length === 0) {
    throw new Error('目标周期内没有可创建的提醒时间')
  }

  const existingTasks = await db.select().from(task).where(and(
    eq(task.userId, userId),
    eq(task.sourceJobOccurrenceId, occurrence.id),
    eq(task.reminderTemplateId, reminderTemplateRow.id),
  ))
  const existingDateSet = new Set(
    existingTasks
      .map(t => normalizeTsToMillis(t.date))
      .filter((value): value is number => value != null),
  )
  const achievedTier = getAchievedTier(template.tiers, occurrence)
  const taskTemplateTier = findTaskTemplateTier(taskTemplateRow?.tiers ?? null, achievedTier?.minAmount ?? null)

  const createdTasks: any[] = []
  for (const reminderAt of reminderDates) {
    if (existingDateSet.has(reminderAt))
      continue
    const created = await createTask(userId, {
      title: reminderTemplateRow.title,
      description: reminderTemplateRow.description ?? template.rewardDescription ?? template.description ?? jobRow.description,
      repeatType: 'ONE_TIME',
      date: reminderAt,
      reminderTime: normalizeReminderTime(reminderTemplateRow.reminderTime),
      kind: reminderTemplateRow.kind,
      taskTemplateId: template.taskTemplateId ?? null,
      reminderTemplateId: reminderTemplateRow.id,
      sourceJobId: jobRow.id,
      sourceJobOccurrenceId: occurrence.id,
      bankId: taskTemplateRow?.bankId != null ? String(taskTemplateRow.bankId) : null,
      bankCardType: taskTemplateRow?.bankCardType ?? null,
      bankCardLevel: taskTemplateRow?.bankCardLevel ?? null,
      benefitCategoryId: taskTemplateRow?.benefitCategoryId ?? null,
      benefitPayPlatformId: taskTemplateRow?.benefitPayPlatformId ?? null,
      minAmount: achievedTier?.minAmount ?? taskTemplateTier?.minAmount ?? null,
      benefitAmountFixed: taskTemplateTier?.benefitAmountFixed ?? null,
      benefitAmountMin: taskTemplateTier?.benefitAmountMin ?? null,
      benefitAmountMax: taskTemplateTier?.benefitAmountMax ?? null,
      benefitVoucherDescription: taskTemplateTier?.benefitDescription ?? template.rewardDescription ?? null,
      quotaPerCycleText: taskTemplateTier?.quotaPerCycleText ?? null,
      quotaTotalText: taskTemplateTier?.quotaTotalText ?? null,
      highPriority: reminderTemplateRow.kind === 'EXPIRY_REMINDER',
      advanceReminderMinutes: reminderTemplateRow.advanceReminderMinutes ?? 2,
      status: 'PENDING',
    })
    createdTasks.push(created)
    existingDateSet.add(reminderAt)
  }

  return {
    created: createdTasks.length > 0,
    createdCount: createdTasks.length,
    existingCount: existingTasks.length,
    totalCount: existingTasks.length + createdTasks.length,
    taskIds: [
      ...existingTasks.map(t => t.id),
      ...createdTasks.map(t => t.id),
    ],
    rewardStartAt: rewardWindow.startAt,
    rewardEndAt: rewardWindow.endAt,
  }
}

/** 删除某周期实例：级联删除派生提醒任务；周期删光时连带删 job_recurring 与 job */
export async function deleteJobOccurrence(userId: number, jobId: number, body: any) {
  if (!Number.isFinite(jobId) || jobId <= 0) {
    throw new Error('job_id 无效')
  }

  const [jobRow] = await db.select().from(job).where(and(
    eq(job.id, jobId),
    eq(job.userId, userId),
    eq(job.sourceType, 'ACTIVITY'),
    ne(job.status, 'ARCHIVED'),
  )).limit(1)
  if (!jobRow)
    throw new Error('Job 不存在')

  const template = jobRow.jobTemplateId
    ? (await db.select().from(jobTemplate).where(eq(jobTemplate.id, jobRow.jobTemplateId)).limit(1))[0] ?? null
    : null
  if (!template)
    throw new Error('Job 模板不存在')

  const recurring = await ensureJobRecurring(jobRow, template)
  const occurrence = await resolveUserOccurrence(jobRow, template, recurring, body)
  if (!occurrence)
    throw new Error('当前周期 Job 不存在')

  const derivedTasks = await db.select().from(task).where(and(
    eq(task.userId, userId),
    eq(task.sourceJobOccurrenceId, occurrence.id),
  ))
  for (const derivedTask of derivedTasks) {
    await deleteTask(userId, String(derivedTask.id))
  }

  await db.delete(jobRecurringOccurrence).where(and(
    eq(jobRecurringOccurrence.id, occurrence.id),
    eq(jobRecurringOccurrence.jobId, jobRow.id),
  ))

  const [remainingRow] = await db.select({ c: count() }).from(jobRecurringOccurrence).where(eq(jobRecurringOccurrence.jobId, jobRow.id))
  const remainingOccurrenceCount = Number(remainingRow?.c ?? 0)
  let jobDeleted = false
  if (remainingOccurrenceCount === 0) {
    await db.delete(jobRecurring).where(eq(jobRecurring.jobId, jobRow.id))
    await db.delete(job).where(and(
      eq(job.id, jobRow.id),
      eq(job.userId, userId),
    ))
    jobDeleted = true
  }

  return {
    deleted: true,
    occurrenceId: occurrence.id,
    deletedReminderTaskCount: derivedTasks.length,
    jobDeleted,
  }
}

// ---------- 还款域私有工具 ----------

/** 还款权限校验：BANK_CARD 校验卡归属；BANK 校验用户名下有该行的卡 */
async function resolveRepaymentBankContext(
  userId: number,
  subjectType: RepaymentSubjectType,
  subjectId: number,
): Promise<{ bankId: string, bankCardId: string | null, bankName: string | null }> {
  if (subjectType === 'BANK_CARD') {
    const [card] = await db.select().from(bankCard).where(and(
      eq(bankCard.id, subjectId),
      eq(bankCard.userId, userId),
    )).limit(1)
    if (!card)
      throw new Error('无权使用该银行卡')
    return {
      bankCardId: String(card.id),
      bankId: String(card.bankId),
      bankName: null,
    }
  }

  const bankId = String(subjectId)
  const [ownedCard] = await db.select().from(bankCard).where(and(
    eq(bankCard.userId, userId),
    eq(bankCard.bankId, bankId),
  )).limit(1)
  if (!ownedCard)
    throw new Error('无权使用该银行还款任务')
  return {
    bankCardId: null,
    bankId,
    bankName: null,
  }
}

/** 还款 job 固定 MONTHLY 循环规则；唯一键冲突时回读已插入的行 */
async function ensureRepaymentJobRecurring(jobRow: JobRow): Promise<JobRecurringRow> {
  const [existing] = await db.select().from(jobRecurring).where(eq(jobRecurring.jobId, jobRow.id)).limit(1)
  if (existing)
    return existing

  try {
    const [inserted] = await db.insert(jobRecurring).values({
      jobId: jobRow.id,
      repeatType: 'MONTHLY',
      daysOfWeek: null,
      daysOfMonth: null,
      yearlyMonths: null,
      yearlyDaysOfMonth: null,
      startDate: null,
      endDate: null,
      createdAt: Date.now(),
      updatedAt: new Date(),
    }).$returningId()
    const [row] = await db.select().from(jobRecurring).where(eq(jobRecurring.id, Number(inserted.id))).limit(1)
    return row
  }
  catch (e) {
    const [found] = await db.select().from(jobRecurring).where(eq(jobRecurring.jobId, jobRow.id)).limit(1)
    if (found)
      return found
    throw e
  }
}
