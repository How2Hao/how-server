import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { createCategory } from '~/server/utils/services/acc.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const body = await readJson(event)
  return respond(() => createCategory({
    userId,
    type: body.type as 'INCOME' | 'EXPENSE',
    name: body.name as string,
    icon: body.icon as string | undefined,
    sortOrder: body.sortOrder as number | undefined,
  }))
})
