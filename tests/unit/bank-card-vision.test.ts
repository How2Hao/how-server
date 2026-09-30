// 银行卡视觉识别解析纯函数单测：不触网络（provider 调用与解析解耦）
import { describe, expect, it } from 'vitest'
import {
  assertProviderConfig,
  extractVisionAssistantText,
  parseVisionProviderFromQuery,
} from '~/server/utils/services/bank-card-vision-providers.ts'
import { inferImageMime, parseCoverImgPositionField, parseRecognitionArray } from '~/server/utils/services/bank-card-vision.ts'

describe('parseVisionProviderFromQuery', () => {
  it('glm/zhipu/bigmodel → glm；gemini/google → gemini；其余默认 qwen', () => {
    expect(parseVisionProviderFromQuery('glm')).toBe('glm')
    expect(parseVisionProviderFromQuery('Zhipu')).toBe('glm')
    expect(parseVisionProviderFromQuery('bigmodel')).toBe('glm')
    expect(parseVisionProviderFromQuery('gemini')).toBe('gemini')
    expect(parseVisionProviderFromQuery('google')).toBe('gemini')
    expect(parseVisionProviderFromQuery('qwen')).toBe('qwen')
    expect(parseVisionProviderFromQuery(undefined)).toBe('qwen')
    expect(parseVisionProviderFromQuery('junk')).toBe('qwen')
  })
})

describe('assertProviderConfig', () => {
  const cfg = {
    dashscopeApiKey: 'dash-key',
    zhipuApiKey: 'zhipu-key',
    geminiApiKey: 'gemini-key',
  }

  it('配置齐全时全部通过', () => {
    expect(() => assertProviderConfig('qwen', cfg)).not.toThrow()
    expect(() => assertProviderConfig('glm', cfg)).not.toThrow()
    expect(() => assertProviderConfig('gemini', cfg)).not.toThrow()
  })

  it('缺失密钥时抛出与旧系统一致的中文错误', () => {
    expect(() => assertProviderConfig('qwen', {})).toThrow('千问需配置 DASHSCOPE_API_KEY（或 bankCardVision.dashscopeApiKey）')
    expect(() => assertProviderConfig('glm', {})).toThrow('GLM 需配置 ZHIPU_API_KEY（或 bankCardVision.zhipuApiKey）')
    expect(() => assertProviderConfig('gemini', {})).toThrow('Gemini 需配置 GEMINI_API_KEY（或 bankCardVision.geminiApiKey）')
  })

  it('空白字符串视为未配置', () => {
    expect(() => assertProviderConfig('qwen', { dashscopeApiKey: '   ' })).toThrow()
  })
})

describe('extractVisionAssistantText', () => {
  it('openAI 兼容：content 字符串', () => {
    const raw = JSON.stringify({ choices: [{ message: { content: '{"cards":[]}' } }] })
    expect(extractVisionAssistantText(raw, 'qwen')).toBe('{"cards":[]}')
  })

  it('openAI 兼容：content 分段数组拼接', () => {
    const raw = JSON.stringify({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] })
    expect(extractVisionAssistantText(raw, 'glm')).toBe('ab')
  })

  it('gemini：candidates[0].content.parts 拼接', () => {
    const raw = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }, { text: 'y' }] } }] })
    expect(extractVisionAssistantText(raw, 'gemini')).toBe('xy')
  })

  it('gemini：错误响应透出 error.message', () => {
    const raw = JSON.stringify({ error: { message: 'API key invalid' } })
    expect(extractVisionAssistantText(raw, 'gemini')).toBe('API key invalid')
  })

  it('非 JSON 原样返回', () => {
    expect(extractVisionAssistantText('boom', 'qwen')).toBe('boom')
  })
})

describe('parseRecognitionArray（模型输出 → 识别结果）', () => {
  it('标准 {cards:[...]} 包装 + 蛇形命名兼容', () => {
    const text = JSON.stringify({
      cards: [
        { bankName: '招商银行', cardLastFour: '1234', cardType: '信用卡', coverImgPosition: [10, 20, 110, 220] },
        { bank_name: '工商银行', card_last_four: '5678', card_type: '借记卡', cover_img_position: [30, 40, 130, 240] },
      ],
    })
    const items = parseRecognitionArray(text)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ bankName: '招商银行', cardType: '信用卡', cardLastFour: '1234', coverImgPosition: [10, 20, 110, 220] })
    expect(items[1]).toMatchObject({ bankName: '工商银行', cardType: '借记卡', cardLastFour: '5678', coverImgPosition: [30, 40, 130, 240] })
  })

  it('裸数组直接解析', () => {
    const items = parseRecognitionArray('[{"bankName":"建行","cardLastFour":"9999"}]')
    expect(items).toHaveLength(1)
    expect(items[0].bankName).toBe('建行')
  })

  it('单个对象包装为单元素数组', () => {
    const items = parseRecognitionArray('{"bankName":"中行","cardLastFour":"0000"}')
    expect(items).toHaveLength(1)
    expect(items[0].cardLastFour).toBe('0000')
  })

  it('坐标为字符串（JSON 数组）也能解析', () => {
    const items = parseRecognitionArray('[{"bankName":"交行","coverImgPosition":"[1, 2, 3, 4]"}]')
    expect(items[0].coverImgPosition).toEqual([1, 2, 3, 4])
  })

  it('parseCoverImgPositionField：数组 / 字符串 / 缺陷输入', () => {
    expect(parseCoverImgPositionField([1, 2, 3, 4])).toEqual([1, 2, 3, 4])
    expect(parseCoverImgPositionField('[1, 2, 3, 4]')).toEqual([1, 2, 3, 4])
    expect(parseCoverImgPositionField(undefined)).toBeUndefined()
    expect(parseCoverImgPositionField('')).toBeUndefined()
    expect(parseCoverImgPositionField([1, 2, 3])).toBeUndefined()
    expect(parseCoverImgPositionField('["a", 2, 3, 4]')).toBeUndefined()
  })

  it('坐标不足 4 位 / 含非数字 → undefined', () => {
    const items = parseRecognitionArray('[{"bankName":"x","coverImgPosition":[1,2,3]}]')
    expect(items[0].coverImgPosition).toBeUndefined()
    const items2 = parseRecognitionArray('[{"bankName":"x","bbox":["a",2,3,4]}]')
    expect(items2[0].coverImgPosition).toBeUndefined()
  })

  it('文本含围栏或前后废话时仍能提取数组', () => {
    const text = '好的，以下是识别结果：```json\n[{"bankName":"招行","cardLastFour":"4321"}]\n``` 以上。'
    const items = parseRecognitionArray(text)
    expect(items[0].cardLastFour).toBe('4321')
  })

  it('非法 JSON 抛出可读错误', () => {
    expect(() => parseRecognitionArray('完全不是 JSON')).toThrow('无法解析模型返回的 JSON')
  })

  it('数组元素非对象抛出带序号的错误', () => {
    expect(() => parseRecognitionArray('["oops"]')).toThrow('数组第 1 项不是对象')
  })
})

describe('inferImageMime', () => {
  it('格式映射 + fallback 透传 + 默认 jpeg', () => {
    expect(inferImageMime('png', 'image/jpeg')).toBe('image/png')
    expect(inferImageMime('jpg', '')).toBe('image/jpeg')
    expect(inferImageMime(undefined, 'image/webp')).toBe('image/webp')
    expect(inferImageMime(undefined, 'application/octet-stream')).toBe('image/jpeg')
    expect(inferImageMime(undefined, '')).toBe('image/jpeg')
  })
})
