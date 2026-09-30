import { defineHandler, getRouterParam } from 'nitro/h3'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { updateAccUser } from '~/server/utils/services/acc.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const id = Number.parseInt(getRouterParam(event, 'id') ?? '', 10)
  // 旧 controller 总是传 username/avatar 两个键：avatar 键恒存在（缺省即清空）
  const body = await readJson(event)
  return respond(async () => {
    if (Number.isNaN(id)) {
      throw new TypeError('记账账号不存在')
    }
    return updateAccUser(userId, id, {
      username: body.username as string | undefined,
      avatar: body.avatar as string | null | undefined,
    })
  })
})
