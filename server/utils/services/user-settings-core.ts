// 用户设置纯逻辑：schema v1 默认值、入参校验（normalize）、深合并（merge）、
// 归属清洗（sanitize）。与 DB 解耦，便于单测；DB 读写见 user-settings.ts。
// 移植自旧 how-api UserSettingsService 的私有方法，错误文案保持一致。

export type FinanceColorMode = 'red-up' | 'green-up'
export type DefaultTransactionType = 'INCOME' | 'EXPENSE'
export type PlazaQuickFilter = 'ALL' | 'CAN_ADD' | 'BENEFIT_TYPE' | 'ACTIVITY_TYPE'
export type PlazaSortBy = 'HOT' | 'LATEST' | 'MATCH'
/**
 * 广场默认模式：
 *  - FOLLOWED：进入时自动按 regionCodes=[100000, defaultRegionCode] + bankIds=[用户卡所属银行] 过滤
 *  - ALL：不下发受众过滤，展示全平台所有任务
 * 切换由 PlazaModeTabs 控制，立即持久化到此字段
 */
export type PlazaDefaultMode = 'FOLLOWED' | 'ALL'

export interface AppUserSettings {
  schemaVersion: 1
  cardPack: {
    showBillManagement: boolean
    showInterestFreeTips: boolean
    showAnnualFeeReminder: boolean
    showGroupedCards: boolean
  }
  finance: {
    amountColorMode: FinanceColorMode
    defaultLedgerId: number | null
    defaultTransactionType: DefaultTransactionType
    defaultAccUserByLedger: Record<string, number | null>
  }
  plaza: {
    defaultQuickFilter: PlazaQuickFilter
    rememberAdvancedFilters: boolean
    defaultRegionCode: string | null
    defaultSortBy: PlazaSortBy
    defaultMode: PlazaDefaultMode
  }
  // 推送通知统一在此命名空间。原 task.reminderEnabled 已迁移到 typeTaskReminder。
  notification: {
    masterEnabled: boolean // 总开关：关 → 仅写 inbox 不推 APNs
    typeActivity: boolean // 活动推送
    typeAnnouncement: boolean // 系统公告
    typeFeedbackReply: boolean // 反馈被回复
    typeTaskReminder: boolean // 任务到期本地提醒（原 task.reminderEnabled）
  }
}

/** 深度部分补丁：各级命名空间内只允许出现的键（深合并语义对应类型） */
export type AppUserSettingsPatch = {
  [K in keyof AppUserSettings]?: Partial<AppUserSettings[K]>
}

const DEFAULT_SETTINGS: AppUserSettings = {
  schemaVersion: 1,
  cardPack: {
    showBillManagement: true,
    showInterestFreeTips: true,
    showAnnualFeeReminder: true,
    showGroupedCards: true,
  },
  finance: {
    amountColorMode: 'red-up',
    defaultLedgerId: null,
    defaultTransactionType: 'INCOME',
    defaultAccUserByLedger: {},
  },
  plaza: {
    defaultQuickFilter: 'ALL',
    rememberAdvancedFilters: true,
    defaultRegionCode: null,
    defaultSortBy: 'HOT',
    defaultMode: 'FOLLOWED',
  },
  notification: {
    masterEnabled: true,
    typeActivity: true,
    typeAnnouncement: true,
    typeFeedbackReply: true,
    typeTaskReminder: true,
  },
}

/** 深拷贝一份 schema v1 默认设置（每次调用产生新对象，互不影响） */
export function cloneDefaultSettings(): AppUserSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppUserSettings
}

function isPlainObject(input: unknown): input is Record<string, any> {
  return Object.prototype.toString.call(input) === '[object Object]'
}

function hasOwn(obj: Record<string, any>, key: string): boolean {
  return Object.hasOwn(obj, key)
}

/**
 * 校验并抽取设置补丁：strict=true（客户端 PATCH）时未知字段/非法取值直接抛错；
 * strict=false（读取 DB 存量数据）时静默丢弃非法部分。
 * 旧字段 task.reminderEnabled 向后兼容：自动迁移为 notification.typeTaskReminder。
 */
export function normalizeSettingsInput(input: unknown, strict: boolean): AppUserSettingsPatch {
  if (!isPlainObject(input)) {
    if (strict)
      throw new Error('settings payload 必须是对象')
    return {}
  }

  // task 不在新结构里，但向后兼容：旧客户端 / 旧 DB 数据带 task 时也接受，
  // reminderEnabled 自动迁移到 notification.typeTaskReminder
  const rootAllowed = new Set(['schemaVersion', 'cardPack', 'finance', 'task', 'plaza', 'notification'])
  if (strict) {
    Object.keys(input).forEach((k) => {
      if (!rootAllowed.has(k))
        throw new Error(`不支持的设置字段: ${k}`)
    })
  }

  const patch: AppUserSettingsPatch = {}

  if (hasOwn(input, 'schemaVersion')) {
    const v = input.schemaVersion
    if (v !== 1) {
      if (strict)
        throw new Error('schemaVersion 仅支持 1')
    }
    else {
      patch.schemaVersion = 1
    }
  }

  if (hasOwn(input, 'cardPack')) {
    const value = input.cardPack
    if (!isPlainObject(value)) {
      if (strict)
        throw new Error('cardPack 必须是对象')
    }
    else {
      const allowed = new Set(['showBillManagement', 'showInterestFreeTips', 'showAnnualFeeReminder', 'showGroupedCards'])
      if (strict) {
        Object.keys(value).forEach((k) => {
          if (!allowed.has(k))
            throw new Error(`不支持的 cardPack 字段: ${k}`)
        })
      }
      const cardPack: Partial<AppUserSettings['cardPack']> = {}
      if (hasOwn(value, 'showBillManagement'))
        cardPack.showBillManagement = requireBoolean(value.showBillManagement, 'cardPack.showBillManagement')
      if (hasOwn(value, 'showInterestFreeTips'))
        cardPack.showInterestFreeTips = requireBoolean(value.showInterestFreeTips, 'cardPack.showInterestFreeTips')
      if (hasOwn(value, 'showAnnualFeeReminder'))
        cardPack.showAnnualFeeReminder = requireBoolean(value.showAnnualFeeReminder, 'cardPack.showAnnualFeeReminder')
      if (hasOwn(value, 'showGroupedCards'))
        cardPack.showGroupedCards = requireBoolean(value.showGroupedCards, 'cardPack.showGroupedCards')
      patch.cardPack = cardPack as AppUserSettings['cardPack']
    }
  }

  if (hasOwn(input, 'finance')) {
    const value = input.finance
    if (!isPlainObject(value)) {
      if (strict)
        throw new Error('finance 必须是对象')
    }
    else {
      const allowed = new Set(['amountColorMode', 'defaultLedgerId', 'defaultTransactionType', 'defaultAccUserByLedger'])
      if (strict) {
        Object.keys(value).forEach((k) => {
          if (!allowed.has(k))
            throw new Error(`不支持的 finance 字段: ${k}`)
        })
      }

      const finance: Partial<AppUserSettings['finance']> = {}
      if (hasOwn(value, 'amountColorMode')) {
        finance.amountColorMode = requireEnum(value.amountColorMode, ['red-up', 'green-up'], 'finance.amountColorMode') as FinanceColorMode
      }
      if (hasOwn(value, 'defaultLedgerId')) {
        finance.defaultLedgerId = requireIntOrNull(value.defaultLedgerId, 'finance.defaultLedgerId')
      }
      if (hasOwn(value, 'defaultTransactionType')) {
        finance.defaultTransactionType = requireEnum(value.defaultTransactionType, ['INCOME', 'EXPENSE'], 'finance.defaultTransactionType') as DefaultTransactionType
      }
      if (hasOwn(value, 'defaultAccUserByLedger')) {
        const mapValue = value.defaultAccUserByLedger
        if (!isPlainObject(mapValue) && strict) {
          throw new Error('finance.defaultAccUserByLedger 必须是对象')
        }
        if (isPlainObject(mapValue)) {
          const parsedMap: Record<string, number | null> = {}
          Object.keys(mapValue).forEach((k) => {
            if (!/^\d+$/.test(k)) {
              if (strict)
                throw new Error(`finance.defaultAccUserByLedger key 非法: ${k}`)
              return
            }
            parsedMap[k] = requireIntOrNull(mapValue[k], `finance.defaultAccUserByLedger.${k}`)
          })
          finance.defaultAccUserByLedger = parsedMap
        }
      }
      patch.finance = finance as AppUserSettings['finance']
    }
  }

  if (hasOwn(input, 'plaza')) {
    const value = input.plaza
    if (!isPlainObject(value)) {
      if (strict)
        throw new Error('plaza 必须是对象')
    }
    else {
      const allowed = new Set(['defaultQuickFilter', 'rememberAdvancedFilters', 'defaultRegionCode', 'defaultSortBy', 'defaultMode'])
      if (strict) {
        Object.keys(value).forEach((k) => {
          if (!allowed.has(k))
            throw new Error(`不支持的 plaza 字段: ${k}`)
        })
      }
      const plaza: Partial<AppUserSettings['plaza']> = {}
      if (hasOwn(value, 'defaultQuickFilter')) {
        plaza.defaultQuickFilter = requireEnum(value.defaultQuickFilter, ['ALL', 'CAN_ADD', 'BENEFIT_TYPE', 'ACTIVITY_TYPE'], 'plaza.defaultQuickFilter') as PlazaQuickFilter
      }
      if (hasOwn(value, 'rememberAdvancedFilters')) {
        plaza.rememberAdvancedFilters = requireBoolean(value.rememberAdvancedFilters, 'plaza.rememberAdvancedFilters')
      }
      if (hasOwn(value, 'defaultRegionCode')) {
        plaza.defaultRegionCode = requireStringOrNull(value.defaultRegionCode, 'plaza.defaultRegionCode', 20)
      }
      if (hasOwn(value, 'defaultSortBy')) {
        plaza.defaultSortBy = requireEnum(value.defaultSortBy, ['HOT', 'LATEST', 'MATCH'], 'plaza.defaultSortBy') as PlazaSortBy
      }
      if (hasOwn(value, 'defaultMode')) {
        plaza.defaultMode = requireEnum(value.defaultMode, ['FOLLOWED', 'ALL'], 'plaza.defaultMode') as PlazaDefaultMode
      }
      patch.plaza = plaza as AppUserSettings['plaza']
    }
  }

  if (hasOwn(input, 'notification')) {
    const value = input.notification
    if (!isPlainObject(value)) {
      if (strict)
        throw new Error('notification 必须是对象')
    }
    else {
      const allowed = new Set(['masterEnabled', 'typeActivity', 'typeAnnouncement', 'typeFeedbackReply', 'typeTaskReminder'])
      if (strict) {
        Object.keys(value).forEach((k) => {
          if (!allowed.has(k))
            throw new Error(`不支持的 notification 字段: ${k}`)
        })
      }
      const notification: Partial<AppUserSettings['notification']> = {}
      if (hasOwn(value, 'masterEnabled'))
        notification.masterEnabled = requireBoolean(value.masterEnabled, 'notification.masterEnabled')
      if (hasOwn(value, 'typeActivity'))
        notification.typeActivity = requireBoolean(value.typeActivity, 'notification.typeActivity')
      if (hasOwn(value, 'typeAnnouncement'))
        notification.typeAnnouncement = requireBoolean(value.typeAnnouncement, 'notification.typeAnnouncement')
      if (hasOwn(value, 'typeFeedbackReply'))
        notification.typeFeedbackReply = requireBoolean(value.typeFeedbackReply, 'notification.typeFeedbackReply')
      if (hasOwn(value, 'typeTaskReminder'))
        notification.typeTaskReminder = requireBoolean(value.typeTaskReminder, 'notification.typeTaskReminder')
      patch.notification = notification as AppUserSettings['notification']
    }
  }

  // 兼容旧字段 task.reminderEnabled —— 自动迁移到 notification.typeTaskReminder。
  // 不在 patch 里输出 task；mergeSettings 也不再有 task 字段
  if (hasOwn(input, 'task')) {
    const value = input.task
    if (isPlainObject(value) && hasOwn(value, 'reminderEnabled') && typeof value.reminderEnabled === 'boolean') {
      const existing = patch.notification ?? {}
      // 显式 notification.typeTaskReminder 优先；旧 task 字段只在 typeTaskReminder 缺失时填充
      if (!hasOwn(existing, 'typeTaskReminder')) {
        patch.notification = { ...existing, typeTaskReminder: value.reminderEnabled } as AppUserSettings['notification']
      }
    }
  }

  return patch
}

/** 深合并：patch 只覆盖出现的键；finance.defaultAccUserByLedger 按账本 id 逐键合并 */
export function mergeSettings(base: AppUserSettings, patch: AppUserSettingsPatch): AppUserSettings {
  const next: AppUserSettings = {
    ...base,
    schemaVersion: 1,
    cardPack: {
      ...base.cardPack,
      ...(patch.cardPack || {}),
    },
    finance: {
      ...base.finance,
      ...(patch.finance || {}),
      defaultAccUserByLedger: {
        ...base.finance.defaultAccUserByLedger,
        ...((patch.finance?.defaultAccUserByLedger || {}) as Record<string, number | null>),
      },
    },
    plaza: {
      ...base.plaza,
      ...(patch.plaza || {}),
    },
    notification: {
      ...base.notification,
      ...(patch.notification || {}),
    },
  }
  return next
}

/**
 * 归属清洗（纯函数）：defaultLedgerId / defaultAccUserByLedger 里不属于该用户的
 * 账本或成员引用自愈剔除；不存在的账本键直接丢弃，成员 null 值保留。
 */
export function sanitizeSettingsByOwnership(
  settings: AppUserSettings,
  ledgerIds: Set<number>,
  accUserIds: Set<number>,
): AppUserSettings {
  const next = mergeSettings(cloneDefaultSettings(), settings)

  if (next.finance.defaultLedgerId != null && !ledgerIds.has(next.finance.defaultLedgerId)) {
    next.finance.defaultLedgerId = null
  }

  const cleanedMap: Record<string, number | null> = {}
  Object.keys(next.finance.defaultAccUserByLedger || {}).forEach((ledgerKey) => {
    if (!/^\d+$/.test(ledgerKey))
      return
    const ledgerId = Number(ledgerKey)
    if (!ledgerIds.has(ledgerId))
      return
    const value = next.finance.defaultAccUserByLedger[ledgerKey]
    if (value == null) {
      cleanedMap[ledgerKey] = null
      return
    }
    if (accUserIds.has(value)) {
      cleanedMap[ledgerKey] = value
    }
  })
  next.finance.defaultAccUserByLedger = cleanedMap

  return next
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${field} 必须是 boolean`)
  }
  return value
}

function requireIntOrNull(value: unknown, field: string): number | null {
  if (value == null)
    return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} 必须是正整数或 null`)
  }
  return value
}

function requireStringOrNull(value: unknown, field: string, maxLength: number): string | null {
  if (value == null)
    return null
  if (typeof value !== 'string') {
    throw new TypeError(`${field} 必须是字符串或 null`)
  }
  const trimmed = value.trim()
  if (!trimmed)
    return null
  return trimmed.slice(0, maxLength)
}

function requireEnum(value: unknown, allowed: string[], field: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${field} 取值非法`)
  }
  return value
}
