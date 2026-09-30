import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { hasUnreadFeedback } from '~/server/utils/services/feedback.ts'

/** 是否有未读反馈（admin 更新过且用户未查看），给 Profile 红点用 */
export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  return respond(async () => {
    const hasUnread = await hasUnreadFeedback(userId)
    return { hasUnread }
  })
})
