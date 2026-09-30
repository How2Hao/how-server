import { defineHandler } from 'nitro'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { phoneStatus } from '~/server/utils/services/auth.ts'

export default defineHandler(async (event) => {
  const body = await readJson<{ phone?: string }>(event)
  return respond(() => phoneStatus(body.phone as string))
})
