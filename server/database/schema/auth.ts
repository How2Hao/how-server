// 认证域：用户（better-auth user 模型映射到 users 表）、会话、第三方账号、验证码、短信审计
import { bigint, boolean, char, datetime, foreignKey, index, int, mysqlEnum, mysqlTable, tinyint, uniqueIndex, varchar } from 'drizzle-orm/mysql-core'

/**
 * better-auth user 模型（字段映射见根目录 auth.ts）：
 * name→username、image→avatar，email/emailVerified 为 better-auth 兼容字段。
 */
export const user = mysqlTable('users', {
  id: int('id').autoincrement().primaryKey(),
  uid6: char('uid6', { length: 6 }).notNull(),
  phone: varchar('phone', { length: 20 }),
  phoneVerifiedAt: bigint('phone_verified_at', { mode: 'number' }),
  username: varchar('username', { length: 100 }).notNull(),
  avatar: varchar('avatar', { length: 500 }),
  /** better-auth 标准字段；本系统无邮箱流程，创建用户时置空串 */
  email: varchar('email', { length: 255 }).notNull().default(''),
  emailVerified: boolean('email_verified').notNull().default(false),
  /** 已废弃：密码迁移至 account.password（providerId='credential'） */
  passwordHash: varchar('password_hash', { length: 255 }),
  status: mysqlEnum('status', ['ACTIVE', 'PENDING_BIND', 'DISABLED']).notNull().default('ACTIVE'),
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
  lastLoginAt: bigint('last_login_at', { mode: 'number' }),
  feedbackLastViewedAt: bigint('feedback_last_viewed_at', { mode: 'number' }),
}, t => [
  uniqueIndex('uniq_users_uid6').on(t.uid6),
  uniqueIndex('uniq_users_phone').on(t.phone),
  // 非唯一：微信/Apple 用户 email 均为空串
  index('idx_users_email').on(t.email),
])

/** better-auth session：refresh token 语义，登录签发 accessToken（JWT）+ refreshToken（本表 token） */
export const session = mysqlTable('session', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull(),
  token: varchar('token', { length: 128 }).notNull(),
  expiresAt: datetime('expires_at').notNull(),
  ipAddress: varchar('ip_address', { length: 64 }),
  userAgent: varchar('user_agent', { length: 500 }),
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
}, t => [
  foreignKey({ name: 'fk_session_user', columns: [t.userId], foreignColumns: [user.id] }).onDelete('cascade'),
  uniqueIndex('uniq_session_token').on(t.token),
  index('idx_session_user_id').on(t.userId),
])

/** better-auth account：第三方身份（PHONE_SMS/WECHAT/APPLE）+ 本地密码（providerId='credential'） */
export const account = mysqlTable('account', {
  id: int('id').autoincrement().primaryKey(),
  accountId: varchar('account_id', { length: 191 }).notNull(),
  providerId: varchar('provider_id', { length: 64 }).notNull(),
  userId: int('user_id').notNull(),
  accessToken: varchar('access_token', { length: 1024 }),
  refreshToken: varchar('refresh_token', { length: 1024 }),
  idToken: varchar('id_token', { length: 2048 }),
  accessTokenExpiresAt: datetime('access_token_expires_at'),
  refreshTokenExpiresAt: datetime('refresh_token_expires_at'),
  scope: varchar('scope', { length: 255 }),
  password: varchar('password', { length: 255 }),
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
}, t => [
  foreignKey({ name: 'fk_account_user', columns: [t.userId], foreignColumns: [user.id] }).onDelete('cascade'),
  index('idx_account_user_id').on(t.userId),
  uniqueIndex('uniq_account_provider_account').on(t.providerId, t.accountId),
])

/** better-auth verification（预留给未来验证码存库场景） */
export const verification = mysqlTable('verification', {
  id: int('id').autoincrement().primaryKey(),
  identifier: varchar('identifier', { length: 255 }).notNull(),
  value: varchar('value', { length: 2048 }).notNull(),
  expiresAt: datetime('expires_at').notNull(),
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
}, t => [
  index('idx_verification_identifier').on(t.identifier),
])

/** 短信验证码审计/限流/防重放：SEND 与 VERIFY 全量落库 */
export const authSmsEvent = mysqlTable('auth_sms_events', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  phone: varchar('phone', { length: 20 }).notNull(),
  scene: varchar('scene', { length: 50 }).notNull(),
  provider: varchar('provider', { length: 50 }).notNull(),
  providerRequestId: varchar('provider_request_id', { length: 100 }),
  action: mysqlEnum('action', ['SEND', 'VERIFY']).notNull(),
  result: mysqlEnum('result', ['SUCCESS', 'FAILED', 'RATE_LIMITED']).notNull(),
  failureReason: varchar('failure_reason', { length: 255 }),
  ip: varchar('ip', { length: 64 }),
  userAgent: varchar('user_agent', { length: 500 }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, t => [
  index('idx_auth_sms_event_phone_scene_created_at').on(t.phone, t.scene, t.createdAt),
  index('idx_auth_sms_event_provider_request').on(t.providerRequestId),
])

/** 单行序列表：uid6 号段生成 */
export const userUidSequence = mysqlTable('user_uid_sequence', {
  id: tinyint('id').primaryKey(),
  nextVal: bigint('next_val', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})
