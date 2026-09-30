import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { getBillReminderTasks } from '~/server/utils/services/task.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  return respond(() => getBillReminderTasks(userId))
})
