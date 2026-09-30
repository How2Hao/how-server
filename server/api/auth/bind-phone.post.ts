import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { getRequestMeta, readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { bindPhone } from '~/server/utils/services/auth.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const body = await readJson<{ phone?: string, providerRequestId?: string, code?: string }>(event)
  return respond(() => bindPhone(userId, body.phone as string, body.providerRequestId as string | undefined, body.code as string | undefined, getRequestMeta(event)))
})
