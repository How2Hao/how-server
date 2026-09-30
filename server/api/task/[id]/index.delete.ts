import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { deleteTask } from '~/server/utils/services/task.ts'

// DELETE 带 JSON body：{ occurrenceDate?, deleteFuture===true } → deleteFuture 截断循环任务
export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const id = event.context.params?.id ?? ''
  const body = await readJson(event)
  return respond(async () => {
    const success = await deleteTask(userId, id, {
      occurrenceDate: body.occurrenceDate as number | undefined,
      deleteFuture: body.deleteFuture === true,
    })
    if (!success)
      throw new Error('Task not found')
    return null
  })
})
