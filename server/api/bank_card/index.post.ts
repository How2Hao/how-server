import type { BankCardCreateDto } from '~/server/utils/services/bank-card.ts'
// POST /bank_card — 添加银行卡
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { createBankCard } from '~/server/utils/services/bank-card.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const body = await readJson(event)
  return respond(() => createBankCard(userId, body as unknown as BankCardCreateDto))
})
