import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { updateMe } from '~/server/utils/services/auth.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const body = await readJson<{ username?: string, avatar?: string | null }>(event)
  return respond(() => updateMe(userId, { username: body.username, avatar: body.avatar }))
})
