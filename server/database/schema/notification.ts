// 通知与用户辅助域：设备推送 token（device_tokens）、消息（notification_message）、
// 用户收件箱（notification_user_inbox）、用户反馈（user_feedback）、
// 用户设置（user_settings）、AI 配额（user_ai_quota）
// 列名/类型以旧库 SQL（db_exports + scripts 迁移）为准

import { bigint, datetime, index, int, json, mysqlEnum, mysqlTable, primaryKey, text, tinyint, uniqueIndex, varchar } from 'drizzle-orm/mysql-core'

export type FeedbackStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'WONT_FIX'
export type FeedbackResolutionType = 'NONE' | 'NO_UPDATE' | 'NEEDS_UPDATE'

/**
 * 推送 token 注册表：用户每台设备一行，按 (user_id, device_id) 唯一。
 * iOS APNs 必填 apns_token；Android 当前无系统级 push，行可作“在线设备登记”用。
 * user_id 无外键（与旧库一致）。
 */
export const deviceToken = mysqlTable('device_tokens', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  userId: int('user_id').notNull(),
  /** IOS / ANDROID */
  platform: varchar('platform', { length: 16 }).notNull(),
  apnsToken: varchar('apns_token', { length: 255 }),
  /** sandbox / production */
  apnsEnv: varchar('apns_env', { length: 16 }),
  deviceId: varchar('device_id', { length: 100 }).notNull(),
  appVersion: varchar('app_version', { length: 20 }),
  osVersion: varchar('os_version', { length: 20 }),
  isActive: tinyint('is_active').notNull().default(1),
  lastActiveAt: bigint('last_active_at', { mode: 'number' }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, t => [
  uniqueIndex('uk_user_device').on(t.userId, t.deviceId),
  index('idx_apns_token').on(t.apnsToken),
])

/**
 * 消息内容表：广播 + 个性化都进这一张。
 * - 广播：source_push_task_id 关联到 push_task，target_user_id 为 null
 * - 个性化（如反馈回复）：target_user_id 填用户 id，source_push_task_id 可为 null
 */
export const notificationMessage = mysqlTable('notification_message', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  /** ACTIVITY / ANNOUNCEMENT / FEEDBACK_REPLY / SYSTEM — 对应用户通知子开关 */
  type: varchar('type', { length: 40 }).notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  body: varchar('body', { length: 2000 }).notNull(),
  imageUrl: varchar('image_url', { length: 500 }),
  /** NONE / DEEPLINK / WEB */
  landingType: varchar('landing_type', { length: 20 }).notNull().default('NONE'),
  landingPayload: json('landing_payload').$type<Record<string, unknown>>(),
  /** 广播消息时关联到 push_task */
  sourcePushTaskId: bigint('source_push_task_id', { mode: 'number' }),
  /** 个性化消息（如反馈回复）填用户 id，广播消息为 NULL；无外键（与旧库一致） */
  targetUserId: int('target_user_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, t => [
  index('idx_push_task').on(t.sourcePushTaskId),
  index('idx_target_user').on(t.targetUserId),
])

/**
 * 用户 ↔ 消息：投递结果 + 阅读状态 一体。
 * 投递字段（delivery_*）来自之前的独立 push_send 表，已合并到这里。
 */
export const notificationUserInbox = mysqlTable('notification_user_inbox', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  userId: int('user_id').notNull(),
  messageId: bigint('message_id', { mode: 'number' }).notNull(),
  // ── 投递（admin 写入） ─────────────────────────────────────────────
  /** APNS = 走 APNs 通道；INBOX_ONLY = 用户关了总开关或无活跃 token */
  deliveryChannel: varchar('delivery_channel', { length: 20 }),
  /** PENDING / SENT / FAILED。INBOX_ONLY 投递视为 SENT */
  deliveryStatus: varchar('delivery_status', { length: 20 }),
  deliveryErrorCode: varchar('delivery_error_code', { length: 50 }),
  deliveryErrorReason: varchar('delivery_error_reason', { length: 255 }),
  deliveryAttemptedAt: bigint('delivery_attempted_at', { mode: 'number' }),
  deliverySentAt: bigint('delivery_sent_at', { mode: 'number' }),
  // ── 阅读 ──────────────────────────────────────────────────────────
  readAt: bigint('read_at', { mode: 'number' }),
  /** PUSH_TAP = 用户点通知；INBOX_TAP = 用户在 app 内点 inbox */
  openedVia: varchar('opened_via', { length: 20 }),
  archivedAt: bigint('archived_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, t => [
  index('idx_notification_user_inbox_user_id').on(t.userId),
])

/** 用户意见反馈 */
export const userFeedback = mysqlTable('user_feedback', {
  id: int('id').autoincrement().primaryKey(),
  /** 旧库列名即 userId（TypeORM 未显式命名）；无外键（与旧库一致） */
  userId: int('userId').notNull(),
  /** BUG / FEATURE / CARD_FACE */
  type: varchar('type', { length: 20 }).notNull(),
  content: text('content').notNull(),
  images: json('images').$type<string[]>(),
  /** 客户端环境快照（appVersion/os/device/network/locale 等） */
  context: json('context').$type<Record<string, unknown>>(),
  status: mysqlEnum('status', ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX']).notNull().default('OPEN'),
  resolutionType: mysqlEnum('resolution_type', ['NONE', 'NO_UPDATE', 'NEEDS_UPDATE']).notNull().default('NONE'),
  /** 需要更新到的最低版本（仅 NEEDS_UPDATE 时有值） */
  minAppVersion: varchar('min_app_version', { length: 20 }),
  /** 管理员回复文字 */
  resolutionNote: varchar('resolution_note', { length: 500 }),
  /** 进入终态的毫秒时间戳 */
  resolvedAt: bigint('resolved_at', { mode: 'number' }),
  createdAt: datetime('createdAt').notNull(),
  /** 任何字段被 update 都会自动跟进（MySQL ON UPDATE CURRENT_TIMESTAMP），配合 user.feedbackLastViewedAt 计算未读红点 */
  updatedAt: datetime('updatedAt').notNull(),
}, t => [
  index('idx_user_feedback_user_created').on(t.userId, t.createdAt),
])

/** 用户设置（单表 JSON）；旧库有外键 fk_user_settings_user → users(id)，按约定此处不加 .references() */
export const userSettings = mysqlTable('user_settings', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull(),
  schemaVersion: tinyint('schema_version').notNull().default(1),
  settingsJson: json('settings_json').$type<Record<string, unknown>>().notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, t => [
  uniqueIndex('uniq_user_settings_user_id').on(t.userId),
  index('idx_user_settings_updated_at').on(t.updatedAt),
])

/** AI 功能用量配额（按 用户 × 功能 × 月 聚合） */
export const userAiQuota = mysqlTable('user_ai_quota', {
  userId: int('user_id').notNull(),
  feature: varchar('feature', { length: 50 }).notNull(),
  /** 月份键，如 2026-09 */
  monthKey: varchar('month_key', { length: 7 }).notNull(),
  usedCount: int('used_count').notNull().default(0),
  updatedAt: datetime('updated_at').notNull(),
}, t => [
  primaryKey({ columns: [t.userId, t.feature, t.monthKey] }),
])

/** 系统功能开关（旧代码经裸 SQL 访问，未建实体；缺失行 = 开启） */
export const systemFeatureFlag = mysqlTable('system_feature_flag', {
  feature: varchar('feature', { length: 64 }).primaryKey(),
  enabled: tinyint('enabled').notNull().default(1),
  updatedAt: datetime('updated_at').notNull(),
})
