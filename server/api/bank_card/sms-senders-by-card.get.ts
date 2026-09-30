// GET /bank_card/sms-senders-by-card — 卡所属银行的短信发件号（?bankCardId=）
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { getSmsSendersByBankCardId } from '~/server/utils/services/sms-bill-parse.ts'

export default defineHandler(async (event) => {
  requireAuth(event)
  const bankCardId = (query(event).get('bankCardId') || '').trim()
  return respond(() => getSmsSendersByBankCardId(bankCardId))
})
