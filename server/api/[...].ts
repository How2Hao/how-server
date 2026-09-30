// API 404 兜底：未匹配的 /api/* 路径返回统一错误结构（防止落入 HTML 渲染器）
import { defineHandler } from 'nitro'

export default defineHandler(() => {
  return Response.json({ success: false, message: 'Not Found', data: null }, { status: 404 })
})
