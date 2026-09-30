import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { getAccUsers } from '~/server/utils/services/acc.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  return respond(() => getAccUsers(userId))
})
