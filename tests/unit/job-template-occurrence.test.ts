import type { JobRewardWindowRule, JobTemplateTier, TaskTemplateTier } from '~/server/database/schema/task.ts'
// job-template 周期实例 / 权益窗口 / 达标判定纯函数单测：不触 db / 网络
// （service 模块顶层的 mysql 连接池是惰性的，import 不会建连）
import { describe, expect, it } from 'vitest'
import {
  applyReminderTime,
  buildOccurrenceWindow,
  buildReminderScheduleLabel,
  buildRepaymentCycleKey,
  buildRewardWindow,
  clampInteger,
  endOfMonth,
  ensureOccurrenceRewardWindow,
  expandReminderTemplateDates,
  findTaskTemplateTier,
  formatShortDate,
  getAchievedTier,
  getRecurringRepeatType,
  normalizeReminderTime,
  normalizeRepaymentInput,
  normalizeTsToMillis,
  parseNumberList,
  resolveRepaymentOccurrenceStatus,
  startOfWeek,
} from '~/server/utils/services/job-template.ts'

const DAY_MS = 86_400_000

function ts(year: number, month: number, day: number, h = 0, m = 0, s = 0, ms = 0): number {
  return new Date(year, month - 1, day, h, m, s, ms).getTime()
}

describe('normalizeTsToMillis', () => {
  it('passes millisecond values through unchanged', () => {
    expect(normalizeTsToMillis(ts(2026, 6, 1))).toBe(ts(2026, 6, 1))
    expect(normalizeTsToMillis('1751328000000')).toBe(1_751_328_000_000)
  })

  it('converts seconds (<1e11) to millis', () => {
    expect(normalizeTsToMillis(1_751_328_000)).toBe(1_751_328_000_000)
  })

  it('converts microseconds (>=1e14) to millis', () => {
    expect(normalizeTsToMillis(1_751_328_000_000_000)).toBe(1_751_328_000_000)
  })

  it('returns null for null/undefined/junk', () => {
    expect(normalizeTsToMillis(null)).toBeNull()
    expect(normalizeTsToMillis(undefined)).toBeNull()
    expect(normalizeTsToMillis('abc')).toBeNull()
    expect(normalizeTsToMillis(Number.NaN)).toBeNull()
  })
})

describe('buildOccurrenceWindow (cycle key computation)', () => {
  it('mONTHLY window spans the whole month with key M:YYYY-MM', () => {
    const window = buildOccurrenceWindow({ repeatType: 'MONTHLY' }, ts(2026, 6, 15))
    expect(window).toEqual({
      cycleKey: 'M:2026-06',
      startAt: ts(2026, 6, 1),
      endAt: endOfMonth(ts(2026, 6, 15)),
    })
    // 旧实现 endOfMonth 落在最后一天 0 点
    expect(window!.endAt).toBe(ts(2026, 6, 30))
  })

  it('wEEKLY window is Monday-based with key W:<monday YMD>', () => {
    // 2026-06-10 是周三 → 本周周一为 2026-06-08
    expect(new Date(ts(2026, 6, 10)).getDay()).toBe(3)
    const window = buildOccurrenceWindow({ repeatType: 'WEEKLY' }, ts(2026, 6, 10))
    expect(window!.cycleKey).toBe('W:2026-06-08')
    expect(window!.startAt).toBe(ts(2026, 6, 8))
    expect(window!.endAt).toBe(ts(2026, 6, 14))
    expect(startOfWeek(ts(2026, 6, 14))).toBe(ts(2026, 6, 8)) // 周日仍归上周一
  })

  it('dAILY uses key D:<YMD>, YEARLY uses Y:<year>', () => {
    expect(buildOccurrenceWindow({ repeatType: 'DAILY' }, ts(2026, 6, 10))!.cycleKey).toBe('D:2026-06-10')
    const yearly = buildOccurrenceWindow({ repeatType: 'YEARLY' }, ts(2026, 6, 10))
    expect(yearly!.cycleKey).toBe('Y:2026')
    expect(yearly!.startAt).toBe(ts(2026, 1, 1))
    expect(yearly!.endAt).toBe(ts(2026, 12, 31))
  })

  it('oNE_TIME anchors both ends on the template date with key ONCE:<start>:<end>', () => {
    const window = buildOccurrenceWindow(
      { repeatType: 'ONE_TIME', date: ts(2026, 6, 15, 9, 30) },
      ts(2026, 6, 15),
    )
    expect(window!.cycleKey).toBe('ONCE:2026-06-15:2026-06-15')
    expect(window!.startAt).toBe(ts(2026, 6, 15))
    expect(window!.endAt).toBe(ts(2026, 6, 15))
  })

  it('returns null when selected day is outside the template validity range', () => {
    const template = { repeatType: 'MONTHLY', startDate: ts(2026, 6, 1), endDate: ts(2026, 12, 31) }
    expect(buildOccurrenceWindow(template, ts(2026, 5, 31))).toBeNull()
    expect(buildOccurrenceWindow(template, ts(2027, 1, 1))).toBeNull()
    expect(buildOccurrenceWindow(template, ts(2026, 6, 15))).not.toBeNull()
  })

  it('clamps window edges to template validity range', () => {
    const template = { repeatType: 'MONTHLY', startDate: ts(2026, 6, 10), endDate: ts(2026, 6, 20) }
    const window = buildOccurrenceWindow(template, ts(2026, 6, 15))
    expect(window!.cycleKey).toBe('M:2026-06')
    expect(window!.startAt).toBe(ts(2026, 6, 10))
    expect(window!.endAt).toBe(ts(2026, 6, 20))
  })

  it('recurring rule overrides template validity and repeat type', () => {
    const window = buildOccurrenceWindow(
      { repeatType: 'MONTHLY', startDate: ts(2026, 1, 1), endDate: ts(2026, 12, 31) },
      ts(2026, 6, 15), // 2026-06-15 是周一
      { repeatType: 'WEEKLY', startDate: ts(2026, 6, 8), endDate: ts(2026, 6, 30) },
    )
    // 旧实现：cycleKey 取自窗口起点，再向 recurring.startDate 收拢但键不重算
    expect(window!.cycleKey).toBe('W:2026-06-15')
    expect(window!.startAt).toBe(ts(2026, 6, 15))
  })
})

describe('buildRewardWindow', () => {
  const june = { startAt: ts(2026, 6, 1), endAt: ts(2026, 6, 30) }

  it('returns null without a rule', () => {
    expect(buildRewardWindow(null, june, null)).toBeNull()
  })

  it('nEXT_MONTH lands in the following month with day bounds', () => {
    const rule: JobRewardWindowRule = { mode: 'NEXT_MONTH', startDay: 1, endDay: 10 }
    const window = buildRewardWindow(rule, june, null)
    expect(window!.startAt).toBe(ts(2026, 7, 1))
    expect(window!.endAt).toBe(ts(2026, 7, 10, 23, 59, 59, 999))
  })

  it('nEXT_MONTH rejects inverted day ranges and clamps to month length', () => {
    expect(buildRewardWindow({ mode: 'NEXT_MONTH', startDay: 15, endDay: 3 }, june, null)).toBeNull()
    // 7 月只有 31 天，startDay=32 收拢到 31
    const window = buildRewardWindow({ mode: 'NEXT_MONTH', startDay: 32, endDay: 32 }, june, null)
    expect(window!.startAt).toBe(ts(2026, 7, 31))
  })

  it('nEXT_WEEK starts at next Monday (weekStartsOn=1) and covers 7 days', () => {
    const window = buildRewardWindow({ mode: 'NEXT_WEEK', weekStartsOn: 1 }, { startAt: ts(2026, 6, 10), endAt: ts(2026, 6, 16) }, null)
    expect(window!.startAt).toBe(ts(2026, 6, 15)) // 下一个周一
    expect(window!.endAt).toBe(ts(2026, 6, 21, 23, 59, 59, 999))
  })

  it('aFTER_COMPLETION_DAYS needs completedAt and offsets from it', () => {
    expect(buildRewardWindow({ mode: 'AFTER_COMPLETION_DAYS', startOffsetDays: 2, durationDays: 3 }, june, null)).toBeNull()
    const window = buildRewardWindow(
      { mode: 'AFTER_COMPLETION_DAYS', startOffsetDays: 2, durationDays: 3 },
      june,
      ts(2026, 6, 10, 12),
    )
    expect(window!.startAt).toBe(ts(2026, 6, 12))
    expect(window!.endAt).toBe(ts(2026, 6, 14, 23, 59, 59, 999))
  })

  it('fIXED normalizes to day boundaries, null when incomplete', () => {
    expect(buildRewardWindow({ mode: 'FIXED', startAt: ts(2026, 7, 1) }, june, null)).toBeNull()
    const window = buildRewardWindow({ mode: 'FIXED', startAt: ts(2026, 7, 1, 5), endAt: ts(2026, 7, 31, 22) }, june, null)
    expect(window!.startAt).toBe(ts(2026, 7, 1))
    expect(window!.endAt).toBe(ts(2026, 7, 31, 23, 59, 59, 999))
  })
})

describe('ensureOccurrenceRewardWindow', () => {
  const rule: JobRewardWindowRule = { mode: 'NEXT_MONTH', startDay: 1, endDay: 10 }

  it('keeps the existing reward window when both ends are present', () => {
    const window = ensureOccurrenceRewardWindow(rule, {
      occurrenceStartAt: ts(2026, 6, 1),
      occurrenceEndAt: ts(2026, 6, 30),
      rewardStartAt: ts(2026, 8, 1),
      rewardEndAt: ts(2026, 8, 5),
      completedAt: null,
    })
    expect(window).toEqual({ startAt: ts(2026, 8, 1), endAt: ts(2026, 8, 5) })
  })

  it('recomputes from the rule when the occurrence has no reward window yet', () => {
    const window = ensureOccurrenceRewardWindow(rule, {
      occurrenceStartAt: ts(2026, 6, 1),
      occurrenceEndAt: ts(2026, 6, 30),
      rewardStartAt: null,
      rewardEndAt: null,
      completedAt: null,
    })
    expect(window).toEqual({ startAt: ts(2026, 7, 1), endAt: ts(2026, 7, 10, 23, 59, 59, 999) })
  })
})

describe('repayment keys and input normalization', () => {
  it('buildRepaymentCycleKey embeds subject and YMD dates', () => {
    expect(buildRepaymentCycleKey({
      subjectType: 'BANK',
      subjectId: 12,
      statementAt: ts(2026, 6, 1, 15),
      repaymentAt: ts(2026, 6, 20, 8),
    })).toBe('R:BANK:12:2026-06-01:2026-06-20')
  })

  it('normalizeRepaymentInput trims fields and snaps dates to day start', () => {
    const input = normalizeRepaymentInput({
      subjectType: 'BANK_CARD',
      subjectId: '7',
      title: '  招行还款  ',
      bankName: ' 招商银行 ',
      clientKey: ' ck-1 ',
      statementAt: ts(2026, 6, 1, 15),
      repaymentAt: ts(2026, 6, 20, 23),
      progressAmount: 1200.5,
    })
    expect(input).toMatchObject({
      clientKey: 'ck-1',
      subjectType: 'BANK_CARD',
      subjectId: 7,
      title: '招行还款',
      bankName: '招商银行',
      statementAt: ts(2026, 6, 1),
      repaymentAt: ts(2026, 6, 20),
      progressAmount: 1200.5,
    })
  })

  it('normalizeRepaymentInput derives clientKey from the cycle key when missing', () => {
    const input = normalizeRepaymentInput({
      subjectType: 'BANK',
      subjectId: 12,
      statementAt: ts(2026, 6, 1, 15),
      repaymentAt: ts(2026, 6, 20),
    })
    expect(input!.clientKey).toBe('R:BANK:12:2026-06-01:2026-06-20')
    expect(input!.title).toBe('信用卡还款')
  })

  it('normalizeRepaymentInput sanitizes progressAmount and rejects invalid rows', () => {
    expect(normalizeRepaymentInput({ subjectType: 'BANK', subjectId: 1, statementAt: ts(2026, 6, 1), repaymentAt: ts(2026, 6, 20), progressAmount: -5 })!.progressAmount).toBe(0)
    expect(normalizeRepaymentInput({ subjectType: 'BANK', subjectId: 1, statementAt: ts(2026, 6, 1), repaymentAt: ts(2026, 6, 20), progressAmount: Number.NaN })!.progressAmount).toBeNull()
    expect(normalizeRepaymentInput({ subjectType: 'WIDGET', subjectId: 1, statementAt: ts(2026, 6, 1), repaymentAt: ts(2026, 6, 20) })).toBeNull()
    expect(normalizeRepaymentInput({ subjectType: 'BANK', subjectId: 0, statementAt: ts(2026, 6, 1), repaymentAt: ts(2026, 6, 20) })).toBeNull()
    expect(normalizeRepaymentInput({ subjectType: 'BANK', subjectId: 1, repaymentAt: ts(2026, 6, 20) })).toBeNull()
    expect(normalizeRepaymentInput(null)).toBeNull()
  })

  it('resolveRepaymentOccurrenceStatus: COMPLETED wins, expiry beats progress', () => {
    expect(resolveRepaymentOccurrenceStatus({ status: 'COMPLETED', occurrenceEndAt: ts(2020, 1, 1) })).toBe('COMPLETED')
    expect(resolveRepaymentOccurrenceStatus({ occurrenceEndAt: ts(2020, 1, 1), progressAmount: '88.00' })).toBe('EXPIRED')
    expect(resolveRepaymentOccurrenceStatus({ occurrenceEndAt: ts(2099, 1, 1), progressAmount: '0.01' })).toBe('IN_PROGRESS')
    expect(resolveRepaymentOccurrenceStatus({ occurrenceEndAt: ts(2099, 1, 1), progressAmount: 0 })).toBe('PENDING')
  })
})

describe('tier matching (达标判定)', () => {
  const tiers: JobTemplateTier[] = [
    { logic: 'AND', minAmount: 100, minCount: 3, description: 'a' },
    { logic: 'OR', minAmount: 500, minCount: 5, description: 'b' },
  ]

  it('getAchievedTier evaluates AND/OR and picks the highest minAmount hit', () => {
    expect(getAchievedTier(tiers, { progressAmount: 100, progressCount: 3 })?.description).toBe('a')
    expect(getAchievedTier(tiers, { progressAmount: 600, progressCount: 1 })?.description).toBe('b')
    expect(getAchievedTier(tiers, { progressAmount: 100, progressCount: 2 })).toBeNull()
    expect(getAchievedTier(tiers, { progressAmount: 499, progressCount: 0 })).toBeNull()
  })

  it('getAchievedTier: OR tier with null minCount auto-passes the count leg (旧语义)', () => {
    const orTiers: JobTemplateTier[] = [{ logic: 'OR', minAmount: 500, minCount: null, description: 'c' }]
    expect(getAchievedTier(orTiers, { progressAmount: 100, progressCount: 0 })?.description).toBe('c')
  })

  it('getAchievedTier ignores no-threshold tiers and empty lists', () => {
    expect(getAchievedTier([{ logic: 'AND', minAmount: null, minCount: null, description: 'x' }], { progressAmount: 999, progressCount: 9 })).toBeNull()
    expect(getAchievedTier([], { progressAmount: 999, progressCount: 9 })).toBeNull()
    expect(getAchievedTier(null, { progressAmount: 999, progressCount: 9 })).toBeNull()
  })

  it('findTaskTemplateTier picks the largest tier within the achieved amount', () => {
    const taskTiers: TaskTemplateTier[] = [
      { minAmount: 10, benefitAmountFixed: 1, benefitAmountMin: null, benefitAmountMax: null, benefitDescription: 'low', quotaPerCycleText: null, quotaTotalText: null },
      { minAmount: 50, benefitAmountFixed: 5, benefitAmountMin: null, benefitAmountMax: null, benefitDescription: 'high', quotaPerCycleText: null, quotaTotalText: null },
    ]
    expect(findTaskTemplateTier(taskTiers, 30)?.benefitDescription).toBe('low')
    expect(findTaskTemplateTier(taskTiers, 50)?.benefitDescription).toBe('high')
    // 超过所有档 → 取 ≤ 金额的最大档（50）
    expect(findTaskTemplateTier(taskTiers, 999)?.benefitDescription).toBe('high')
    // 低于所有档 → 过滤结果为空，兜底第一档
    expect(findTaskTemplateTier(taskTiers, 5)?.benefitDescription).toBe('low')
    expect(findTaskTemplateTier(taskTiers, null)?.benefitDescription).toBe('low')
    expect(findTaskTemplateTier([], 30)).toBeNull()
  })
})

describe('getRecurringRepeatType', () => {
  it('template repeat type wins, then job, ONE_TIME yields null', () => {
    expect(getRecurringRepeatType({ repeatType: 'ONE_TIME' }, { repeatType: 'MONTHLY' })).toBe('MONTHLY')
    expect(getRecurringRepeatType({ repeatType: 'MONTHLY' }, undefined)).toBe('MONTHLY')
    // 旧语义 template?.repeatType ?? job.repeatType：模板显式 ONE_TIME 会覆盖 job 的 MONTHLY
    expect(getRecurringRepeatType({ repeatType: 'MONTHLY' }, { repeatType: 'ONE_TIME' })).toBeNull()
    expect(getRecurringRepeatType({ repeatType: 'ONE_TIME' }, undefined)).toBeNull()
    expect(getRecurringRepeatType({ repeatType: 'ONE_TIME' }, {})).toBeNull()
  })
})

describe('expandReminderTemplateDates', () => {
  const window = { startAt: ts(2026, 6, 1), endAt: ts(2026, 6, 30) }

  it('oNE_TIME expands the anchor date only when inside the window', () => {
    expect(expandReminderTemplateDates({ repeatType: 'ONE_TIME', date: ts(2026, 6, 15, 6), reminderTime: '09:00' }, window))
      .toEqual([ts(2026, 6, 15, 9)])
    expect(expandReminderTemplateDates({ repeatType: 'ONE_TIME', date: ts(2026, 7, 15), reminderTime: '09:00' }, window))
      .toEqual([])
  })

  it('dAILY expands every day in the window at reminder time', () => {
    // 旧语义：窗口边界按原值比较（endDate 当天 0 点），最后一天 08:30 > 0 点被排除
    const dates = expandReminderTemplateDates(
      { repeatType: 'DAILY', reminderTime: '08:30', startDate: ts(2026, 6, 5), endDate: ts(2026, 6, 7) },
      window,
    )
    expect(dates).toEqual([ts(2026, 6, 5, 8, 30), ts(2026, 6, 6, 8, 30)])
    // endDate 推到次日 0 点 → 最后一天重新入窗
    const withNextDay = expandReminderTemplateDates(
      { repeatType: 'DAILY', reminderTime: '08:30', startDate: ts(2026, 6, 5), endDate: ts(2026, 6, 8) },
      window,
    )
    expect(withNextDay).toEqual([ts(2026, 6, 5, 8, 30), ts(2026, 6, 6, 8, 30), ts(2026, 6, 7, 8, 30)])
  })

  it('wEEKLY filters by ISO daysOfWeek (1=周一 … 7=周日)', () => {
    // endDate 推到 6-15 0 点，保证 6-14（周日）09:00 仍在窗口内（旧语义按原值比较）
    const dates = expandReminderTemplateDates(
      { repeatType: 'WEEKLY', daysOfWeek: '[1,7]', reminderTime: '09:00', startDate: ts(2026, 6, 8), endDate: ts(2026, 6, 15) },
      window,
    )
    expect(dates).toEqual([ts(2026, 6, 8, 9), ts(2026, 6, 14, 9)])
  })

  it('mONTHLY uses daysOfMonth, falling back to the template date day-of-month', () => {
    const dates = expandReminderTemplateDates(
      { repeatType: 'MONTHLY', daysOfMonth: '[15]', reminderTime: '10:00', startDate: ts(2026, 6, 1), endDate: ts(2026, 7, 31) },
      { startAt: ts(2026, 6, 1), endAt: ts(2026, 7, 31) },
    )
    expect(dates).toEqual([ts(2026, 6, 15, 10), ts(2026, 7, 15, 10)])

    const fallback = expandReminderTemplateDates(
      { repeatType: 'MONTHLY', daysOfMonth: null, date: ts(2026, 3, 20), reminderTime: '10:00', startDate: ts(2026, 6, 1), endDate: ts(2026, 6, 30) },
      window,
    )
    expect(fallback).toEqual([ts(2026, 6, 20, 10)])
  })

  it('returns empty when the window collapses below one day', () => {
    expect(expandReminderTemplateDates(
      { repeatType: 'DAILY', reminderTime: '09:00', startDate: ts(2026, 7, 1), endDate: ts(2026, 7, 31) },
      window,
    )).toEqual([])
  })
})

describe('reminder time helpers and labels', () => {
  it('normalizeReminderTime pads and clamps, defaulting to 09:00', () => {
    expect(normalizeReminderTime(null)).toBe('09:00')
    expect(normalizeReminderTime('9:5')).toBe('09:05')
    expect(normalizeReminderTime('25:99')).toBe('23:59')
    expect(normalizeReminderTime('12:30:45')).toBe('12:30')
  })

  it('applyReminderTime combines day start with HH:mm(:ss)', () => {
    expect(applyReminderTime(ts(2026, 6, 10, 18), '08:30')).toBe(ts(2026, 6, 10, 8, 30))
    expect(applyReminderTime(ts(2026, 6, 10), '07:05:09')).toBe(ts(2026, 6, 10, 7, 5, 9))
  })

  it('parseNumberList accepts JSON arrays and bare comma lists', () => {
    expect(parseNumberList('[1,2,3]')).toEqual([1, 2, 3])
    expect(parseNumberList('1,2')).toEqual([1, 2])
    expect(parseNumberList('["a",2]')).toEqual([2])
    expect(parseNumberList(null)).toEqual([])
    expect(parseNumberList('abc')).toEqual([])
  })

  it('clampInteger truncates and clamps, junk falls back', () => {
    expect(clampInteger(5, 1, 3, 3)).toBe(3)
    expect(clampInteger(0, 1, 3, 3)).toBe(1)
    expect(clampInteger('2', 1, 3, 3)).toBe(2)
    expect(clampInteger(2.9, 1, 3, 3)).toBe(2)
    expect(clampInteger('abc', 1, 3, 3)).toBe(3)
  })

  it('formatShortDate renders M/D', () => {
    expect(formatShortDate(ts(2026, 6, 5))).toBe('6/5')
    expect(formatShortDate(ts(2026, 12, 31))).toBe('12/31')
  })

  it('buildReminderScheduleLabel renders Chinese cadence text', () => {
    expect(buildReminderScheduleLabel(null)).toBeNull()
    expect(buildReminderScheduleLabel({ repeatType: 'DAILY', reminderTime: '08:00' })).toBe('每天 08:00')
    expect(buildReminderScheduleLabel({ repeatType: 'WEEKLY', daysOfWeek: '[1,7]', reminderTime: '08:00' })).toBe('每周一、日 08:00')
    expect(buildReminderScheduleLabel({ repeatType: 'MONTHLY', daysOfMonth: '[1,15]', reminderTime: '12:00' })).toBe('每月1、15日 12:00')
    expect(buildReminderScheduleLabel({ repeatType: 'MONTHLY', daysOfMonth: null, reminderTime: '12:00' })).toBe('每月指定日期 12:00')
    expect(buildReminderScheduleLabel({ repeatType: 'YEARLY', yearlyMonths: '[1]', yearlyDaysOfMonth: '[1]', reminderTime: '08:00' })).toBe('每年1月1日 08:00')
    expect(buildReminderScheduleLabel({ repeatType: 'YEARLY', yearlyMonths: null, yearlyDaysOfMonth: null, reminderTime: '08:00' })).toBe('每年 08:00')
    expect(buildReminderScheduleLabel({ repeatType: 'ONE_TIME', reminderTime: '08:00' })).toBe('指定时间 08:00')
  })
})

describe('occurrence window sanity across repeat types', () => {
  it('every window contains the selected day for recurring types', () => {
    for (const repeatType of ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const) {
      const window = buildOccurrenceWindow({ repeatType }, ts(2026, 6, 15, 12))
      expect(window).not.toBeNull()
      expect(window!.startAt).toBeLessThanOrEqual(ts(2026, 6, 15))
      expect(window!.endAt).toBeGreaterThanOrEqual(ts(2026, 6, 15))
    }
    // 一天的窗口跨度为 1 天（旧语义：DAILY 起止同为当天 0 点）
    const daily = buildOccurrenceWindow({ repeatType: 'DAILY' }, ts(2026, 6, 15))
    expect(daily!.endAt - daily!.startAt).toBe(0)
    const weekly = buildOccurrenceWindow({ repeatType: 'WEEKLY' }, ts(2026, 6, 15))
    expect(weekly!.endAt - weekly!.startAt).toBe(6 * DAY_MS)
  })
})
