import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { getMe } from '~/server/utils/services/auth.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  return respond(() => getMe(userId))
})
