// 用户 AI 功能配额（移植自旧 UserAiQuotaService）：按 用户×功能×月 限次
import { and, eq, sql } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { userAiQuota } from '~/server/database/schema/notification.ts'

const MONTHLY_LIMITS: Record<string, number> = {
  coupon_ocr: 100,
}

function monthKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

export function getQuotaLimit(feature: string): number {
  return MONTHLY_LIMITS[feature] ?? 0
}

export async function getQuotaUsed(userId: number, feature: string): Promise<number> {
  const [row] = await db.select({ used: userAiQuota.usedCount }).from(userAiQuota).where(and(
    eq(userAiQuota.userId, userId),
    eq(userAiQuota.feature, feature),
    eq(userAiQuota.monthKey, monthKey()),
  )).limit(1)
  return row ? Number(row.used) : 0
}

export async function checkQuota(userId: number, feature: string): Promise<void> {
  const limit = getQuotaLimit(feature)
  if (limit <= 0)
    throw new Error(`功能 ${feature} 未开放`)
  const used = await getQuotaUsed(userId, feature)
  if (used >= limit) {
    throw new Error(`本月识别次数已用完（${used}/${limit}），下月初自动重置`)
  }
}

export async function incrementQuota(userId: number, feature: string): Promise<void> {
  await db.insert(userAiQuota).values({
    userId,
    feature,
    monthKey: monthKey(),
    usedCount: 1,
    updatedAt: new Date(),
  }).onDuplicateKeyUpdate({
    set: { usedCount: sql`${userAiQuota.usedCount} + 1`, updatedAt: new Date() },
  })
}
