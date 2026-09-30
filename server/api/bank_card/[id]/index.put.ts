import type { BankCardCreateDto } from '~/server/utils/services/bank-card.ts'
// PUT /bank_card/:id — 全量更新银行卡
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { updateBankCard } from '~/server/utils/services/bank-card.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const id = event.context.params?.id ?? ''
  const body = await readJson(event)
  return respond(async () => {
    const card = await updateBankCard(userId, id, body as unknown as BankCardCreateDto)
    if (!card) {
      throw new Error('Bank card not found')
    }
    return card
  })
})
