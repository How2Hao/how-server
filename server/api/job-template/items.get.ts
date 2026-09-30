import { defineHandler } from 'nitro'
import { getAuth } from '~/server/utils/auth-guard.ts'
import { query } from '~/server/utils/request.ts'
import { fail, respond } from '~/server/utils/response.ts'
import { getJobDisplayItems } from '~/server/utils/services/job-template.ts'

// 月视图：date?（毫秒时间戳，缺省取当前时刻）；混合 TEMPLATE_CANDIDATE / USER_JOB
export default defineHandler(async (event) => {
  const authUser = getAuth(event)
  if (!authUser)
    return fail('未登录')
  const dateRaw = query(event).get('date')
  return respond(() => getJobDisplayItems(authUser.userId, dateRaw ? Number(dateRaw) : undefined))
})
