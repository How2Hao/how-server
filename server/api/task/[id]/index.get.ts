import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { getTaskById } from '~/server/utils/services/task.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const id = event.context.params?.id ?? ''
  return respond(async () => {
    const task = await getTaskById(userId, id)
    if (!task)
      throw new Error('Task not found')
    return task
  })
})
