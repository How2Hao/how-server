import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { updateBillReminderAmount } from '~/server/utils/services/task.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const id = event.context.params?.id ?? ''
  const body = await readJson(event)
  return respond(async () => {
    const amount = Number(body.benefitAmount)
    if (!Number.isFinite(amount) || amount <= 0)
      throw new Error('benefitAmount 无效')
    return updateBillReminderAmount(userId, id, amount)
  })
})
