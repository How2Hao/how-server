// 任务循环展开纯函数单测：不触 db / 网络（service 模块顶层的 mysql 连接池是惰性的，import 不会建连）
import { describe, expect, it } from 'vitest'
import {
  buildMonthDays,
  compareTasksForTimeline,
  endOfDay,
  formatMonthDay,
  getMonthEnd,
  getMonthStart,
  getOccurrenceDaysInMonth,
  getTodayStart,
  normalizeTimestampToMillis,
  parseJsonArray,
  startOfDay,
  stringifyArray,
} from '~/server/utils/services/task.ts'

const DAY_MS = 86_400_000

function ts(year: number, month: number, day: number, h = 0, m = 0, s = 0, ms = 0): number {
  return new Date(year, month - 1, day, h, m, s, ms).getTime()
}

describe('day boundary math', () => {
  it('startOfDay / endOfDay keep the same local calendar day', () => {
    const noon = ts(2026, 9, 30, 12, 34)
    expect(startOfDay(noon)).toBe(ts(2026, 9, 30))
    expect(endOfDay(noon)).toBe(ts(2026, 9, 30, 23, 59, 59, 0))
  })

  it('getMonthStart / getMonthEnd handle 30-day months', () => {
    expect(getMonthStart(2026, 9)).toBe(ts(2026, 9, 1))
    expect(getMonthEnd(2026, 9)).toBe(ts(2026, 9, 30, 23, 59, 59, 999))
  })

  it('getMonthEnd handles leap and non-leap February', () => {
    expect(getMonthEnd(2024, 2)).toBe(ts(2024, 2, 29, 23, 59, 59, 999))
    expect(getMonthEnd(2023, 2)).toBe(ts(2023, 2, 28, 23, 59, 59, 999))
  })

  it('buildMonthDays yields one entry per day of the month', () => {
    const days = buildMonthDays(2026, 2)
    expect(days).toHaveLength(28)
    expect(days[0].getTime()).toBe(ts(2026, 2, 1))
    expect(days[27].getTime()).toBe(ts(2026, 2, 28))
    expect(buildMonthDays(2024, 2)).toHaveLength(29)
  })

  it('formatMonthDay pads month and day', () => {
    expect(formatMonthDay(ts(2026, 9, 30))).toBe('2026-09-30')
    expect(formatMonthDay(ts(2026, 1, 5))).toBe('2026-01-05')
  })

  it('getTodayStart is midnight of the current day', () => {
    const now = new Date()
    expect(getTodayStart()).toBe(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime())
  })

  it('normalizeTimestampToMillis accepts numbers and numeric strings, rejects junk', () => {
    expect(normalizeTimestampToMillis('123')).toBe(123)
    expect(normalizeTimestampToMillis(456)).toBe(456)
    expect(normalizeTimestampToMillis(null)).toBeNull()
    expect(normalizeTimestampToMillis('')).toBeNull()
    expect(normalizeTimestampToMillis('abc')).toBeNull()
  })
})

describe('parseJsonArray / stringifyArray', () => {
  it('parses JSON array strings into numbers', () => {
    expect(parseJsonArray('[1,2,3]')).toEqual([1, 2, 3])
    expect(parseJsonArray('["1","2"]')).toEqual([1, 2])
  })

  it('returns [] for null, junk or non-array JSON', () => {
    expect(parseJsonArray(null)).toEqual([])
    expect(parseJsonArray('not json')).toEqual([])
    expect(parseJsonArray('{"a":1}')).toEqual([])
  })

  it('stringifyArray serializes arrays and returns null otherwise', () => {
    expect(stringifyArray([1, 2])).toBe('[1,2]')
    expect(stringifyArray('1,2')).toBeNull()
    expect(stringifyArray(undefined)).toBeNull()
  })
})

describe('getOccurrenceDaysInMonth', () => {
  const monthStart = getMonthStart(2026, 9)
  const monthEnd = getMonthEnd(2026, 9)
  const lastDay = 30
  const base = { daysOfWeek: null, daysOfMonth: null, yearlyMonths: null, yearlyDaysOfMonth: null, startDate: null, endDate: null }

  it('oNE_TIME inside the month returns its day; outside returns []', () => {
    const taskDto = { repeatType: 'ONE_TIME', date: ts(2026, 9, 15, 8, 30) }
    expect(getOccurrenceDaysInMonth(taskDto, null, 2026, 9, monthStart, monthEnd, lastDay))
      .toEqual([ts(2026, 9, 15)])
    const otherMonth = { repeatType: 'ONE_TIME', date: ts(2026, 10, 15) }
    expect(getOccurrenceDaysInMonth(otherMonth, null, 2026, 9, monthStart, monthEnd, lastDay)).toEqual([])
    const noDate = { repeatType: 'ONE_TIME', date: null }
    expect(getOccurrenceDaysInMonth(noDate, null, 2026, 9, monthStart, monthEnd, lastDay)).toEqual([])
  })

  it('dAILY covers the whole month and clips to startDate/endDate', () => {
    const all = getOccurrenceDaysInMonth({ repeatType: 'DAILY', date: null }, { ...base, repeatType: 'DAILY', startDate: null, endDate: null }, 2026, 9, monthStart, monthEnd, lastDay)
    expect(all).toHaveLength(30)
    expect(all[0]).toBe(ts(2026, 9, 1))

    // endDate 截断：deleteFuture 把规则 endDate 提前到 9/9 前一天 → 9/9 起不再发生
    const clipped = getOccurrenceDaysInMonth(
      { repeatType: 'DAILY', date: null },
      { ...base, repeatType: 'DAILY', startDate: ts(2026, 9, 5), endDate: ts(2026, 9, 9) },
      2026,
      9,
      monthStart,
      monthEnd,
      lastDay,
    )
    expect(clipped).toEqual([5, 6, 7, 8, 9].map(d => ts(2026, 9, d)))
  })

  it('wEEKLY matches daysOfWeek (1=Monday … 7=Sunday) and empty list means every day', () => {
    const recurring = { ...base, repeatType: 'WEEKLY', daysOfWeek: '[1]' }
    const mondays = getOccurrenceDaysInMonth({ repeatType: 'WEEKLY' }, recurring, 2026, 9, monthStart, monthEnd, lastDay)
    const expectedMondays: number[] = []
    for (let d = 1; d <= 30; d++) {
      // getDay(): 0=Sunday → composeDay 7
      if (new Date(2026, 8, d).getDay() === 1)
        expectedMondays.push(ts(2026, 9, d))
    }
    expect(mondays).toEqual(expectedMondays)
    expect(expectedMondays.length).toBeGreaterThan(0)

    const sundays = getOccurrenceDaysInMonth({ repeatType: 'WEEKLY' }, { ...recurring, daysOfWeek: '[7]' }, 2026, 9, monthStart, monthEnd, lastDay)
    for (const day of sundays) expect(new Date(day).getDay()).toBe(0)

    const everyDay = getOccurrenceDaysInMonth({ repeatType: 'WEEKLY' }, { ...recurring, daysOfWeek: null }, 2026, 9, monthStart, monthEnd, lastDay)
    expect(everyDay).toHaveLength(30)
  })

  it('mONTHLY uses daysOfMonth, skips days beyond month end, defaults to day 1', () => {
    const recurring = { ...base, repeatType: 'MONTHLY', daysOfMonth: '[15,31]' }
    // 9 月只有 30 天 → 31 被跳过
    expect(getOccurrenceDaysInMonth({ repeatType: 'MONTHLY' }, recurring, 2026, 9, monthStart, monthEnd, lastDay))
      .toEqual([ts(2026, 9, 15)])

    const recurring31 = { ...base, repeatType: 'MONTHLY', daysOfMonth: '[31]' }
    expect(getOccurrenceDaysInMonth({ repeatType: 'MONTHLY' }, recurring31, 2026, 9, monthStart, monthEnd, lastDay)).toEqual([])

    const empty = { ...base, repeatType: 'MONTHLY', daysOfMonth: null }
    expect(getOccurrenceDaysInMonth({ repeatType: 'MONTHLY' }, empty, 2026, 9, monthStart, monthEnd, lastDay))
      .toEqual([ts(2026, 9, 1)])
  })

  it('yEARLY filters by yearlyMonths and yearlyDaysOfMonth with defaults', () => {
    const inMonth = { ...base, repeatType: 'YEARLY', yearlyMonths: '[9,12]', yearlyDaysOfMonth: '[20]' }
    expect(getOccurrenceDaysInMonth({ repeatType: 'YEARLY' }, inMonth, 2026, 9, monthStart, monthEnd, lastDay))
      .toEqual([ts(2026, 9, 20)])

    const otherMonth = { ...base, repeatType: 'YEARLY', yearlyMonths: '[12]', yearlyDaysOfMonth: '[20]' }
    expect(getOccurrenceDaysInMonth({ repeatType: 'YEARLY' }, otherMonth, 2026, 9, monthStart, monthEnd, lastDay)).toEqual([])

    // 未配月份 → 默认当月；未配日期 → 默认 1 号
    const defaults = { ...base, repeatType: 'YEARLY', yearlyMonths: null, yearlyDaysOfMonth: null }
    expect(getOccurrenceDaysInMonth({ repeatType: 'YEARLY' }, defaults, 2026, 9, monthStart, monthEnd, lastDay))
      .toEqual([ts(2026, 9, 1)])
  })

  it('unknown repeatType yields no occurrences', () => {
    expect(getOccurrenceDaysInMonth({ repeatType: 'WEIRD' }, null, 2026, 9, monthStart, monthEnd, lastDay)).toEqual([])
  })

  it('recurring source wins over task fields but keeps task.date as ONE_TIME fallback', () => {
    // 循环任务 task.date 存 startDate：recurring 存在时以 recurring.startDate/endDate 为准
    const taskDto = { repeatType: 'DAILY', date: ts(2026, 9, 10) }
    const recurring = { ...base, repeatType: 'DAILY', startDate: ts(2026, 9, 20), endDate: null }
    const days = getOccurrenceDaysInMonth(taskDto, recurring, 2026, 9, monthStart, monthEnd, lastDay)
    expect(days[0]).toBe(ts(2026, 9, 20))
    expect(days).toHaveLength(11) // 9/20 – 9/30
  })
})

describe('compareTasksForTimeline', () => {
  it('sorts by reminderTime with missing time last (99:99)', () => {
    const a = { reminderTime: '08:00' }
    const b = { reminderTime: '12:30' }
    const noTime = {}
    expect(compareTasksForTimeline(a, b)).toBeLessThan(0)
    expect(compareTasksForTimeline(b, a)).toBeGreaterThan(0)
    expect(compareTasksForTimeline(a, noTime)).toBeLessThan(0)
  })

  it('eXPIRY_REMINDER sorts by expireAt HH:mm and ranks after equal keys', () => {
    const expiry = { kind: 'EXPIRY_REMINDER', expireAt: ts(2026, 9, 30, 23, 59) }
    const reminder = { reminderTime: '23:59' }
    // 相同 HH:mm → EXPIRY_REMINDER 靠后
    expect(compareTasksForTimeline(expiry, reminder)).toBeGreaterThan(0)
    const earlyExpiry = { kind: 'EXPIRY_REMINDER', expireAt: ts(2026, 9, 30, 9, 0) }
    expect(compareTasksForTimeline(earlyExpiry, expiry)).toBeLessThan(0)
  })

  it('eXPIRY_REMINDER without expireAt falls back to 23:59', () => {
    const expiry = { kind: 'EXPIRY_REMINDER', expireAt: null }
    const reminder = { reminderTime: '23:59' }
    expect(compareTasksForTimeline(expiry, reminder)).toBeGreaterThan(0) // 同 23:59，EXPIRY 靠后
    const later = { reminderTime: undefined }
    expect(compareTasksForTimeline(expiry, later)).toBeLessThan(0)
  })
})

describe('occurrence timestamps are stable across a DST-like day', () => {
  it('startOfDay of consecutive ms timestamps lands on consecutive days', () => {
    const d1 = startOfDay(ts(2026, 9, 30, 23, 59, 59, 999))
    const d2 = startOfDay(d1 + DAY_MS)
    expect(d2 - d1).toBe(ts(2026, 10, 1) - ts(2026, 9, 30))
  })
})
