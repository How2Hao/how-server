import bcrypt from 'bcryptjs'
// better-auth 实例：统一管理用户模型、会话（refresh token 语义）、第三方账号与密码哈希
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from '~/server/database/db.ts'
import * as schema from '~/server/database/schema/index.ts'
import { config } from '~/server/utils/config.ts'

export const auth = betterAuth({
  appName: 'how2hao',
  baseURL: config.auth.baseURL,
  secret: config.auth.betterAuthSecret,
  database: drizzleAdapter(db, {
    provider: 'mysql',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  // users/session/account/verification 均为 INT 自增主键（users 表沿用旧库自增 id）
  advanced: {
    database: { generateId: 'serial' },
  },
  emailAndPassword: {
    // 登录/注册端点由业务路由实现（短信验证码 + 手机密码），这里仅复用其密码哈希原语
    enabled: false,
    password: {
      // 沿用旧系统 bcrypt(rounds=10)，保证旧密码哈希可验证
      hash: password => bcrypt.hash(password, 10),
      verify: ({ hash, password }) => bcrypt.compare(password, hash),
    },
  },
  user: {
    // better-auth 标准字段映射到既有 users 表列
    fields: {
      name: 'username',
      image: 'avatar',
    },
    additionalFields: {
      uid6: { type: 'string', required: false, input: false },
      phone: { type: 'string', required: false },
      phoneVerifiedAt: { type: 'number', required: false, input: false },
      status: { type: 'string', required: false, input: false, defaultValue: 'ACTIVE' },
      lastLoginAt: { type: 'number', required: false, input: false },
      feedbackLastViewedAt: { type: 'number', required: false, input: false },
    },
  },
  session: {
    // refreshToken 语义：30 天有效，activity 续期
    expiresIn: config.auth.refreshTokenTtlSeconds,
    updateAge: 60 * 60 * 24,
    storeSessionInDatabase: true,
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 60,
  },
})

export type Auth = typeof auth
