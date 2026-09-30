import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { parseFeedbackSubmitInput } from '~/server/utils/services/feedback-core.ts'
import { submitFeedback } from '~/server/utils/services/feedback.ts'

/** 提交意见反馈（type BUG|FEATURE|CARD_FACE，images 最多 3 张，context ≤8KB 纯对象） */
export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const body = await readJson(event)
  return respond(async () => {
    const input = parseFeedbackSubmitInput(body)
    return submitFeedback(userId, input)
  })
})
