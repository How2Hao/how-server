import { defineHandler } from 'nitro'
import { getRequestMeta, readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { refresh } from '~/server/utils/services/auth.ts'

export default defineHandler(async (event) => {
  const body = await readJson<{ refreshToken?: string }>(event)
  return respond(() => refresh(body.refreshToken as string, getRequestMeta(event)))
})
