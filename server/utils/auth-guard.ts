import type { H3Event } from 'nitro/h3'
import type { AuthUser } from '~/server/utils/session.ts'
// 路由鉴权守卫：从 event.context 读取全局中间件解析出的登录用户
import { HTTPError } from 'nitro'

/** 可选登录用户（公共接口个性化场景）；未登录返回 null */
export function getAuth(event: H3Event): AuthUser | null {
  return (event.context as { auth?: AuthUser | null }).auth ?? null
}

/** 必须登录；未登录抛 401（{ success:false, message:'未登录' }） */
export function requireAuth(event: H3Event): AuthUser {
  const authUser = getAuth(event)
  if (!authUser) {
    throw new HTTPError({ status: 401, message: '未登录' })
  }
  return authUser
}
