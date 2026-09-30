import { defineHandler } from 'nitro'
import { getRequestMeta, readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { sendSmsCode } from '~/server/utils/services/auth.ts'

export default defineHandler(async (event) => {
  const body = await readJson<{ phone: string, scene?: string }>(event)
  return respond(() => sendSmsCode(body.phone as string, (body.scene as string) || 'LOGIN', getRequestMeta(event)))
})
