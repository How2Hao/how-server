import { defineHandler, getRouterParam } from 'nitro/h3'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { getTransactionById } from '~/server/utils/services/acc.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const id = Number.parseInt(getRouterParam(event, 'id') ?? '', 10)
  return respond(async () => {
    if (Number.isNaN(id)) {
      throw new TypeError('记录不存在')
    }
    return getTransactionById(userId, id)
  })
})
