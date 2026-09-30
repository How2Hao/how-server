import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { createLedger } from '~/server/utils/services/acc.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const body = await readJson(event)
  return respond(() => createLedger({
    userId,
    name: body.name as string,
    description: body.description as string | undefined,
    icon: body.icon as string | undefined,
    currency: body.currency as string | undefined,
    isDefault: body.isDefault ? 1 : 0,
  }))
})
