// POST /task-template/:id/feedback：活动详情页用户反馈（鉴权中间件对 */feedback 后缀路径强制登录）
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { submit } from '~/server/utils/services/task-template-feedback.ts'

export default defineHandler(async (event) => {
  const authUser = requireAuth(event)
  const id = event.context.params?.id ?? ''
  const body = await readJson<{ content?: string }>(event)
  return respond(() => submit(authUser.userId, Number.parseInt(id, 10), body.content as string))
})
