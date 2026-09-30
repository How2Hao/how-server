import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { getTransactionsByMonth } from '~/server/utils/services/acc.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const q = query(event)
  const ledgerId = Number.parseInt(q.get('ledgerId') ?? '', 10)
  const year = Number.parseInt(q.get('year') ?? '', 10)
  const month = Number.parseInt(q.get('month') ?? '', 10)
  return respond(async () => {
    if (Number.isNaN(ledgerId) || Number.isNaN(year) || Number.isNaN(month)) {
      throw new TypeError('ledgerId/year/month 参数必填')
    }
    return getTransactionsByMonth(userId, ledgerId, year, month)
  })
})
