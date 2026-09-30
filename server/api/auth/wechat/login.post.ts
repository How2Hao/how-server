import { defineHandler } from 'nitro'
import { getRequestMeta, readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { wechatLogin } from '~/server/utils/services/auth.ts'

export default defineHandler(async (event) => {
  const body = await readJson<{ appId?: string, unionid?: string, openid?: string, username?: string, avatar?: string }>(event)
  return respond(() => wechatLogin({
    appId: body.appId,
    unionid: body.unionid,
    openid: body.openid,
    username: body.username,
    avatar: body.avatar,
    meta: getRequestMeta(event),
  }))
})
