import { defineHandler } from 'nitro'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { logout } from '~/server/utils/services/auth.ts'

export default defineHandler(async (event) => {
  const body = await readJson<{ refreshToken?: string }>(event)
  return respond(async () => {
    await logout(body.refreshToken as string)
    return null
  })
})
