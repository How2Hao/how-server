// 反馈提交纯校验单测（无 DB）：context 清洗 / 提交入参校验
import { describe, expect, it } from 'vitest'
import {
  parseFeedbackSubmitInput,
  sanitizeContext,
} from '~/server/utils/services/feedback-core.ts'

describe('sanitizeContext（context 环境快照清洗）', () => {
  it('接受纯对象并原样返回', () => {
    const ctx = { appVersion: '1.0.0', os: 'iOS 18.0', network: 'wifi' }
    expect(sanitizeContext(ctx)).toBe(ctx)
  })

  it('拒绝 null / 数组 / 原始类型', () => {
    expect(sanitizeContext(null)).toBeNull()
    expect(sanitizeContext(undefined)).toBeNull()
    expect(sanitizeContext(['a', 'b'])).toBeNull()
    expect(sanitizeContext('device=ios')).toBeNull()
    expect(sanitizeContext(42)).toBeNull()
  })

  it('超过 8KB 的大对象 → null（静默丢弃）', () => {
    const big = { blob: 'x'.repeat(8 * 1024) }
    expect(sanitizeContext(big)).toBeNull()
  })

  it('刚好 8KB 内的对象保留', () => {
    const ok = { blob: 'x'.repeat(1000) }
    expect(sanitizeContext(ok)).toEqual(ok)
  })
})

describe('parseFeedbackSubmitInput（提交校验）', () => {
  it('合法输入：type 归一化为大写，content trim', () => {
    const out = parseFeedbackSubmitInput({ type: 'bug', content: '  卡面识别不准  ' })
    expect(out).toEqual({ type: 'BUG', content: '卡面识别不准', images: [], context: null })
  })

  it('type 非法 → 抛"反馈类型无效"', () => {
    expect(() => parseFeedbackSubmitInput({ type: 'OTHER', content: 'x' })).toThrow('反馈类型无效')
    expect(() => parseFeedbackSubmitInput({ content: 'x' })).toThrow('反馈类型无效')
  })

  it('content 为空 → 抛"请填写反馈内容"', () => {
    expect(() => parseFeedbackSubmitInput({ type: 'BUG', content: '   ' })).toThrow('请填写反馈内容')
    expect(() => parseFeedbackSubmitInput({ type: 'BUG' })).toThrow('请填写反馈内容')
  })

  it('images 截断到最多 3 张，非数组 → []', () => {
    const many = ['a', 'b', 'c', 'd', 'e']
    expect(parseFeedbackSubmitInput({ type: 'CARD_FACE', content: 'x', images: many }).images)
      .toEqual(['a', 'b', 'c'])
    expect(parseFeedbackSubmitInput({ type: 'CARD_FACE', content: 'x', images: 'nope' }).images)
      .toEqual([])
  })

  it('context 合法时保留', () => {
    const ctx = { appVersion: '1.2.3' }
    expect(parseFeedbackSubmitInput({ type: 'FEATURE', content: 'x', context: ctx }).context)
      .toEqual(ctx)
  })
})
