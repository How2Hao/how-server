import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { findInboxIdByMessage, markInboxRead } from '~/server/utils/services/inbox.ts'

/**
 * push 打开回执：ha 点击通知后调用。
 * 支持两种入参：
 *   - inboxId：直接定位（ha 本地已知 inbox 行 id 时使用）
 *   - messageId：从 push payload 拿到的消息 id，后端按 user 反查 inbox
 * 副作用：标 inbox 已读 + 设置 opened_via='PUSH_TAP' + 关联 push_task.stats_opened +1
 */
export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const body = await readJson<{ inboxId?: number, messageId?: number }>(event)
  return respond(async () => {
    const now = Date.now()
    let inboxId = Number(body.inboxId)
    if (!Number.isInteger(inboxId) || inboxId <= 0) {
      // 兜底：用 messageId 反查 inbox 行
      const messageId = Number(body.messageId)
      if (!Number.isInteger(messageId) || messageId <= 0) {
        throw new Error('inboxId 或 messageId 至少要有一个')
      }
      inboxId = (await findInboxIdByMessage(userId, messageId)) ?? 0
      if (!inboxId)
        throw new Error('未找到对应 inbox 记录')
    }
    await markInboxRead(userId, inboxId, 'PUSH_TAP')
    return { receivedAt: now, inboxId }
  })
})
