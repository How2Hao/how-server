import type { RequestMeta } from '~/server/utils/request.ts'
// 认证服务：短信验证码登录、密码登录/设置、微信/Apple 登录、绑定手机、令牌签发
// 会话存储与密码哈希基于 better-auth（session/account 表 + bcrypt）
import { randomBytes } from 'node:crypto'
import { and, count, eq, gte, inArray } from 'drizzle-orm'
import { auth } from '~/auth.ts'
import { db } from '~/server/database/db.ts'
import { accCategory, accLedger, accTransaction, accUser } from '~/server/database/schema/acc.ts'
import { account, authSmsEvent, session, user } from '~/server/database/schema/auth.ts'
import { deviceToken, notificationMessage, notificationUserInbox, userAiQuota, userFeedback, userSettings } from '~/server/database/schema/notification.ts'
import { bankCard } from '~/server/database/schema/plaza.ts'
import { job, jobRecurring, jobRecurringOccurrence, task, taskRecurring, taskRecurringOccurrence, taskTemplateFeedback, taskTemplateLike } from '~/server/database/schema/task.ts'
import { config } from '~/server/utils/config.ts'
import { Defaults } from '~/server/utils/defaults.ts'
import { signAccessToken } from '~/server/utils/jwt.ts'
import { initForNewUser } from '~/server/utils/services/acc.ts'
import { aliyunCheckSmsVerifyCode, aliyunSendSmsVerifyCode } from '~/server/utils/services/aliyun-sms.ts'
import { patchSettings } from '~/server/utils/services/user-settings.ts'
import { invalidateSessionCache, invalidateUserSessionsCache } from '~/server/utils/session.ts'

export interface AuthUserVO {
  id: number
  uid6: string
  phone: string | null
  username: string
  avatar: string | null
  status: string
  needBindPhone: boolean
  hasPassword: boolean
}

export interface AuthLoginResult {
  accessToken: string
  refreshToken: string
  accessExpiresIn: number
  refreshExpiresIn: number
  isNewUser: boolean
  user: AuthUserVO
}

// ---------- 短信验证码 ----------

export async function sendSmsCode(
  phone: string,
  scene = 'LOGIN',
  meta: RequestMeta = { ip: null, userAgent: null },
): Promise<{ providerRequestId: string, expireSeconds: number }> {
  const normalizedPhone = normalizePhone(phone)
  if (!normalizedPhone) {
    throw new Error('手机号格式不正确')
  }

  const now = Date.now()
  const oneMinuteAgo = now - 60_000
  const [recent] = await db.select({ c: count() }).from(authSmsEvent).where(and(
    eq(authSmsEvent.phone, normalizedPhone),
    eq(authSmsEvent.action, 'SEND'),
    gte(authSmsEvent.createdAt, oneMinuteAgo),
  ))
  if (Number(recent?.c ?? 0) >= 3) {
    await recordSmsEvent({
      phone: normalizedPhone,
      scene,
      action: 'SEND',
      result: 'RATE_LIMITED',
      failureReason: '一分钟内发送次数过多',
      meta,
    })
    throw new Error('发送太频繁，请稍后再试')
  }

  const provider = String(config.auth.smsProvider || 'MOCK_PROVIDER').toUpperCase()
  let providerRequestId: string

  // App Store 审核备用号：跳过 Aliyun 直接生成假 providerRequestId，配合 verifyCodeWithProvider
  // 里 phone===13800000000 && code===888888 的硬编码白名单使用
  const isReviewerPhone = normalizedPhone === '13800000000'

  if (provider === 'ALIYUN_DYPNS' && !isReviewerPhone) {
    try {
      const sendResult = await aliyunSendSmsVerifyCode(normalizedPhone, {
        accessKeyId: config.aliyun.accessKeyId,
        accessKeySecret: config.aliyun.accessKeySecret,
        signName: config.aliyun.smsSignName,
        templateCode: config.aliyun.smsTemplateCode,
      })
      providerRequestId = sendResult.bizId
    }
    catch (e: any) {
      await recordSmsEvent({
        phone: normalizedPhone,
        scene,
        action: 'SEND',
        result: 'FAILED',
        failureReason: e?.message || '短信发送失败',
        meta,
      })
      throw e
    }
  }
  else {
    providerRequestId = `sms_${Date.now()}_${randomBytes(4).toString('hex')}`
  }

  await recordSmsEvent({
    phone: normalizedPhone,
    scene,
    action: 'SEND',
    result: 'SUCCESS',
    providerRequestId,
    meta,
  })

  return { providerRequestId, expireSeconds: 300 }
}

// ---------- 登录 ----------

export async function smsLogin(payload: {
  phone: string
  scene?: string
  providerRequestId?: string
  code?: string
  meta?: RequestMeta
}): Promise<AuthLoginResult> {
  const meta = payload.meta ?? { ip: null, userAgent: null }
  const normalizedPhone = normalizePhone(payload.phone)
  if (!normalizedPhone) {
    throw new Error('手机号格式不正确')
  }

  await verifySmsProof({
    phone: normalizedPhone,
    scene: payload.scene || 'LOGIN',
    providerRequestId: payload.providerRequestId,
    code: payload.code,
    meta,
  })

  const found = await findUserByPhone(normalizedPhone)
  const isNewUser = !found
  let userId: number
  if (found) {
    userId = found.id
  }
  else {
    userId = await createUserWithPhone(normalizedPhone)
    await initNewUserForUser(userId)
  }

  await ensureAccount(userId, 'PHONE_SMS', normalizedPhone)

  return issueLoginTokens(userId, undefined, isNewUser, meta)
}

export async function refresh(refreshToken: string, meta: RequestMeta = { ip: null, userAgent: null }): Promise<AuthLoginResult> {
  const normalizedToken = (refreshToken || '').trim()
  if (!normalizedToken) {
    throw new Error('refreshToken 不能为空')
  }

  const [row] = await db.select().from(session).where(eq(session.token, normalizedToken)).limit(1)
  if (!row) {
    throw new Error('refreshToken 无效')
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new Error('refreshToken 已过期')
  }

  const found = await findUserById(Number(row.userId))
  if (!found) {
    throw new Error('用户不存在')
  }

  // 旋转 refreshToken（沿用旧系统语义：同会话换新 token，顺延 30 天）
  const nextToken = randomBytes(32).toString('hex')
  await db.update(session).set({
    token: nextToken,
    expiresAt: new Date(Date.now() + config.auth.refreshTokenTtlSeconds * 1000),
    updatedAt: new Date(),
  }).where(eq(session.id, row.id))
  invalidateSessionCache(Number(row.id))

  return issueLoginTokens(found.id, { sessionId: Number(row.id), refreshToken: nextToken }, false, meta)
}

export async function logout(refreshToken: string): Promise<void> {
  const normalizedToken = (refreshToken || '').trim()
  if (!normalizedToken)
    return

  const [row] = await db.select({ id: session.id }).from(session).where(eq(session.token, normalizedToken)).limit(1)
  if (!row)
    return

  await db.delete(session).where(eq(session.id, row.id))
  // 立即清缓存，否则 30 秒 TTL 内旧 access token 仍能通过 verify
  invalidateSessionCache(Number(row.id))
}

export async function getMe(userId: number): Promise<AuthUserVO> {
  const found = await findUserById(userId)
  if (!found)
    throw new Error('用户不存在')
  return serializeUser(found)
}

export async function updateMe(userId: number, payload: { username?: string, avatar?: string | null }): Promise<AuthUserVO> {
  const found = await findUserById(userId)
  if (!found)
    throw new Error('用户不存在')

  const patch: Record<string, unknown> = { updatedAt: new Date() }
  if (payload.username !== undefined) {
    const username = String(payload.username || '').trim()
    if (!username)
      throw new Error('username 不能为空')
    patch.username = username.slice(0, 100)
  }
  if (payload.avatar !== undefined) {
    const avatar = payload.avatar == null ? null : String(payload.avatar).trim()
    patch.avatar = avatar || null
  }

  await db.update(user).set(patch).where(eq(user.id, userId))
  return getMe(userId)
}

export async function wechatLogin(payload: {
  appId?: string
  unionid?: string
  openid?: string
  username?: string
  avatar?: string
  meta?: RequestMeta
}): Promise<AuthLoginResult> {
  const meta = payload.meta ?? { ip: null, userAgent: null }
  const appId = (payload.appId || '').trim()
  const unionid = (payload.unionid || '').trim()
  const openid = (payload.openid || '').trim()
  if (!unionid && (!appId || !openid)) {
    throw new Error('微信登录参数不完整')
  }

  // 与旧系统一致：unionid 优先，否则 appId+openid 组合
  const accountId = unionid ? `wechat_unionid:${unionid}` : `wechat_openid:${appId}:${openid}`
  const [identity] = await db.select().from(account).where(and(
    eq(account.providerId, 'WECHAT'),
    eq(account.accountId, accountId),
  )).limit(1)

  let userId: number
  if (identity) {
    userId = Number(identity.userId)
  }
  else {
    userId = await createPendingBindUser(payload.username, payload.avatar)
    await initNewUserForUser(userId)
    await ensureAccount(userId, 'WECHAT', accountId)
  }

  return issueLoginTokens(userId, undefined, false, meta)
}

export async function appleLogin(payload: {
  appleUserId?: string
  username?: string
  avatar?: string
  meta?: RequestMeta
}): Promise<AuthLoginResult> {
  const meta = payload.meta ?? { ip: null, userAgent: null }
  const appleUserId = (payload.appleUserId || '').trim()
  if (!appleUserId) {
    throw new Error('appleUserId 不能为空')
  }

  const [identity] = await db.select().from(account).where(and(
    eq(account.providerId, 'APPLE'),
    eq(account.accountId, appleUserId),
  )).limit(1)

  let userId: number
  if (identity) {
    userId = Number(identity.userId)
  }
  else {
    userId = await createPendingBindUser(payload.username, payload.avatar)
    await initNewUserForUser(userId)
    await ensureAccount(userId, 'APPLE', appleUserId)
  }

  return issueLoginTokens(userId, undefined, false, meta)
}

export async function bindPhone(userId: number, phone: string, providerRequestId?: string, code?: string, meta: RequestMeta = { ip: null, userAgent: null }): Promise<AuthUserVO> {
  const normalizedPhone = normalizePhone(phone)
  if (!normalizedPhone) {
    throw new Error('手机号格式不正确')
  }

  const exists = await findUserByPhone(normalizedPhone)
  if (exists && exists.id !== userId) {
    throw new Error('手机号已绑定其他账号')
  }

  const found = await findUserById(userId)
  if (!found)
    throw new Error('用户不存在')

  await verifySmsProof({
    phone: normalizedPhone,
    scene: 'BIND_PHONE',
    providerRequestId,
    code,
    meta,
  })

  const now = Date.now()
  const patch: Record<string, unknown> = {
    phone: normalizedPhone,
    phoneVerifiedAt: now,
    updatedAt: new Date(),
  }
  if (found.status === 'PENDING_BIND') {
    patch.status = 'ACTIVE'
  }
  await db.update(user).set(patch).where(eq(user.id, userId))

  await ensureAccount(userId, 'PHONE_SMS', normalizedPhone)

  return getMe(userId)
}

export async function setPassword(userId: number, password: string): Promise<{ success: true }> {
  const pwd = String(password ?? '')
  if (pwd.length < 8 || pwd.length > 32) {
    throw new Error('密码长度需在 8-32 位之间')
  }
  const found = await findUserById(userId)
  if (!found)
    throw new Error('用户不存在')

  const ctx = await auth.$context
  const existing = await ctx.internalAdapter.findCredentialAccount(String(userId))
  if (existing && existing.password) {
    throw new Error('密码已设置，更改密码请走短信验证流程（暂未开放）')
  }
  const hash = await ctx.password.hash(pwd)
  if (existing) {
    await db.update(account).set({ password: hash, updatedAt: new Date() }).where(eq(account.id, Number(existing.id)))
  }
  else {
    await db.insert(account).values({
      accountId: String(userId),
      providerId: 'credential',
      userId,
      password: hash,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }
  return { success: true }
}

export async function passwordLogin(phone: string, password: string, meta: RequestMeta = { ip: null, userAgent: null }): Promise<AuthLoginResult> {
  const normalizedPhone = normalizePhone(phone)
  const pwd = String(password ?? '')
  const genericError = new Error('手机号或密码错误')
  if (!normalizedPhone || pwd.length < 8)
    throw genericError

  const found = await findUserByPhone(normalizedPhone)
  // 用户不存在 → 走通用错误（不暴露 phone 是否注册）
  if (!found)
    throw genericError

  const ctx = await auth.$context
  const credential = await ctx.internalAdapter.findCredentialAccount(String(found.id))
  // 用户存在但未设置密码 → 明确告知，引导走验证码登录后去设置
  if (!credential || !credential.password) {
    throw new Error('PASSWORD_NOT_SET')
  }

  const passed = await ctx.password.verify({ hash: credential.password, password: pwd })
  if (!passed)
    throw genericError

  return issueLoginTokens(found.id, undefined, false, meta)
}

/**
 * 登录页第一步：按手机号查状态，决定下方展开「密码登录」还是「验证码+设密码」。
 * 注意：会暴露"该手机号是否注册 / 是否已设密码"——与 passwordLogin 的 PASSWORD_NOT_SET
 * 属同类暴露，生产建议在网关层对该接口加限流。
 */
export async function phoneStatus(phone: string): Promise<{ registered: boolean, hasPassword: boolean }> {
  const normalizedPhone = normalizePhone(phone)
  if (!normalizedPhone) {
    throw new Error('手机号格式不正确')
  }
  const found = await findUserByPhone(normalizedPhone)
  let hasPassword = false
  if (found) {
    const [credential] = await db.select({ p: account.password }).from(account).where(and(
      eq(account.providerId, 'credential'),
      eq(account.userId, found.id),
    )).limit(1)
    hasPassword = !!(credential && credential.p)
  }
  return {
    registered: !!found,
    hasPassword,
  }
}

/**
 * 注册 / 存量补设密码 —— 原子完成「短信校验 + 建号(或设密码) + 登录」。
 * 账号只在本调用成功时创建/落库，因此用户中途退出（没提交）= 未注册，不留孤儿账号。
 */
export async function registerWithPassword(payload: {
  phone: string
  providerRequestId?: string
  code?: string
  password: string
  meta?: RequestMeta
}): Promise<AuthLoginResult> {
  const meta = payload.meta ?? { ip: null, userAgent: null }
  const normalizedPhone = normalizePhone(payload.phone)
  if (!normalizedPhone) {
    throw new Error('手机号格式不正确')
  }
  const pwd = String(payload.password ?? '')
  if (pwd.length < 8 || pwd.length > 32) {
    throw new Error('密码长度需在 8-32 位之间')
  }

  // 先做存在性 + 已设密码检查（在消费验证码之前拒绝，避免浪费短信验证）
  const existing = await findUserByPhone(normalizedPhone)
  if (existing) {
    const [credential] = await db.select({ p: account.password }).from(account).where(and(
      eq(account.providerId, 'credential'),
      eq(account.userId, existing.id),
    )).limit(1)
    if (credential && credential.p) {
      throw new Error('该手机号已设置密码，请直接用密码登录')
    }
  }

  await verifySmsProof({
    phone: normalizedPhone,
    scene: 'LOGIN',
    providerRequestId: payload.providerRequestId,
    code: payload.code,
    meta,
  })

  let userId: number
  const isNewUser = !existing
  if (existing) {
    userId = existing.id
  }
  else {
    userId = await createUserWithPhone(normalizedPhone)
    await initNewUserForUser(userId)
  }

  await ensureAccount(userId, 'PHONE_SMS', normalizedPhone)

  await setPassword(userId, pwd)
  return issueLoginTokens(userId, undefined, isNewUser, meta)
}

// ---------- 内部工具 ----------

interface UserRowLike {
  id: number
  uid6: string
  phone: string | null
  username: string
  avatar: string | null
  status: string
}

async function findUserById(id: number): Promise<UserRowLike | null> {
  const [row] = await db.select({
    id: user.id,
    uid6: user.uid6,
    phone: user.phone,
    username: user.username,
    avatar: user.avatar,
    status: user.status,
  }).from(user).where(eq(user.id, id)).limit(1)
  return row ?? null
}

async function findUserByPhone(phone: string): Promise<UserRowLike | null> {
  const [row] = await db.select({
    id: user.id,
    uid6: user.uid6,
    phone: user.phone,
    username: user.username,
    avatar: user.avatar,
    status: user.status,
  }).from(user).where(eq(user.phone, phone)).limit(1)
  return row ?? null
}

async function issueLoginTokens(
  userId: number,
  existing: { sessionId: number, refreshToken: string } | undefined,
  isNewUser: boolean,
  meta: RequestMeta,
): Promise<AuthLoginResult> {
  const now = Date.now()
  const accessExpiresIn = config.auth.accessTokenTtlSeconds
  const refreshExpiresIn = config.auth.refreshTokenTtlSeconds

  let sessionId: number
  let refreshToken: string
  if (existing) {
    sessionId = existing.sessionId
    refreshToken = existing.refreshToken
  }
  else {
    const ctx = await auth.$context
    const created = await ctx.internalAdapter.createSession(String(userId), false, {
      ipAddress: meta.ip ?? '',
      userAgent: meta.userAgent ?? '',
    })
    sessionId = Number(created.id)
    refreshToken = created.token
  }

  const userRow = await findUserById(userId)
  if (!userRow)
    throw new Error('用户不存在')

  const payload = {
    sub: userId,
    uid6: userRow.uid6,
    sid: sessionId,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + accessExpiresIn,
  }
  const accessToken = signAccessToken(payload, config.auth.jwtSecret)

  await db.update(user).set({ lastLoginAt: now, updatedAt: new Date() }).where(eq(user.id, userId))

  return {
    accessToken,
    refreshToken,
    accessExpiresIn,
    refreshExpiresIn,
    isNewUser,
    user: await serializeUser(userRow),
  }
}

async function serializeUser(row: UserRowLike): Promise<AuthUserVO> {
  const [credential] = await db.select({ p: account.password }).from(account).where(and(
    eq(account.providerId, 'credential'),
    eq(account.userId, row.id),
  )).limit(1)
  return {
    id: row.id,
    uid6: row.uid6,
    phone: row.phone,
    username: row.username,
    avatar: row.avatar,
    status: row.status,
    needBindPhone: !row.phone,
    // 空串/NULL 都视为未设密码
    hasPassword: !!(credential && credential.p),
  }
}

/** 新用户初始化：默认记账成员 + 默认账本 + 默认设置 */
async function initNewUserForUser(userId: number): Promise<void> {
  const { ledgerId } = await initForNewUser(userId)
  await patchSettings(userId, { finance: { defaultLedgerId: ledgerId } })
}

async function createUserWithPhone(phone: string): Promise<number> {
  const uid6 = await allocateUid6()
  const now = new Date()
  const [inserted] = await db.insert(user).values({
    uid6,
    phone,
    phoneVerifiedAt: Date.now(),
    username: Defaults.user.username,
    avatar: Defaults.user.avatar,
    status: 'ACTIVE',
    email: '',
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  }).$returningId()
  return Number(inserted.id)
}

async function createPendingBindUser(username?: string, avatar?: string): Promise<number> {
  const uid6 = await allocateUid6()
  const now = new Date()
  const [inserted] = await db.insert(user).values({
    uid6,
    phone: null,
    phoneVerifiedAt: null,
    username: (username || '').trim() || Defaults.user.username,
    avatar: (avatar || '').trim() || Defaults.user.avatar,
    status: 'PENDING_BIND',
    email: '',
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  }).$returningId()
  return Number(inserted.id)
}

function generateUid6(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let uid: string
  do {
    const bytes = randomBytes(6)
    uid = Array.from(bytes).map(b => chars[b % 36]).join('')
  } while (!/\d/.test(uid) || !/[A-Z]/.test(uid))
  return uid
}

async function allocateUid6(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const uid6 = generateUid6()
    const [exists] = await db.select({ id: user.id }).from(user).where(eq(user.uid6, uid6)).limit(1)
    if (!exists)
      return uid6
  }
  throw new Error('UID6 生成失败，请重试')
}

/** 保证 providerId+accountId 身份行存在（对应旧 user_identities，现 better-auth account 表） */
async function ensureAccount(userId: number, providerId: string, accountId: string): Promise<void> {
  const [exists] = await db.select().from(account).where(and(
    eq(account.providerId, providerId),
    eq(account.accountId, accountId),
  )).limit(1)

  if (exists) {
    if (Number(exists.userId) !== userId) {
      throw new Error('该三方身份已绑定其他用户')
    }
    return
  }

  await db.insert(account).values({
    providerId,
    accountId,
    userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

function normalizePhone(raw: string): string | null {
  const phone = String(raw || '').trim()
  if (!/^1\d{10}$/.test(phone))
    return null
  return phone
}

async function verifySmsProof(payload: {
  phone: string
  scene: string
  providerRequestId?: string
  code?: string
  meta: RequestMeta
}): Promise<void> {
  const providerRequestId = String(payload.providerRequestId || '').trim()
  const code = String(payload.code || '').trim()
  const scene = String(payload.scene || 'LOGIN').trim() || 'LOGIN'

  if (!providerRequestId) {
    await recordSmsEvent({
      phone: payload.phone,
      scene,
      action: 'VERIFY',
      result: 'FAILED',
      failureReason: '缺少 providerRequestId',
      meta: payload.meta,
    })
    throw new Error('providerRequestId 不能为空')
  }
  if (!code) {
    await recordSmsEvent({
      phone: payload.phone,
      scene,
      action: 'VERIFY',
      result: 'FAILED',
      providerRequestId,
      failureReason: '缺少验证码',
      meta: payload.meta,
    })
    throw new Error('验证码不能为空')
  }

  // 防重放：同一 (phone, scene, providerRequestId) 的 VERIFY SUCCESS 只允许一次
  const [replay] = await db.select({ c: count() }).from(authSmsEvent).where(and(
    eq(authSmsEvent.phone, payload.phone),
    eq(authSmsEvent.scene, scene),
    eq(authSmsEvent.providerRequestId, providerRequestId),
    eq(authSmsEvent.action, 'VERIFY'),
    eq(authSmsEvent.result, 'SUCCESS'),
  ))
  if (Number(replay?.c ?? 0) > 0) {
    await recordSmsEvent({
      phone: payload.phone,
      scene,
      action: 'VERIFY',
      result: 'FAILED',
      providerRequestId,
      failureReason: '验证码已被使用',
      meta: payload.meta,
    })
    throw new Error('验证码已失效，请重新发送')
  }

  // 必须存在 5 分钟内的发送成功记录
  const expireWindow = Date.now() - 5 * 60_000
  const [recentSend] = await db.select({ id: authSmsEvent.id }).from(authSmsEvent).where(and(
    eq(authSmsEvent.phone, payload.phone),
    eq(authSmsEvent.scene, scene),
    eq(authSmsEvent.providerRequestId, providerRequestId),
    eq(authSmsEvent.action, 'SEND'),
    eq(authSmsEvent.result, 'SUCCESS'),
    gte(authSmsEvent.createdAt, expireWindow),
  )).limit(1)
  if (!recentSend) {
    await recordSmsEvent({
      phone: payload.phone,
      scene,
      action: 'VERIFY',
      result: 'FAILED',
      providerRequestId,
      failureReason: '发送记录不存在或已过期',
      meta: payload.meta,
    })
    throw new Error('验证码已过期或请求无效')
  }

  const verified = await verifyCodeWithProvider(payload.phone, code)
  if (!verified) {
    await recordSmsEvent({
      phone: payload.phone,
      scene,
      action: 'VERIFY',
      result: 'FAILED',
      providerRequestId,
      failureReason: '验证码校验失败',
      meta: payload.meta,
    })
    throw new Error('验证码错误')
  }

  await recordSmsEvent({
    phone: payload.phone,
    scene,
    action: 'VERIFY',
    result: 'SUCCESS',
    providerRequestId,
    meta: payload.meta,
  })
}

async function verifyCodeWithProvider(phone: string, code: string): Promise<boolean> {
  // App Store 审核员所在地区收不到阿里云短信，预留固定测试号 / 验证码绕过
  // 该号段是 GSMA 文档约定的"虚构测试用号段"，真实运营商不会分配
  if (phone === '13800000000' && code === '888888')
    return true

  const provider = String(config.auth.smsProvider || 'MOCK_PROVIDER').toUpperCase()

  if (provider === 'ALIYUN_DYPNS') {
    const result = await aliyunCheckSmsVerifyCode(phone, code, {
      accessKeyId: config.aliyun.accessKeyId,
      accessKeySecret: config.aliyun.accessKeySecret,
      signName: config.aliyun.smsSignName,
    })
    return result.pass
  }

  // MOCK_PROVIDER：任意 6 位数字视为正确
  return /^\d{6}$/.test(code)
}

async function recordSmsEvent(payload: {
  phone: string
  scene: string
  action: 'SEND' | 'VERIFY'
  result: 'SUCCESS' | 'FAILED' | 'RATE_LIMITED'
  providerRequestId?: string
  failureReason?: string
  meta: RequestMeta
}): Promise<void> {
  await db.insert(authSmsEvent).values({
    phone: payload.phone,
    scene: payload.scene,
    provider: config.auth.smsProvider || 'MOCK',
    providerRequestId: payload.providerRequestId || null,
    action: payload.action,
    result: payload.result,
    failureReason: payload.failureReason || null,
    ip: payload.meta.ip,
    userAgent: payload.meta.userAgent,
    createdAt: Date.now(),
  })
}

/**
 * 注销账号：单事务按子表→父表顺序硬删除（保留 auth_sms_events 审计，法定留存 6 个月）。
 * session/account 通过外键级联随 users 一并删除。
 * 注意：inArray 不直接接受子查询（drizzle 0.45 在事务内生成子查询会死循环），先取 id 数组。
 */
export async function deleteAccount(userId: number): Promise<void> {
  await db.transaction(async (tx) => {
    // 任务域（occurrence/recurring 通过任务 id 定位）
    const taskIds = (await tx.select({ id: task.id }).from(task).where(eq(task.userId, userId))).map(r => r.id)
    if (taskIds.length > 0) {
      await tx.delete(taskRecurringOccurrence).where(inArray(taskRecurringOccurrence.taskId, taskIds))
      await tx.delete(taskRecurring).where(inArray(taskRecurring.taskId, taskIds))
    }
    await tx.delete(task).where(eq(task.userId, userId))
    // job 域
    const jobIds = (await tx.select({ id: job.id }).from(job).where(eq(job.userId, userId))).map(r => r.id)
    if (jobIds.length > 0) {
      await tx.delete(jobRecurringOccurrence).where(inArray(jobRecurringOccurrence.jobId, jobIds))
      await tx.delete(jobRecurring).where(inArray(jobRecurring.jobId, jobIds))
    }
    await tx.delete(job).where(eq(job.userId, userId))
    // 广场域
    await tx.delete(taskTemplateLike).where(eq(taskTemplateLike.userId, userId))
    await tx.delete(taskTemplateFeedback).where(eq(taskTemplateFeedback.userId, userId))
    // 记账域（交易通过账本 id 定位）
    const ledgerIds = (await tx.select({ id: accLedger.id }).from(accLedger).where(eq(accLedger.userId, userId))).map(r => r.id)
    if (ledgerIds.length > 0) {
      await tx.delete(accTransaction).where(inArray(accTransaction.ledgerId, ledgerIds))
    }
    await tx.delete(accCategory).where(eq(accCategory.userId, userId))
    await tx.delete(accUser).where(eq(accUser.userId, userId))
    await tx.delete(accLedger).where(eq(accLedger.userId, userId))
    // 银行卡
    await tx.delete(bankCard).where(eq(bankCard.userId, userId))
    // 通知/反馈/设置/配额
    await tx.delete(notificationUserInbox).where(eq(notificationUserInbox.userId, userId))
    await tx.delete(notificationMessage).where(eq(notificationMessage.targetUserId, userId))
    await tx.delete(userFeedback).where(eq(userFeedback.userId, userId))
    await tx.delete(userSettings).where(eq(userSettings.userId, userId))
    await tx.delete(userAiQuota).where(eq(userAiQuota.userId, userId))
    await tx.delete(deviceToken).where(eq(deviceToken.userId, userId))
    // 用户（session/account 级联）
    await tx.delete(user).where(eq(user.id, userId))
  })
  invalidateUserSessionsCache(userId)
}
