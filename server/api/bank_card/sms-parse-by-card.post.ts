import type { ISmsCandidatePayload } from '~/server/utils/types.ts'
// POST /bank_card/sms-parse-by-card — 按卡解析（body: { bankCardId, candidates, observedSenderAddresses }）
// 命中后把真实发件号回写 bank_sms_rule（自学习）
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { parseBillByBankCardId } from '~/server/utils/services/sms-bill-parse.ts'

export default defineHandler(async (event) => {
  requireAuth(event)
  const body = await readJson(event)
  const candidates = Array.isArray(body.candidates)
    ? (body.candidates as ISmsCandidatePayload[])
    : []
  const bankCardId = String(body.bankCardId ?? '').trim()
  const observedSenderAddresses = Array.isArray(body.observedSenderAddresses)
    ? (body.observedSenderAddresses as unknown[]).map(it => String(it).trim()).filter(Boolean)
    : []
  return respond(() => parseBillByBankCardId(bankCardId, candidates, observedSenderAddresses))
})
