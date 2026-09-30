// DELETE /bank_card/:id — 删除我的银行卡
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { deleteBankCard } from '~/server/utils/services/bank-card.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const id = event.context.params?.id ?? ''
  return respond(async () => {
    const success = await deleteBankCard(userId, id)
    if (!success) {
      throw new Error('Bank card not found')
    }
    return null
  })
})
