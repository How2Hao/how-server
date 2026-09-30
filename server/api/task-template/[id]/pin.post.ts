// POST /task-template/:id/pin：置顶模板为 kind='PIN' 任务（幂等；鉴权中间件对 */pin 后缀路径强制登录）
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { pinTaskTemplate } from '~/server/utils/services/task-template.ts'

export default defineHandler(async (event) => {
  const authUser = requireAuth(event)
  const id = event.context.params?.id ?? ''
  return respond(() => pinTaskTemplate(authUser.userId, id))
})
