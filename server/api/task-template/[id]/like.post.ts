// POST /task-template/:id/like：点赞（鉴权中间件对 */like 后缀路径强制登录）
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { likeTaskTemplate } from '~/server/utils/services/task-template.ts'

export default defineHandler(async (event) => {
  const authUser = requireAuth(event)
  const id = event.context.params?.id ?? ''
  return respond(() => likeTaskTemplate(id, authUser.userId))
})
