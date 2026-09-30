import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { getSettings } from '~/server/utils/services/user-settings.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  return respond(() => getSettings(userId))
})
