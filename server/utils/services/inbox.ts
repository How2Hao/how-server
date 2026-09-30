// 用户收件箱（移植自旧 src/service/inbox.ts）：列表 / 未读数 / 已读 / 打开回执 / 个性化消息写入
import { and, count, desc, eq, isNull, lt, sql } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { notificationMessage, notificationUserInbox } from '~/server/database/schema/notification.ts'

export interface InboxItem {
  inboxId: number
  messageId: number
  type: string
  title: string
  body: string
  imageUrl: string | null
  landingType: string
  landingPayload: Record<string, unknown> | null
  readAt: number | null
  createdAt: number
}

type OpenedVia = 'PUSH_TAP' | 'INBOX_TAP'

/**
 * 给单个用户写一条"个性化"消息（如反馈回复）：写 message + user_inbox 两表。
 * 注意：此方法只写 inbox 数据本身，APNs 推送由调用方另行触发。
 */
export async function writePersonalMessage(params: {
  userId: number
  type: string
  title: string
  body: string
  imageUrl?: string | null
  landingType?: 'NONE' | 'DEEPLINK' | 'WEB'
  landingPayload?: Record<string, unknown> | null
  sourcePushTaskId?: number | null
}): Promise<{ messageId: number, inboxId: number }> {
  const now = Date.now()

  const [msg] = await db.insert(notificationMessage).values({
    type: params.type,
    title: params.title,
    body: params.body,
    imageUrl: params.imageUrl ?? null,
    landingType: params.landingType ?? 'NONE',
    landingPayload: params.landingPayload ?? null,
    sourcePushTaskId: params.sourcePushTaskId ?? null,
    targetUserId: params.userId,
    createdAt: now,
  }).$returningId()
  const messageId = Number(msg.id)

  const [ui] = await db.insert(notificationUserInbox).values({
    userId: params.userId,
    messageId,
    deliveryChannel: 'INBOX_ONLY',
    deliveryStatus: 'SENT',
    deliverySentAt: now,
    readAt: null,
    openedVia: null,
    archivedAt: null,
    createdAt: now,
  }).$returningId()

  return { messageId, inboxId: Number(ui.id) }
}

/** 列表（按 id desc，cursor 翻页；cursor 为上一页最后一条的 inboxId） */
export async function listInbox(
  userId: number,
  cursor: number | null,
  limit: number,
): Promise<InboxItem[]> {
  const conditions = [
    eq(notificationUserInbox.userId, userId),
    isNull(notificationUserInbox.archivedAt),
  ]
  if (cursor != null && cursor > 0) {
    conditions.push(lt(notificationUserInbox.id, cursor))
  }

  const rows = await db.select({
    inboxId: notificationUserInbox.id,
    messageId: notificationUserInbox.messageId,
    readAt: notificationUserInbox.readAt,
    createdAt: notificationUserInbox.createdAt,
    type: notificationMessage.type,
    title: notificationMessage.title,
    body: notificationMessage.body,
    imageUrl: notificationMessage.imageUrl,
    landingType: notificationMessage.landingType,
    landingPayload: notificationMessage.landingPayload,
  })
    .from(notificationUserInbox)
    .innerJoin(notificationMessage, eq(notificationMessage.id, notificationUserInbox.messageId))
    .where(and(...conditions))
    .orderBy(desc(notificationUserInbox.id))
    .limit(limit)

  return rows.map(r => ({
    inboxId: Number(r.inboxId),
    messageId: Number(r.messageId),
    type: String(r.type ?? ''),
    title: String(r.title ?? ''),
    body: String(r.body ?? ''),
    imageUrl: r.imageUrl ?? null,
    landingType: String(r.landingType ?? 'NONE'),
    landingPayload: r.landingPayload ?? null,
    readAt: r.readAt == null ? null : Number(r.readAt),
    createdAt: Number(r.createdAt),
  }))
}

export async function getInboxUnreadCount(userId: number): Promise<number> {
  const [row] = await db.select({ c: count() }).from(notificationUserInbox).where(and(
    eq(notificationUserInbox.userId, userId),
    isNull(notificationUserInbox.readAt),
    isNull(notificationUserInbox.archivedAt),
  ))
  return Number(row?.c ?? 0)
}

/**
 * 标已读 + 设置 opened_via。
 * 仅当 read_at IS NULL 时生效（首次触发 wins）。
 * 同时：如果消息关联某 push_task，给该 task 的 stats_opened +1
 */
export async function markInboxRead(
  userId: number,
  inboxId: number,
  openedVia: OpenedVia = 'INBOX_TAP',
): Promise<boolean> {
  const now = Date.now()
  const res = await db.update(notificationUserInbox)
    .set({ readAt: now, openedVia })
    .where(and(
      eq(notificationUserInbox.id, inboxId),
      eq(notificationUserInbox.userId, userId),
      isNull(notificationUserInbox.readAt),
    ))
  const affected = res[0].affectedRows ?? 0
  if (affected > 0) {
    await incrementTaskOpenStat(inboxId)
  }
  return affected > 0
}

/** 按 messageId 反查当前用户的 inbox 行 id（push payload 只带 messageId 时用） */
export async function findInboxIdByMessage(userId: number, messageId: number): Promise<number | null> {
  const [row] = await db.select({ id: notificationUserInbox.id })
    .from(notificationUserInbox)
    .where(and(
      eq(notificationUserInbox.userId, userId),
      eq(notificationUserInbox.messageId, messageId),
    ))
    .limit(1)
  return row ? Number(row.id) : null
}

/** 全部已读（不写 opened_via，因为是批量 dismiss 不是真打开） */
export async function markAllInboxRead(userId: number): Promise<number> {
  const now = Date.now()
  const res = await db.update(notificationUserInbox)
    .set({ readAt: now })
    .where(and(
      eq(notificationUserInbox.userId, userId),
      isNull(notificationUserInbox.readAt),
      isNull(notificationUserInbox.archivedAt),
    ))
  return res[0].affectedRows ?? 0
}

/**
 * 给关联的 push_task 的 stats_opened +1。
 * push_task 表归 how-admin 维护，本服务不持有 drizzle 实体 → 原生 SQL（与旧系统一致）。
 * 统计失败只记日志、不阻塞已读主流程（push_task 表可能不在本库部署）。
 * 通过 inbox.message_id → message.source_push_task_id 关联。
 */
async function incrementTaskOpenStat(inboxId: number): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE push_task pt
        JOIN notification_message m ON m.source_push_task_id = pt.id
        JOIN notification_user_inbox ui ON ui.message_id = m.id
        SET pt.stats_opened = pt.stats_opened + 1
       WHERE ui.id = ${inboxId} AND m.source_push_task_id IS NOT NULL`)
  }
  catch (e) {
    console.warn(`[inbox] push_task.stats_opened 自增失败（忽略）: ${e instanceof Error ? e.message : String(e)}`)
  }
}
