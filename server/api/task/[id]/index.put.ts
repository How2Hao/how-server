import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { updateTask } from '~/server/utils/services/task.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const id = event.context.params?.id ?? ''
  const body = await readJson(event)
  return respond(async () => {
    const task = await updateTask(userId, id, body)
    if (!task)
      throw new Error('Task not found')
    return task
  })
})
