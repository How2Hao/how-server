import { defineHandler } from 'nitro'
import { getAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { fail, respond } from '~/server/utils/response.ts'
import { createReminderTasksForJobOccurrence } from '~/server/utils/services/job-template.ts'

// 达标后提醒：按 reminder_template 在权益窗口内展开；body { occurrenceId? , date? }
export default defineHandler(async (event) => {
  const authUser = getAuth(event)
  if (!authUser)
    return fail('未登录')
  const id = Number.parseInt(event.context.params?.id ?? '', 10)
  const body = await readJson(event)
  return respond(() => createReminderTasksForJobOccurrence(authUser.userId, id, body))
})
