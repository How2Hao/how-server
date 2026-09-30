import { defineHandler } from 'nitro'
import { getRequestMeta, readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { registerWithPassword } from '~/server/utils/services/auth.ts'

export default defineHandler(async (event) => {
  const body = await readJson<{ phone?: string, providerRequestId?: string, code?: string, password?: string }>(event)
  return respond(() => registerWithPassword({
    phone: body.phone as string,
    providerRequestId: body.providerRequestId as string | undefined,
    code: body.code as string | undefined,
    password: body.password as string,
    meta: getRequestMeta(event),
  }))
})
