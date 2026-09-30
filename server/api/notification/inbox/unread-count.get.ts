import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { getInboxUnreadCount } from '~/server/utils/services/inbox.ts'

/** 未读数（红点用，轻量） */
export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  return respond(async () => {
    const count = await getInboxUnreadCount(userId)
    return { count }
  })
})
