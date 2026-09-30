import { defineHandler } from 'nitro'
import { getAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { fail, respond } from '~/server/utils/response.ts'
import { upsertRepaymentJobOccurrence } from '~/server/utils/services/job-template.ts'

// 还款账期 upsert：幂等键 = clientKey（缺省为账期键 R:<subjectType>:<subjectId>:<账单日>:<还款日>）
export default defineHandler(async (event) => {
  const authUser = getAuth(event)
  if (!authUser)
    return fail('未登录')
  const body = await readJson(event)
  return respond(() => upsertRepaymentJobOccurrence(authUser.userId, body))
})
