// POST /bank_card/sms-parse — 单条短信解析账单（body: { smsText }）
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { parseBillAmountFromSms } from '~/server/utils/services/sms-bill-parse.ts'

export default defineHandler(async (event) => {
  requireAuth(event)
  const body = await readJson<{ smsText?: unknown }>(event)
  const smsText = (body.smsText ?? '').toString()
  return respond(() => parseBillAmountFromSms(smsText))
})
