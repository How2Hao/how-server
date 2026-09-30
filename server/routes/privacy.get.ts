import { marked } from 'marked'
import { defineHandler } from 'nitro'
import { PRIVACY_MD, renderLegalHtml } from '~/server/utils/legal-content.ts'

/** 公开静态页：App Store Connect 隐私政策要求公网可访问；返回 HTML，无 JSON 包装 */
export default defineHandler(async () => {
  const html = renderLegalHtml('隐私政策 · i羊毛', await marked.parse(PRIVACY_MD))
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
})
