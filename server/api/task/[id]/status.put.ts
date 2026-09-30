import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { updateTaskStatus } from '~/server/utils/services/task.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const id = event.context.params?.id ?? ''
  const body = await readJson<{ status: string, occurrenceDate?: number }>(event)
  return respond(async () => {
    if (!body.status)
      throw new Error('Status is required')
    const task = await updateTaskStatus(userId, id, body.status, body.occurrenceDate)
    if (!task)
      throw new Error('Task not found')
    return task
  })
})
