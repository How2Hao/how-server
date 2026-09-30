// 会话校验工具：accessToken（JWT）→ sid → session 表有效性（带 30s 进程内缓存，与旧系统一致）
import { and, eq, gt } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { session } from '~/server/database/schema/auth.ts'
import { config } from '~/server/utils/config.ts'
import { verifyAccessToken } from '~/server/utils/jwt.ts'

export interface AuthUser {
  userId: number
  uid6: string
  sessionId: number
}

interface CacheEntry {
  authUser: AuthUser
  cachedUntil: number
}

const CACHE_TTL_MS = 30_000
const g = globalThis as typeof globalThis & { __authCache?: Map<number, CacheEntry> }
const authCache = (g.__authCache ??= new Map<number, CacheEntry>())

export function invalidateSessionCache(sessionId: number): void {
  authCache.delete(sessionId)
}

export function invalidateUserSessionsCache(userId: number): void {
  for (const [sid, entry] of authCache) {
    if (entry.authUser.userId === userId)
      authCache.delete(sid)
  }
}

/** 验证 access token 并解析出登录用户（含 session 有效性检查）。无效返回 null。 */
export async function verifyAccessTokenAndGetUser(token: string): Promise<AuthUser | null> {
  const payload = verifyAccessToken(token, config.auth.jwtSecret)
  if (!payload)
    return null

  const sid = payload.sid
  const now = Date.now()
  const cached = authCache.get(sid)
  if (cached && cached.cachedUntil > now && cached.authUser.userId === payload.sub) {
    return cached.authUser
  }

  // JWT 有效但会话已不存在（登出/删除）→ 拒绝
  const [row] = await db
    .select({ id: session.id, userId: session.userId, expiresAt: session.expiresAt })
    .from(session)
    .where(and(eq(session.id, sid), gt(session.expiresAt, new Date())))
    .limit(1)
  if (!row || Number(row.userId) !== payload.sub) {
    authCache.delete(sid)
    return null
  }

  const authUser: AuthUser = { userId: payload.sub, uid6: payload.uid6, sessionId: sid }
  authCache.set(sid, { authUser, cachedUntil: now + CACHE_TTL_MS })
  return authUser
}

/** 按 refreshToken（session.token）查找有效会话，返回会话与用户 id。 */
export async function findValidSessionByToken(token: string): Promise<{ sessionId: number, userId: number } | null> {
  const [row] = await db
    .select({ id: session.id, userId: session.userId, expiresAt: session.expiresAt })
    .from(session)
    .where(eq(session.token, token))
    .limit(1)
  if (!row)
    return null
  if (row.expiresAt.getTime() <= Date.now())
    return null
  return { sessionId: Number(row.id), userId: Number(row.userId) }
}
