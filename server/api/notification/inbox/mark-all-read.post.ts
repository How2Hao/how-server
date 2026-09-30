import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { markAllInboxRead } from '~/server/utils/services/inbox.ts'

/** 全部已读（批量 dismiss，不写 opened_via） */
export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  return respond(async () => {
    const affected = await markAllInboxRead(userId)
    return { affected }
  })
})
