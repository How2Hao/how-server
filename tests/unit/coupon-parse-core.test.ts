// 优惠券 OCR 纯逻辑单测：模型输出 JSON 解析 / 视觉响应文本抽取 / 到期时间解析（无 DB、无网络）
import { describe, expect, it } from 'vitest'
import {
  extractVisionAssistantText,
  parseCouponJson,
  parseExpiryTs,
} from '~/server/utils/services/coupon-parse-core.ts'

describe('parseCouponJson（识别结果形状归一化）', () => {
  it('解析裸 JSON 数组', () => {
    const text = JSON.stringify([
      { bankName: '交通银行', amount: 30, condition: '满¥30.01可用', expiryDate: '有效期至2026/06/23 23:59', platform: 2 },
      { bankName: '邮政储蓄银行', amount: 2, condition: '储蓄卡立减金', expiryDate: '06月17日15:11过期', platform: 1 },
    ])
    const out = parseCouponJson(text)
    expect(out).toHaveLength(2)
    expect(out[0].bankName).toBe('交通银行')
    expect(out[1].platform).toBe(1)
  })

  it('剥离 ```json 代码块包裹', () => {
    const text = '```json\n[{"bankName":"招商银行","amount":10,"platform":2}]\n```'
    const out = parseCouponJson(text)
    expect(out).toHaveLength(1)
    expect(out[0].amount).toBe(10)
  })

  it('前后有噪声文本时从第一个 [ 开始截取', () => {
    const out = parseCouponJson('好的，以下是识别结果：[{"bankName":"建行"}]')
    expect(out).toHaveLength(1)
    expect(out[0].bankName).toBe('建行')
  })

  it('] 后还有尾随文本时 JSON.parse 失败 → 空数组（旧系统容错行为）', () => {
    expect(parseCouponJson('结果：[{"bankName":"建行"}] 请查收')).toEqual([])
  })

  it('非数组 / 完全无 JSON / 非对象元素 → 过滤或空数组', () => {
    expect(parseCouponJson('不是 JSON')).toEqual([])
    expect(parseCouponJson('{"bankName":"单对象"}')).toEqual([])
    expect(parseCouponJson('["字符串元素", null, {"bankName":"x"}]')).toEqual([
      { bankName: 'x' },
    ])
  })
})

describe('extractVisionAssistantText（OpenAI 兼容响应 → 模型文本）', () => {
  it('content 为字符串时直接返回', () => {
    const raw = JSON.stringify({ choices: [{ message: { content: '[]' } }] })
    expect(extractVisionAssistantText(raw)).toBe('[]')
  })

  it('content 为分段数组时拼接 text 字段', () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: [{ text: '[{"bankName":' }, { text: '"建行"}]' }] } }],
    })
    expect(extractVisionAssistantText(raw)).toBe('[{"bankName":"建行"}]')
  })

  it('非 JSON 输入返回原文（trim 后）', () => {
    expect(extractVisionAssistantText('  raw text  ')).toBe('raw text')
  })
})

describe('parseExpiryTs（到期时间原始文案 → 时间戳）', () => {
  const year = new Date().getFullYear()

  it('支付宝格式：MM月DD日HH:MM过期（年份取当年）', () => {
    expect(parseExpiryTs('06月17日15:11过期')).toBe(new Date(year, 5, 17, 15, 11, 0, 0).getTime())
  })

  it('支付宝格式：MM月DD日过期 → 当天 23:59', () => {
    expect(parseExpiryTs('06月17日过期')).toBe(new Date(year, 5, 17, 23, 59, 0, 0).getTime())
  })

  it('支付宝格式：今天/明天 HH:MM', () => {
    const now = new Date()
    const today = new Date(now)
    today.setHours(12, 30, 0, 0)
    expect(parseExpiryTs('今天12:30过期')).toBe(today.getTime())

    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(8, 0, 0, 0)
    expect(parseExpiryTs('明天8:00过期')).toBe(tomorrow.getTime())
  })

  it('微信格式：有效期至YYYY/MM/DD HH:MM（照抄原文，斜杠归一化）', () => {
    expect(parseExpiryTs('有效期至2026/06/23 23:59'))
      .toBe(new Date(2026, 5, 23, 23, 59, 0, 0).getTime())
  })

  it('点分隔日期归一化，且无时间时补 23:59', () => {
    expect(parseExpiryTs('2026.6.23')).toBe(new Date(2026, 5, 23, 23, 59, 0, 0).getTime())
  })

  it('mM-DD 短格式补当年；带明确时间时不做 23:59 兜底', () => {
    expect(parseExpiryTs('06-23 12:30')).toBe(new Date(year, 5, 23, 12, 30, 0, 0).getTime())
  })

  it('带"过期"但无法解析时间表达式 → null；无日期 → null', () => {
    expect(parseExpiryTs('过期规则 >')).toBeNull()
    expect(parseExpiryTs('')).toBeNull()
    expect(parseExpiryTs('星期三')).toBeNull()
  })
})
