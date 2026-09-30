import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { createTask } from '~/server/utils/services/task.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const body = await readJson(event)
  return respond(() => createTask(userId, body))
})
