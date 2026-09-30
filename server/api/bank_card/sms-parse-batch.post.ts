import type { ISmsCandidatePayload } from '~/server/utils/types.ts'
// POST /bank_card/sms-parse-batch — 无规则批量解析（关键词预筛 → 单条解析）
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { parseBillFromSmsBatch } from '~/server/utils/services/sms-bill-parse.ts'

export default defineHandler(async (event) => {
  requireAuth(event)
  const body = await readJson(event)
  const candidates = Array.isArray(body.candidates)
    ? (body.candidates as ISmsCandidatePayload[])
    : []
  return respond(() => parseBillFromSmsBatch(candidates))
})
