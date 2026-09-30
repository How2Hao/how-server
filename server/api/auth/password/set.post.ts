import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { setPassword } from '~/server/utils/services/auth.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const body = await readJson<{ password?: string }>(event)
  return respond(() => setPassword(userId, body.password as string))
})
