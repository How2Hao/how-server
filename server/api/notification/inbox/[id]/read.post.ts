import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { markInboxRead } from '~/server/utils/services/inbox.ts'

/** 标单条已读（仅 read_at IS NULL 时生效；首次触发会给 push_task.stats_opened +1） */
export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const id = event.context.params?.id ?? ''
  return respond(async () => {
    const inboxId = Number(id)
    if (!Number.isInteger(inboxId) || inboxId <= 0)
      throw new Error('inbox id 不合法')
    const ok = await markInboxRead(userId, inboxId)
    return { ok }
  })
})
