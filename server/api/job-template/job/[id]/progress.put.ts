import { defineHandler } from 'nitro'
import { getAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { fail, respond } from '~/server/utils/response.ts'
import { updateJobProgress } from '~/server/utils/services/job-template.ts'

// 达标进度更新：body { date?, progressAmount?, progressCount? }
export default defineHandler(async (event) => {
  const authUser = getAuth(event)
  if (!authUser)
    return fail('未登录')
  const id = Number.parseInt(event.context.params?.id ?? '', 10)
  const body = await readJson(event)
  return respond(() => updateJobProgress(authUser.userId, id, body))
})
