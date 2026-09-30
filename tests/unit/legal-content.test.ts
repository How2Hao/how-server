// 法务静态页渲染单测（无 DB / 无网络）：markdown → HTML 包装
import { marked } from 'marked'
import { describe, expect, it } from 'vitest'
import {
  AGREEMENT_MD,
  PRIVACY_MD,
  renderLegalHtml,
  SUPPORT_MD,
} from '~/server/utils/legal-content.ts'

describe('法务 markdown 常量', () => {
  it('三段文案都非空且标题正确', () => {
    expect(PRIVACY_MD.startsWith('# i羊毛 隐私政策')).toBe(true)
    expect(SUPPORT_MD.startsWith('# i羊毛 支持中心')).toBe(true)
    expect(AGREEMENT_MD.startsWith('# i羊毛 用户服务协议')).toBe(true)
  })
})

describe('renderLegalHtml', () => {
  it('包装为完整 HTML：doctype / noindex / footer', () => {
    const html = renderLegalHtml('隐私政策 · i羊毛', '<h1>正文</h1>')
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<meta name="robots" content="noindex">')
    expect(html).toContain('<title>隐私政策 · i羊毛</title>')
    expect(html).toContain('<h1>正文</h1>')
    expect(html).toContain('© i羊毛 · com.how2hao')
    expect(html).toContain('content="width=device-width, initial-scale=1"')
  })

  it('标题做 HTML 转义', () => {
    const html = renderLegalHtml('<script>alert(1)</script>', 'body')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('与 marked 配合渲染 markdown 结构（h2/ul/a）', async () => {
    const body = await marked.parse('## 条款\n\n- 项目一\n\n[隐私政策](/privacy)')
    const html = renderLegalHtml('t', body)
    expect(html).toContain('<h2>条款</h2>')
    expect(html).toContain('<li>项目一</li>')
    expect(html).toContain('<a href="/privacy">隐私政策</a>')
  })
})
