import type { H3Event } from 'nitro/h3'
// 全局鉴权中间件：路径前缀白名单 + Bearer token 解析（与旧系统 AuthMiddleware 语义一致）
import { defineHandler } from 'nitro'
import { verifyAccessTokenAndGetUser } from '~/server/utils/session.ts'

function requiresAuth(path: string): boolean {
  // 接口规范路径为 /api/*；旧根路径经 routeRules 代理进来时同样剥掉前缀后匹配
  if (path.startsWith('/api/'))
    path = path.slice(4)
  if (!path.startsWith('/'))
    return false

  if (path.startsWith('/auth/me'))
    return true
  if (path.startsWith('/auth/logout'))
    return true
  if (path.startsWith('/auth/bind-phone'))
    return true
  if (path.startsWith('/auth/password/set'))
    return true

  if (path.startsWith('/acc'))
    return true
  if (path.startsWith('/task/'))
    return true
  if (path === '/task')
    return true
  if (path.startsWith('/bank_card'))
    return true

  if (path.startsWith('/task-template/') && path.endsWith('/like'))
    return true
  if (path.startsWith('/task-template/') && path.endsWith('/feedback'))
    return true
  if (path.startsWith('/task-template/') && path.endsWith('/pin'))
    return true

  if (path.startsWith('/upload'))
    return true
  if (path.startsWith('/user/settings'))
    return true
  if (path.startsWith('/feedback'))
    return true
  if (path.startsWith('/notification/'))
    return true

  return false
}

function extractAccessToken(event: H3Event): string | null {
  const authHeader = event.req.headers.get('authorization') || ''
  if (!/^Bearer\s/i.test(authHeader))
    return null
  // 拆分替换而非单条捕获正则，避免 \s+ 与 .+ 交换导致的超线性回溯
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  return token || null
}

function unauthorized(message: string): Response {
  return Response.json({ success: false, message, data: null }, { status: 401 })
}

export default defineHandler(async (event): Promise<Response | void> => {
  const path = event.url.pathname
  const needsAuth = requiresAuth(path)
  const accessToken = extractAccessToken(event)

  // 未带 token：受保护路径 401，公共路径放行
  if (!accessToken) {
    if (needsAuth)
      return unauthorized('未登录')
    return
  }

  // 带 token：无论路径是否受保护都尝试解析（公共接口依赖它做个性化）
  const authUser = await verifyAccessTokenAndGetUser(accessToken)
  if (!authUser) {
    if (needsAuth)
      return unauthorized('登录态已失效')
    return
  }
  event.context.auth = authUser
})
