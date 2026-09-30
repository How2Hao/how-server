// GET /task-template/:id：活动详情（可选登录；登录后返回 per-user 点赞/置顶/提醒标记）
import { defineHandler } from 'nitro'
import { getAuth } from '~/server/utils/auth-guard.ts'
import { fail, ok } from '~/server/utils/response.ts'
import { getTaskTemplateById } from '~/server/utils/services/task-template.ts'

export default defineHandler(async (event) => {
  const id = event.context.params?.id ?? ''
  const authUser = getAuth(event)
  const row = await getTaskTemplateById(id, authUser?.userId)
  if (!row)
    return fail('Task template not found')
  return ok(row)
})
