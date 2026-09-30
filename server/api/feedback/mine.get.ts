import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { listMyFeedback } from '~/server/utils/services/feedback.ts'

/** 我的反馈历史（按 updatedAt 倒序，admin 刚回复的排最前） */
export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const q = query(event)
  const page = Number.parseInt(q.get('page') || '1', 10) || 1
  const pageSize = Number.parseInt(q.get('pageSize') || '20', 10) || 20
  return respond(() => listMyFeedback(userId, page, pageSize))
})
