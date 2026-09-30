import type { FeedbackSubmitInput } from './feedback-core.ts'
// 用户意见反馈（移植自旧 src/service/feedback.ts）：提交 / 我的反馈分页 / 未读红点 / 标记已查看
import { and, count, desc, eq, sql } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { user } from '~/server/database/schema/auth.ts'
import { userFeedback } from '~/server/database/schema/notification.ts'

export type UserFeedbackRow = typeof userFeedback.$inferSelect

export async function submitFeedback(userId: number, input: FeedbackSubmitInput): Promise<{ id: number }> {
  const [inserted] = await db.insert(userFeedback).values({
    userId,
    type: input.type,
    content: input.content,
    images: input.images.length ? input.images : null,
    context: input.context && Object.keys(input.context).length > 0 ? input.context : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).$returningId()
  return { id: Number(inserted.id) }
}

export async function listMyFeedback(userId: number, page = 1, pageSize = 20) {
  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1
  const safePageSize = Number.isFinite(pageSize)
    ? Math.min(100, Math.max(1, Math.floor(pageSize)))
    : 20

  const [totalRow] = await db.select({ c: count() }).from(userFeedback).where(eq(userFeedback.userId, userId))
  const total = Number(totalRow?.c ?? 0)

  // 按 updatedAt 倒序：admin 刚回复 / 用户刚改状态的条目浮到最上面，比 createdAt DESC 更体感
  const list = await db.select().from(userFeedback).where(eq(userFeedback.userId, userId)).orderBy(desc(userFeedback.updatedAt)).limit(safePageSize).offset((safePage - 1) * safePageSize)

  return {
    list,
    total,
    page: safePage,
    pageSize: safePageSize,
    totalPages: total > 0 ? Math.ceil(total / safePageSize) : 0,
  }
}

/**
 * 是否有未读反馈：存在某条 user_feedback 满足
 *   - 属于当前 user
 *   - 被 admin 实际更新过（updatedAt 严格 > createdAt，避免存量数据被误判）
 *   - 用户没在这次更新之后查看过历史页（feedbackLastViewedAt 比 updatedAt 早，或从未查看）
 */
export async function hasUnreadFeedback(userId: number): Promise<boolean> {
  const [u] = await db.select({ feedbackLastViewedAt: user.feedbackLastViewedAt })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  const lastViewedMs = u?.feedbackLastViewedAt != null ? Number(u.feedbackLastViewedAt) : null

  const conditions = [
    eq(userFeedback.userId, userId),
    // updatedAt / createdAt 均为 datetime 列，直接 SQL 比较
    sql`${userFeedback.updatedAt} > ${userFeedback.createdAt}`,
  ]
  if (lastViewedMs != null && Number.isFinite(lastViewedMs)) {
    // updatedAt 是 datetime，转毫秒后跟 lastViewed 比较
    conditions.push(sql`UNIX_TIMESTAMP(${userFeedback.updatedAt}) * 1000 > ${lastViewedMs}`)
  }

  const [row] = await db.select({ c: count() }).from(userFeedback).where(and(...conditions)).limit(1)
  return Number(row?.c ?? 0) > 0
}

/** 把当前 user 的 feedback_last_viewed_at 置为 now()，用户下次再看不会再标未读 */
export async function markFeedbackViewed(userId: number): Promise<void> {
  await db.update(user)
    .set({ feedbackLastViewedAt: Date.now() })
    .where(eq(user.id, userId))
}
