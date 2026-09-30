import { defineHandler } from 'nitro'
import { getAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { fail, respond } from '~/server/utils/response.ts'
import { getRepaymentJobDisplayItems } from '~/server/utils/services/job-template.ts'

// 还款账期批量展示：body.items[]，未登录返回 HTTP 200 { success:false, message:'未登录' }
export default defineHandler(async (event) => {
  const authUser = getAuth(event)
  if (!authUser)
    return fail('未登录')
  const body = await readJson(event)
  return respond(() => getRepaymentJobDisplayItems(authUser.userId, body))
})
