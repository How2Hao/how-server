// 统一错误响应：HTTPError → { success, message, data }（业务错误由 respond() 在 200 内处理）
import { defineErrorHandler } from 'nitro'

export default defineErrorHandler((error, event) => {
  const status = (error as { status?: number }).status ?? 500
  const message = status >= 500 ? (error instanceof Error ? error.message : 'Internal Server Error') : (error as { message?: string }).message || 'Request Failed'
  if (status >= 500) {
    console.error(`[${event.req?.method}] ${event.req?.url}`, error)
  }
  return Response.json({ success: false, message, data: null }, { status })
})
