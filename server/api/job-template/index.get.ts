import { defineHandler } from 'nitro'
import { getAuth } from '~/server/utils/auth-guard.ts'
import { fail, respond } from '~/server/utils/response.ts'
import { getJobTemplates } from '~/server/utils/services/job-template.ts'

// 旧系统 /job-template 域不在鉴权中间件白名单内：未登录返回 HTTP 200 { success:false, message:'未登录' }
export default defineHandler(async (event) => {
  const authUser = getAuth(event)
  if (!authUser)
    return fail('未登录')
  return respond(() => getJobTemplates())
})
