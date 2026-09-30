import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { markFeedbackViewed } from '~/server/utils/services/feedback.ts'

/** 标记用户已查看反馈历史（清红点）；幂等 */
export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  return respond(async () => {
    await markFeedbackViewed(userId)
    return null
  })
})
