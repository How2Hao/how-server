// GET /bank_card/sms-rules — 启用的银行短信解析规则（?bankIds= CSV 可选）
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { getEnabledRules } from '~/server/utils/services/sms-bill-parse.ts'

export default defineHandler(async (event) => {
  requireAuth(event)
  const bankIdsParam = query(event).get('bankIds') || ''
  const bankIds = bankIdsParam
    .split(',')
    .map(it => it.trim())
    .filter(Boolean)
  return respond(() => getEnabledRules(bankIds))
})
