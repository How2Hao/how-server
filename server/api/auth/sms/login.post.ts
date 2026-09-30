import { defineHandler } from 'nitro'
import { getRequestMeta, readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { smsLogin } from '~/server/utils/services/auth.ts'

export default defineHandler(async (event) => {
  const body = await readJson<{ phone: string, scene?: string, providerRequestId?: string, code?: string }>(event)
  return respond(() => smsLogin({
    phone: body.phone as string,
    scene: (body.scene as string) || 'LOGIN',
    providerRequestId: body.providerRequestId as string | undefined,
    code: body.code as string | undefined,
    meta: getRequestMeta(event),
  }))
})
