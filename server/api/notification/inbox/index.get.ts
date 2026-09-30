import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { listInbox } from '~/server/utils/services/inbox.ts'

/** inbox 列表（cursor 翻页，cursor=null 拉第一页；cursor 为上一页最后一条的 inboxId） */
export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const q = query(event)
  const cursorParam = q.get('cursor')
  const cursor = cursorParam ? Number(cursorParam) : null
  const limit = Math.min(Math.max(Number(q.get('limit')) || 20, 1), 100)
  return respond(async () => {
    const list = await listInbox(userId, cursor, limit)
    const nextCursor = list.length > 0 ? list[list.length - 1].inboxId : null
    return { list, nextCursor, hasMore: list.length === limit }
  })
})
