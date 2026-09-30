// PATCH /bank_card/:id/billing-rule — 更新账单日/还款规则
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { updateBillingRule } from '~/server/utils/services/bank-card.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const id = event.context.params?.id ?? ''
  const body = await readJson(event)
  return respond(async () => {
    const card = await updateBillingRule(userId, id, body as any)
    if (!card) {
      throw new Error('Bank card not found')
    }
    return card
  })
})
