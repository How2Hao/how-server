import type { IBankSmsRuleVo } from '~/server/utils/types.ts'
// 账单短信解析纯函数单测：不触 db / 网络（service 模块顶层的 mysql 连接池是惰性的，import 不会建连）
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPrompt,
  extractAssistantText,
  getSenderMatchMode,
  isTemplateLikelyMatch,
  isTemplatePrefixMatched,
  normalizeBankName,
  parseBillAmountFromSms,
  parseByGivenRules,
  parseByRegexTemplate,
  parseModelResult,
  parseSingleSms,
  parseSmsNumbersCsv,
} from '~/server/utils/services/sms-bill-parse.ts'

const MINSHENG_SMS = '【民生银行】您人民币/美元账户信用卡03月账单：人民币应还1129.00元、最低还款100.00元，最后还款日04月14日。'

function rule(partial: Partial<IBankSmsRuleVo>): IBankSmsRuleVo {
  return {
    id: partial.id ?? 1,
    bankId: partial.bankId ?? '4',
    bankName: partial.bankName ?? '民生银行',
    smsNumbersCsv: partial.smsNumbersCsv ?? '95568,106920595568',
    smsTemplate: partial.smsTemplate ?? '【民生银行】您人民币/美元账户信用卡{月}月账单：人民币应还{x}元、最低还款{y}元，最后还款日{月}{日}日。',
    isEnabled: partial.isEnabled ?? 1,
  }
}

describe('parseByRegexTemplate（正则提取管线）', () => {
  it('民生银行示例：应还/最低还款/还款日/账单月全命中', () => {
    const parsed = parseByRegexTemplate(MINSHENG_SMS)
    expect(parsed.billAmount).toBe(1129.00)
    expect(parsed.minPayment).toBe(100.00)
    expect(parsed.statementMonth).toBe(3)
    expect(parsed.dueDateMonth).toBe(4)
    expect(parsed.dueDateDay).toBe(14)
    expect(parsed.dueDateText).toBe('4月14日')
    expect(parsed.bankName).toBe('民生银行')
    expect(parsed.currency).toBe('CNY')
    expect(parsed.reason).toBe('regex_template_matched')
    expect(parsed.confidence).toBe(0.99)
  })

  it('兴业：本期账单￥金额优先', () => {
    const parsed = parseByRegexTemplate('【兴业银行】您的信用卡本期账单￥1,234.50元，最后还款日05月20日')
    expect(parsed.billAmount).toBe(1234.5)
    expect(parsed.bankName).toBe('兴业银行')
    expect(parsed.dueDateDay).toBe(20)
  })

  it('通用「应还」兜底（含中文冒号后直接跟金额）', () => {
    const parsed = parseByRegexTemplate('【XX银行】您本期应还款88.00元')
    expect(parsed.billAmount).toBe(88)
  })

  it('未命中应还金额：billAmount null + 中文 reason + confidence 0', () => {
    const parsed = parseByRegexTemplate('【XX银行】您的信用卡已激活')
    expect(parsed.billAmount).toBeNull()
    expect(parsed.reason).toBe('规则解析未命中应还金额')
    expect(parsed.confidence).toBe(0)
  })

  it('美元账单 currency=USD', () => {
    const parsed = parseByRegexTemplate('【XX银行】美元账户信用卡03月账单：美元应还100.00元')
    expect(parsed.currency).toBe('USD')
  })

  it('尾号提取：尾号/末四位/星号/卡号后缀', () => {
    expect(parseByRegexTemplate('【XX银行】尾号1234的信用卡应还1.00元').cardLastFour).toBe('1234')
    expect(parseByRegexTemplate('【XX银行】信用卡末四位 5678 应还1.00元').cardLastFour).toBe('5678')
    expect(parseByRegexTemplate('【XX银行】****9012 应还1.00元').cardLastFour).toBe('9012')
    expect(parseByRegexTemplate('【XX银行】您的信用卡3456应还1.00元').cardLastFour).toBe('3456')
  })

  it('opts.bankName 作为无【】正文时的银行名兜底', () => {
    const parsed = parseByRegexTemplate('信用卡03月账单：人民币应还10.00元', { bankName: '招商银行' })
    expect(parsed.bankName).toBe('招商银行')
  })
})

describe('parseModelResult（LLM 返回解析）', () => {
  it('解析围栏 JSON 并归一化字段', () => {
    const content = '```json\n{"billAmount": "1,234.50元", "currency": "CNY", "bankName": " 民生银行 ", "cardLastFour": "尾号 4567", "statementMonth": 3, "minPayment": 100, "dueDateMonth": 15, "dueDateDay": 14, "templateSimilarity": 1.5, "confidence": 0.8, "reason": "ok"}\n```'
    const parsed = parseModelResult(content)
    expect(parsed.billAmount).toBe(1234.5)
    expect(parsed.bankName).toBe('民生银行')
    expect(parsed.cardLastFour).toBe('4567')
    // 非法月份 → null；越界的相似度/置信度 → 裁剪到 0-1
    expect(parsed.dueDateMonth).toBeUndefined()
    expect(parsed.dueDateText).toBeUndefined()
    expect(parsed.templateSimilarity).toBe(1)
    expect(parsed.confidence).toBe(0.8)
  })

  it('dueDateText 未提供时由月日拼接', () => {
    const parsed = parseModelResult('{"billAmount": 1, "dueDateMonth": 4, "dueDateDay": 14}')
    expect(parsed.dueDateText).toBe('4月14日')
  })

  it('非法 JSON → billAmount null + 中文 reason', () => {
    const parsed = parseModelResult('我也不知道')
    expect(parsed.billAmount).toBeNull()
    expect(parsed.reason).toBe('模型返回不是合法 JSON')
    expect(parsed.confidence).toBe(0)
    expect(parsed.currency).toBe('CNY')
  })

  it('从前缀废话中截取 {…} 解析', () => {
    const parsed = parseModelResult('结果如下：{"billAmount": 66.6, "reason": "ok"} 请查收')
    expect(parsed.billAmount).toBe(66.6)
  })
})

describe('extractAssistantText（OpenAI 兼容响应）', () => {
  it('content 为字符串', () => {
    const raw = JSON.stringify({ choices: [{ message: { content: ' hi ' } }] })
    expect(extractAssistantText(raw)).toBe('hi')
  })

  it('content 为分段数组', () => {
    const raw = JSON.stringify({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] })
    expect(extractAssistantText(raw)).toBe('ab')
  })

  it('非 JSON 输入原样返回', () => {
    expect(extractAssistantText('oops')).toBe('oops')
  })
})

describe('发件号匹配（getSenderMatchMode / parseSmsNumbersCsv）', () => {
  it('eXACT / ENDS_WITH / CONTAINS / null', () => {
    expect(getSenderMatchMode('95568', '95568')).toBe('EXACT')
    expect(getSenderMatchMode('5568', '106920595568')).toBe('ENDS_WITH')
    // ENDS_WITH 无长度限制（与旧实现一致）
    expect(getSenderMatchMode('123', '9123')).toBe('ENDS_WITH')
    expect(getSenderMatchMode('1234', '512349')).toBe('CONTAINS')
    // CONTAINS 要求规则号至少 4 位
    expect(getSenderMatchMode('123', '91234')).toBeNull()
    expect(getSenderMatchMode('95568', '')).toBeNull()
    expect(getSenderMatchMode('', '95568')).toBeNull()
  })

  it('cSV 去重、剔除非数字项', () => {
    expect(parseSmsNumbersCsv('95568, 106920595568 ,95568,abc')).toEqual(['95568', '106920595568'])
    expect(parseSmsNumbersCsv('')).toEqual([])
  })
})

describe('模板匹配（isTemplatePrefixMatched / isTemplateLikelyMatch / normalizeBankName）', () => {
  it('前缀匹配：空白归一化 + 开头或包含命中', () => {
    const template = '【民生银行】您人民币账户'
    expect(isTemplatePrefixMatched('【民生银行】您人民币账户信用卡账单', template)).toBe(true)
    expect(isTemplatePrefixMatched('【民生银行】 您 人 民 币 账 户...', template)).toBe(true)
    expect(isTemplatePrefixMatched('【招商银行】完全不同', template)).toBe(false)
  })

  it('isTemplateLikelyMatch：银行名+1 关键词 / 2 关键词 / 3 泛关键词', () => {
    const r = rule({ bankName: '民生银行', smsTemplate: '账单 应还 最低还款' })
    expect(isTemplateLikelyMatch('【民生银行】账单已出', r)).toBe(true)
    expect(isTemplateLikelyMatch('账单 应还', r)).toBe(true)
    expect(isTemplateLikelyMatch('账单 最低还款 最后还款日', r)).toBe(true)
    expect(isTemplateLikelyMatch('您的验证码是123456', r)).toBe(false)
  })

  it('normalizeBankName 去掉「银行/信用卡/【】/空白」', () => {
    expect(normalizeBankName('【民生银行】信用卡')).toBe('民生')
    expect(normalizeBankName(' 民 生 银行 ')).toBe('民生')
  })
})

describe('parseByGivenRules（规则匹配 → 解析 → 去重，纯管线不触网）', () => {
  it('号码 EXACT 命中 + 解析结果带 ruleId/bankId/matchMode', async () => {
    const out = await parseByGivenRules(
      [{ address: '95568', body: MINSHENG_SMS, date: 1000 }],
      [rule({ id: 7, bankId: '4' })],
    )
    expect(out).toHaveLength(1)
    expect(out[0].bankId).toBe('4')
    expect(out[0].sourceRuleId).toBe(7)
    expect(out[0].matchedRuleNumber).toBe('95568')
    expect(out[0].matchMode).toBe('EXACT')
    expect(out[0].sourceAddress).toBe('95568')
    expect(out[0].sourceDate).toBe(1000)
    expect(out[0].billAmount).toBe(1129)
  })

  it('号码不匹配但模板前缀命中且疑似模板 → TEMPLATE_PREFIX', async () => {
    const out = await parseByGivenRules(
      [{ address: '10657120511611', body: MINSHENG_SMS }],
      [rule({})],
    )
    expect(out).toHaveLength(1)
    expect(out[0].matchMode).toBe('TEMPLATE_PREFIX')
    expect(out[0].matchedRuleNumber).toBeUndefined()
  })

  it('同 (bankId, 卡尾四, 还款日, 金额) 去重，保留时间最新', async () => {
    const out = await parseByGivenRules(
      [
        { address: '95568', body: MINSHENG_SMS, date: 1000 },
        { address: '106920595568', body: MINSHENG_SMS, date: 2000 },
      ],
      [rule({})],
    )
    expect(out).toHaveLength(1)
    expect(out[0].sourceDate).toBe(2000)
  })

  it('模板前缀不命中 → 不产出', async () => {
    const out = await parseByGivenRules(
      [{ address: '95568', body: '您的验证码是 246810，请勿泄露' }],
      [rule({})],
    )
    expect(out).toEqual([])
  })
})

describe('parseSingleSms / parseBillAmountFromSms', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('空文本抛「smsText 不能为空」', async () => {
    await expect(parseBillAmountFromSms('   ')).rejects.toThrow('smsText 不能为空')
  })

  it('正则命中时不调用 LLM（缺 API key 也能解析）', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', '')
    const parsed = await parseBillAmountFromSms(MINSHENG_SMS)
    expect(parsed.billAmount).toBe(1129)
    expect(parsed.raw).toBe(MINSHENG_SMS)
  })

  it('正则未命中 → 走 DashScope qwen-plus 兜底（fetch 已 stub）', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'test-key')
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      expect(String(url)).toContain('/compatible-mode/v1/chat/completions')
      const body = JSON.parse(init.body)
      expect(body.model).toBe('qwen-plus')
      expect(init.headers.Authorization).toBe('Bearer test-key')
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"billAmount": 321.00, "currency": "CNY", "reason": "模型命中"}' } }],
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const parsed = await parseSingleSms({ body: '【XX银行】一些非常规表述 2024-03-15' }, { bankName: 'XX银行' })
    expect(parsed.billAmount).toBe(321)
    expect(parsed.raw).toContain('模型命中')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('未配置 DASHSCOPE_API_KEY 且正则未命中 → 抛错', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', '')
    await expect(parseSingleSms({ body: '【XX银行】一些非常规表述' })).rejects.toThrow('缺少 DASHSCOPE_API_KEY，无法调用短信解析模型')
  })
})

describe('buildPrompt', () => {
  it('包含目标银行、模板样例与短信正文', () => {
    const prompt = buildPrompt('短信内容', '模板样例X', '民生银行')
    expect(prompt).toContain('目标银行：民生银行')
    expect(prompt).toContain('模板样例：模板样例X')
    expect(prompt).toContain('短信正文：短信内容')
    expect(prompt).toContain('templateSimilarity')
  })
})
