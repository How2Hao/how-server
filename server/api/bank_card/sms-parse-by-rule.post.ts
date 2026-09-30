import type { ISmsCandidatePayload } from '~/server/utils/types.ts'
// POST /bank_card/sms-parse-by-rule — 按规则批量解析（body: { candidates, bankIds }）
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { parseBillByRules } from '~/server/utils/services/sms-bill-parse.ts'

export default defineHandler(async (event) => {
  requireAuth(event)
  const body = await readJson(event)
  const candidates = Array.isArray(body.candidates)
    ? (body.candidates as ISmsCandidatePayload[])
    : []
  const bankIds = Array.isArray(body.bankIds)
    ? (body.bankIds as unknown[]).map(it => String(it).trim()).filter(Boolean)
    : []
  return respond(() => parseBillByRules(candidates, bankIds))
})
