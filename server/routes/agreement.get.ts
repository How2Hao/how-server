import { marked } from 'marked'
import { defineHandler } from 'nitro'
import { AGREEMENT_MD, renderLegalHtml } from '~/server/utils/legal-content.ts'

/** 公开静态页：用户协议；返回 HTML，无 JSON 包装 */
export default defineHandler(async () => {
  const html = renderLegalHtml('用户协议 · i羊毛', await marked.parse(AGREEMENT_MD))
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
})
