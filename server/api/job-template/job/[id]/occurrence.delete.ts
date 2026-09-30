import { defineHandler } from 'nitro'
import { getAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { fail, respond } from '~/server/utils/response.ts'
import { deleteJobOccurrence } from '~/server/utils/services/job-template.ts'

// 删除某周期实例（DELETE 带 JSON body { occurrenceId?, date? }）
export default defineHandler(async (event) => {
  const authUser = getAuth(event)
  if (!authUser)
    return fail('未登录')
  const id = Number.parseInt(event.context.params?.id ?? '', 10)
  const body = await readJson(event)
  return respond(() => deleteJobOccurrence(authUser.userId, id, body))
})
