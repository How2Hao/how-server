import { defineHandler } from 'nitro'
import { getRequestMeta, readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { appleLogin } from '~/server/utils/services/auth.ts'

export default defineHandler(async (event) => {
  const body = await readJson<{ appleUserId?: string, username?: string, avatar?: string }>(event)
  return respond(() => appleLogin({
    appleUserId: body.appleUserId,
    username: body.username,
    avatar: body.avatar,
    meta: getRequestMeta(event),
  }))
})
