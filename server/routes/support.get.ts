import { marked } from 'marked'
import { defineHandler } from 'nitro'
import { renderLegalHtml, SUPPORT_MD } from '~/server/utils/legal-content.ts'

/** 公开静态页：App Store Connect 支持页要求公网可访问；返回 HTML，无 JSON 包装 */
export default defineHandler(async () => {
  const html = renderLegalHtml('支持中心 · i羊毛', await marked.parse(SUPPORT_MD))
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
})
