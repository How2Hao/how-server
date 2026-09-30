// 卡封面生成入参准备单测（纯函数，无网络）：base64/url 输入元信息、SSRF 防护、输出数量钳制
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  assertSafeRemoteHost,
  clampOutputCount,
  prepareEditInput,
  uniqueModels,
} from '~/server/utils/services/card-cover-qwen.ts'

const MAX_BYTES = 10 * 1024 * 1024

describe('prepareEditInput', () => {
  it('data URL base64：解析 mime 与字节长度', () => {
    const b64 = Buffer.from('fake-image-bytes').toString('base64')
    const out = prepareEditInput({ sourceBase64: `data:image/png;base64,${b64}` }, MAX_BYTES)
    expect(out.meta.sourceType).toBe('base64')
    expect(out.meta.mimeType).toBe('image/png')
    expect(out.meta.byteLength).toBe(Buffer.byteLength('fake-image-bytes'))
    expect(out.image.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('裸 base64 默认 image/jpeg，并剥离空白', () => {
    const b64 = Buffer.from('raw bytes here').toString('base64')
    const out = prepareEditInput({ sourceBase64: b64 }, MAX_BYTES)
    expect(out.meta.mimeType).toBe('image/jpeg')
    expect(out.meta.byteLength).toBeGreaterThan(0)
  })

  it('base64 为空 / 解码为空 → 抛错', () => {
    expect(() => prepareEditInput({}, MAX_BYTES)).toThrow('请传入 sourceBase64 或 sourceUrl')
    expect(() => prepareEditInput({ sourceBase64: '****' }, MAX_BYTES)).toThrow('sourceBase64 解码后内容为空')
  })

  it('超过大小上限 → 抛错（文案含 MB 上限）', () => {
    const smallLimit = 1024
    const b64 = Buffer.alloc(2048, 1).toString('base64')
    expect(() => prepareEditInput({ sourceBase64: b64 }, smallLimit))
      .toThrow('sourceBase64 图片过大')
  })

  it('url 输入：携带 host 元信息', () => {
    const out = prepareEditInput({ sourceUrl: 'https://cdn.example.com/a.jpg' }, MAX_BYTES)
    expect(out.meta.sourceType).toBe('url')
    expect(out.meta.urlHost).toBe('cdn.example.com')
    expect(out.image).toBe('https://cdn.example.com/a.jpg')
  })

  it('url 输入：非法 URL / 非 http(s) 协议 / 内网地址 → 抛错', () => {
    expect(() => prepareEditInput({ sourceUrl: 'not a url' }, MAX_BYTES)).toThrow('非法图片 URL')
    expect(() => prepareEditInput({ sourceUrl: 'ftp://cdn.example.com/a.jpg' }, MAX_BYTES))
      .toThrow('图片 URL 只支持 http/https')
    expect(() => prepareEditInput({ sourceUrl: 'http://localhost/a.jpg' }, MAX_BYTES))
      .toThrow('禁止使用内网图片地址')
    expect(() => prepareEditInput({ sourceUrl: 'http://192.168.1.10/a.jpg' }, MAX_BYTES))
      .toThrow('禁止使用内网图片地址')
    expect(() => prepareEditInput({ sourceUrl: 'http://172.16.0.1/a.jpg' }, MAX_BYTES))
      .toThrow('禁止使用内网图片地址')
  })
})

describe('assertSafeRemoteHost / uniqueModels / clampOutputCount', () => {
  it('公网地址放行，172.x 只拦 16–31 段', () => {
    expect(() => assertSafeRemoteHost('dashscope.aliyuncs.com')).not.toThrow()
    expect(() => assertSafeRemoteHost('172.32.0.1')).not.toThrow()
    expect(() => assertSafeRemoteHost('127.0.0.1')).toThrow()
  })

  it('uniqueModels 去重并过滤空串', () => {
    expect(uniqueModels(['a', 'b', 'a', '', 'b'])).toEqual(['a', 'b'])
  })

  it('clampOutputCount 钳制到 1–6', () => {
    expect(clampOutputCount(0)).toBe(1)
    expect(clampOutputCount(3)).toBe(3)
    expect(clampOutputCount(9)).toBe(6)
    expect(clampOutputCount(Number.NaN)).toBe(1)
  })
})
