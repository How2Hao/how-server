import { defineHandler } from 'nitro'
import { getRequestMeta, readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { passwordLogin } from '~/server/utils/services/auth.ts'

export default defineHandler(async (event) => {
  const body = await readJson<{ phone?: string, password?: string }>(event)
  return respond(() => passwordLogin(body.phone as string, body.password as string, getRequestMeta(event)))
})
