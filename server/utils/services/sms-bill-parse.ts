import type {
  IBankCardSmsSenderInfo,
  IBankSmsRuleVo,
  ISmsBillParseBatchItem,
  ISmsBillParseData,
  ISmsCandidatePayload,
} from '~/server/utils/types.ts'
// 银行账单短信解析服务：规则（号码+模板前缀）匹配 → 正则提取 → qwen-plus LLM 兜底
// 逐行对应旧 how-api src/service/sms_bill_parse.ts（TypeORM/https → drizzle/fetch），业务语义与错误文案保持一致
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { bank, bankCard, bankSmsRule } from '~/server/database/schema/plaza.ts'
import { config } from '~/server/utils/config.ts'

const DASHSCOPE_PATH = '/compatible-mode/v1/chat/completions'

type BankCardRow = typeof bankCard.$inferSelect

type SenderMatchMode = 'EXACT' | 'ENDS_WITH' | 'CONTAINS'

interface MatchedSms {
  address: string
  body: string
  date?: number
  matchedRuleNumber?: string
  matchMode: SenderMatchMode | 'TEMPLATE' | 'TEMPLATE_PREFIX'
}

// ---------- 纯函数（无 db / 网络，供解析管线与单测复用） ----------

export function normalizeBankName(name: string): string {
  return (name || '')
    .replace('银行', '')
    .replace('信用卡', '')
    .replace('【', '')
    .replace('】', '')
    .replace(/\s+/g, '')
    .trim()
}

export function parseSmsNumbersCsv(csv: string): string[] {
  return (csv || '')
    .split(',')
    .map(it => it.trim())
    .filter(Boolean)
    .map(it => it.replace(/\D/g, ''))
    .filter(Boolean)
    .filter((it, idx, arr) => arr.indexOf(it) === idx)
}

/** 规则号码 vs 真实发件号：全等 → 尾号匹配 → 包含（规则号至少 4 位） */
export function getSenderMatchMode(
  ruleNumberDigits: string,
  senderRaw: string,
): SenderMatchMode | null {
  if (!ruleNumberDigits)
    return null
  const senderDigits = (senderRaw || '').replace(/\D/g, '')
  if (!senderDigits)
    return null
  if (senderDigits === ruleNumberDigits)
    return 'EXACT'
  if (senderDigits.endsWith(ruleNumberDigits))
    return 'ENDS_WITH'
  if (ruleNumberDigits.length >= 4 && senderDigits.includes(ruleNumberDigits)) {
    return 'CONTAINS'
  }
  return null
}

/** 模板前缀匹配：取归一化模板前 N（默认 10）字符，命中正文开头或任意位置 */
export function isTemplatePrefixMatched(
  text: string,
  template: string,
  prefixLength = 10,
): boolean {
  const normalizedText = (text || '').replace(/\s+/g, '')
  const normalizedTemplate = (template || '').replace(/\s+/g, '')
  if (!normalizedText || !normalizedTemplate)
    return false
  const prefix = normalizedTemplate.slice(
    0,
    Math.min(prefixLength, normalizedTemplate.length),
  )
  if (!prefix)
    return false
  return normalizedText.startsWith(prefix) || normalizedText.includes(prefix)
}

/** 模板疑似匹配启发式：银行名提示 + 关键词，或多个账单关键词，或 3 个以上泛关键词 */
export function isTemplateLikelyMatch(text: string, rule: Pick<IBankSmsRuleVo, 'smsTemplate' | 'bankName'>): boolean {
  const normalizedText = (text || '').replace(/\s+/g, '')
  if (!normalizedText)
    return false
  const normalizedTemplate = (rule.smsTemplate || '').replace(/\s+/g, '')
  const normalizedBank = normalizeBankName(rule.bankName)
  const hasBankHint = !!normalizedBank && normalizedText.includes(normalizedBank)

  const templateKeywords = [
    '账单',
    '应还',
    '还款日',
    '最低还款',
    '信用卡',
  ].filter(k => normalizedTemplate.includes(k))
  const keywordHits = templateKeywords.filter(k => normalizedText.includes(k)).length

  if (hasBankHint && keywordHits >= 1)
    return true
  if (keywordHits >= 2)
    return true

  const genericHits = [
    '账单',
    '应还',
    '还款日',
    '最低还款',
    '最后还款日',
  ].filter(k => normalizedText.includes(k)).length
  return genericHits >= 3
}

export function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.replace(/[,，\s￥¥元]/g, '')
    const num = Number(normalized)
    return Number.isFinite(num) ? num : null
  }
  return null
}

export function toMonthOrNull(value: unknown): number | null {
  const n = toNumberOrNull(value)
  if (n == null)
    return null
  const m = Math.trunc(n)
  return m >= 1 && m <= 12 ? m : null
}

export function toDayOrNull(value: unknown): number | null {
  const n = toNumberOrNull(value)
  if (n == null)
    return null
  const d = Math.trunc(n)
  return d >= 1 && d <= 31 ? d : null
}

export function pickCurrency(text: string): string {
  if (text.includes('人民币'))
    return 'CNY'
  if (text.includes('美元') || text.includes('USD'))
    return 'USD'
  return 'CNY'
}

export function extractCardLastFour(text: string): string | null {
  const patterns = [
    /(?:尾号|末四位|卡号后四位|后四位)\D{0,4}(\d{4})/,
    /\*{2,}\s*(\d{4})/,
    /(?:信用卡|账户)\D{0,8}(\d{4})(?!\d)/,
  ]
  for (const p of patterns) {
    const hit = text.match(p)?.[1]
    if (hit)
      return hit
  }
  return null
}

export function normalizeCardLastFour(value?: string): string | null {
  if (!value)
    return null
  const digits = value.replace(/\D/g, '')
  if (digits.length < 4)
    return null
  return digits.slice(-4)
}

export function pickJsonObject(text: string): unknown {
  // eslint-disable-next-line regexp/no-super-linear-backtracking -- 旧实现正则原样保留
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = fenced?.[1]?.trim() || text.trim()
  try {
    return JSON.parse(candidate)
  }
  catch {
    const firstBrace = candidate.indexOf('{')
    const lastBrace = candidate.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const slice = candidate.slice(firstBrace, lastBrace + 1)
      try {
        return JSON.parse(slice)
      }
      catch {
        return null
      }
    }
    return null
  }
}

/** 解析 LLM 返回的 JSON 文本为账单数据（非法 JSON → billAmount null + reason） */
export function parseModelResult(content: string): ISmsBillParseData {
  const jsonObj = pickJsonObject(content)
  if (!jsonObj || typeof jsonObj !== 'object') {
    return {
      billAmount: null,
      currency: 'CNY',
      confidence: 0,
      reason: '模型返回不是合法 JSON',
    }
  }
  const record = jsonObj as Record<string, unknown>
  const billAmount = toNumberOrNull(record.billAmount)
  const currencyRaw = record.currency
  const bankNameRaw = record.bankName
  const cardLastFourRaw = record.cardLastFour
  const statementMonthRaw = record.statementMonth
  const minPaymentRaw = record.minPayment
  const dueDateMonthRaw = record.dueDateMonth
  const dueDateDayRaw = record.dueDateDay
  const dueDateTextRaw = record.dueDateText
  const templateSimilarityRaw = record.templateSimilarity
  const confidenceRaw = record.confidence
  const reasonRaw = record.reason
  const currency = typeof currencyRaw === 'string' && currencyRaw.trim()
    ? currencyRaw.trim()
    : 'CNY'
  const bankName = typeof bankNameRaw === 'string' ? bankNameRaw.trim() : undefined
  const cardLastFour = normalizeCardLastFour(
    typeof cardLastFourRaw === 'string' ? cardLastFourRaw : undefined,
  )
  const statementMonth = toMonthOrNull(statementMonthRaw)
  const minPayment = toNumberOrNull(minPaymentRaw)
  const dueDateMonth = toMonthOrNull(dueDateMonthRaw)
  const dueDateDay = toDayOrNull(dueDateDayRaw)
  const dueDateText
    = typeof dueDateTextRaw === 'string' && dueDateTextRaw.trim()
      ? dueDateTextRaw.trim()
      : dueDateMonth != null && dueDateDay != null
        ? `${dueDateMonth}月${dueDateDay}日`
        : undefined
  const templateSimilarity = toNumberOrNull(templateSimilarityRaw)
  const confidence = toNumberOrNull(confidenceRaw)
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : undefined
  return {
    billAmount,
    currency,
    bankName: bankName || undefined,
    cardLastFour: cardLastFour || undefined,
    statementMonth: statementMonth ?? undefined,
    minPayment: minPayment ?? undefined,
    dueDateMonth: dueDateMonth ?? undefined,
    dueDateDay: dueDateDay ?? undefined,
    dueDateText,
    templateSimilarity:
      templateSimilarity == null
        ? undefined
        : Math.max(0, Math.min(1, templateSimilarity)),
    confidence:
      confidence == null ? undefined : Math.max(0, Math.min(1, confidence)),
    reason: reason || undefined,
  }
}

/** 提取 OpenAI 兼容响应中的 assistant 文本（content 为字符串 / 分段数组均可） */
export function extractAssistantText(rawJson: string): string {
  try {
    const parsed = JSON.parse(rawJson)
    const content = parsed?.choices?.[0]?.message?.content
    if (typeof content === 'string') {
      return content.trim()
    }
    if (Array.isArray(content)) {
      return content
        .map((p: { text?: string }) => (typeof p?.text === 'string' ? p.text : ''))
        .join('')
        .trim()
    }
    return rawJson.trim()
  }
  catch {
    return rawJson.trim()
  }
}

export function buildPrompt(
  smsText: string,
  template?: string,
  bankName?: string,
): string {
  return [
    '你是账单短信解析助手，请从短信中提取账单关键信息。',
    '你需要先判断短信与模板是否语义匹配，并输出 templateSimilarity(0-1)。',
    '若无法确定金额，billAmount 返回 null，并给出简短 reason。',
    '只输出 JSON，不要输出其他说明。',
    '输出格式：{"billAmount": number | null, "currency": "CNY", "bankName": string, "cardLastFour": string, "statementMonth": number, "minPayment": number, "dueDateMonth": number, "dueDateDay": number, "dueDateText": string, "templateSimilarity": number(0-1), "confidence": number(0-1), "reason": string}',
    bankName ? `目标银行：${bankName}` : '',
    template ? `模板样例：${template}` : '',
    '',
    `短信正文：${smsText}`,
  ].join('\n')
}

/**
 * 规则优先解析（覆盖民生等常见账单短信模板）：
 * 示例：
 * 【民生银行】您人民币/美元账户信用卡03月账单：人民币应还1129.00元、最低还款100.00元，最后还款日04月14日。
 */
export function parseByRegexTemplate(
  text: string,
  opts?: { bankName?: string, template?: string },
): ISmsBillParseData {
  const normalized = text.replace(/\s+/g, '')
  const bankName = normalized.match(/^【([^】]+)】/)?.[1] || opts?.bankName
  const statementMonth = toNumberOrNull(
    normalized.match(/(\d{1,2})月账单/)?.[1],
  )
  const cardLastFour = extractCardLastFour(normalized)
  const xingyeBill = toNumberOrNull(
    normalized.match(/本期账单[￥¥]?(\d[\d,]*(?:\.\d+)?)/)?.[1],
  )
  const rmbBill = toNumberOrNull(
    normalized.match(/人民币应还(\d[\d,]*(?:\.\d+)?)/)?.[1],
  )
  const genericBill = toNumberOrNull(
    normalized.match(/(?:本期)?应还款?[:：]?\s*(\d[\d,]*(?:\.\d+)?)/)?.[1],
  )
  const minPayment = toNumberOrNull(
    normalized.match(/(?:最低还款额?|最低还)\D{0,4}[￥¥]?(\d[\d,]*(?:\.\d+)?)/)?.[1],
  )
  const due = normalized.match(/(?:最后还款日|到期还款日|还款日)[:：]?\s*(\d{1,2})月(\d{1,2})日/)
  const dueDateMonth = toNumberOrNull(due?.[1])
  const dueDateDay = toNumberOrNull(due?.[2])
  const billAmount = xingyeBill ?? rmbBill ?? genericBill
  const currency = pickCurrency(normalized)

  if (billAmount == null) {
    return {
      billAmount: null,
      currency,
      bankName,
      cardLastFour: cardLastFour ?? undefined,
      statementMonth: statementMonth ?? undefined,
      minPayment: minPayment ?? undefined,
      dueDateMonth: dueDateMonth ?? undefined,
      dueDateDay: dueDateDay ?? undefined,
      dueDateText:
        dueDateMonth != null && dueDateDay != null
          ? `${dueDateMonth}月${dueDateDay}日`
          : undefined,
      reason: '规则解析未命中应还金额',
      confidence: 0,
    }
  }

  return {
    billAmount,
    currency,
    bankName,
    cardLastFour: cardLastFour ?? undefined,
    statementMonth: statementMonth ?? undefined,
    minPayment: minPayment ?? undefined,
    dueDateMonth: dueDateMonth ?? undefined,
    dueDateDay: dueDateDay ?? undefined,
    dueDateText:
      dueDateMonth != null && dueDateDay != null
        ? `${dueDateMonth}月${dueDateDay}日`
        : undefined,
    reason: 'regex_template_matched',
    confidence: 0.99,
  }
}

function normalizeCandidates(candidates: ISmsCandidatePayload[]): Array<{ address: string, body: string, date?: number }> {
  return (Array.isArray(candidates) ? candidates : [])
    .map(it => ({
      address: (it?.address ?? '').toString().trim(),
      body: (it?.body ?? '').toString().trim(),
      date: Number.isFinite(Number(it?.date)) ? Number(it?.date) : undefined,
    }))
    .filter(it => it.body.length > 0)
}

// ---------- db 相关 ----------

export async function getEnabledRules(bankIds?: string[]): Promise<IBankSmsRuleVo[]> {
  const target = (bankIds ?? []).map(it => String(it).trim()).filter(Boolean)
  const rows = target.length > 0
    ? await db.select().from(bankSmsRule).where(and(eq(bankSmsRule.isEnabled, 1), inArray(bankSmsRule.bankId, target))).orderBy(bankSmsRule.id)
    : await db.select().from(bankSmsRule).where(eq(bankSmsRule.isEnabled, 1)).orderBy(bankSmsRule.id)
  return rows
    .filter(it => it.isEnabled === 1)
    .map(it => ({
      id: it.id,
      bankId: it.bankId,
      bankName: it.bankName,
      smsNumbersCsv: it.smsNumbersCsv,
      smsTemplate: it.smsTemplate,
      isEnabled: it.isEnabled,
    }))
}

export async function parseBillAmountFromSms(smsText: string): Promise<ISmsBillParseData> {
  return parseSingleSms({
    body: smsText,
  })
}

export async function parseBillByRules(
  candidates: ISmsCandidatePayload[],
  bankIds?: string[],
): Promise<ISmsBillParseBatchItem[]> {
  const valid = normalizeCandidates(candidates)
  if (valid.length === 0)
    return []

  const rules = await getEnabledRules(bankIds)
  if (rules.length === 0)
    return []
  return parseByGivenRules(valid, rules)
}

export async function parseBillByBankCardId(
  bankCardId: string,
  candidates: ISmsCandidatePayload[],
  observedSenderAddresses?: string[],
): Promise<ISmsBillParseBatchItem[]> {
  const card = await requireCardById(bankCardId)
  const rules = await getRulesByBankCard(card)
  const parsed = await parseByGivenRules(candidates, rules)
  // eslint-disable-next-line no-console
  console.info(
    '[sms_bill_parse by-card] bankCardId=%s bankId=%s candidateRaw=%d matched=%d',
    bankCardId,
    card.bankId,
    Array.isArray(candidates) ? candidates.length : 0,
    parsed.length,
  )
  // 优先取与卡尾号一致的解析结果，否则取全部结果中最新一条
  const exact = parsed.filter(
    it => it.cardLastFour && it.cardLastFour === card.cardLastFour,
  )
  const picked = (exact.length > 0 ? exact : parsed)
    .sort((a, b) => (b.sourceDate ?? 0) - (a.sourceDate ?? 0))
    .slice(0, 1)

  const observed
    = Array.isArray(observedSenderAddresses) && observedSenderAddresses.length > 0
      ? observedSenderAddresses.map(a => String(a).trim()).filter(Boolean)
      : (candidates ?? [])
          .map(c => (c?.address ?? '').toString().trim())
          .filter(Boolean)
  try {
    await mergeObservedSenderAddressesIntoRules(card.bankId, observed)
  }
  catch (e) {
    console.warn('[sms_bill_parse by-card] merge observed senders failed', e)
  }
  return picked
}

/**
 * 将客户端上报的真实发件号码合并进 bank_sms_rule.sms_numbers_csv，便于后续按号码维护、匹配。
 */
export async function mergeObservedSenderAddressesIntoRules(
  bankId: string,
  observedAddresses: string[],
): Promise<void> {
  const raw = (observedAddresses ?? [])
    .map(a => String(a).trim())
    .filter(Boolean)
  if (raw.length === 0)
    return

  const norm = (s: string) => s.replace(/\D/g, '')
  const rules = await db.select().from(bankSmsRule).where(and(
    eq(bankSmsRule.bankId, bankId),
    eq(bankSmsRule.isEnabled, 1),
  ))
  if (rules.length === 0)
    return

  const now = Date.now()
  for (const rule of rules) {
    const parts = rule.smsNumbersCsv
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    const digitSet = new Set(parts.map(norm).filter(d => d.length > 0))

    for (const addr of raw) {
      const d = norm(addr)
      if (d.length < 4)
        continue
      let duplicate = false
      for (const ex of digitSet) {
        if (ex.length < 4)
          continue
        if (d === ex || d.endsWith(ex) || ex.endsWith(d)) {
          duplicate = true
          break
        }
      }
      if (duplicate)
        continue
      parts.push(addr.replace(/\s/g, ''))
      digitSet.add(d)
    }

    const joined = parts.join(',')
    let nextCsv: string
    if (joined.length > 500) {
      const trimmed = parts.slice(0, 25).join(',')
      if (trimmed === rule.smsNumbersCsv)
        continue
      nextCsv = trimmed.slice(0, 500)
    }
    else if (joined === rule.smsNumbersCsv) {
      continue
    }
    else {
      nextCsv = joined
    }
    await db.update(bankSmsRule).set({
      smsNumbersCsv: nextCsv,
      updatedAt: now,
    }).where(eq(bankSmsRule.id, rule.id))
  }
}

export async function getSmsSendersByBankCardId(
  bankCardId: string,
): Promise<IBankCardSmsSenderInfo> {
  const card = await requireCardById(bankCardId)
  const rules = await getRulesByBankCard(card)
  const senders = Array.from(
    new Set(
      rules.flatMap(rule => parseSmsNumbersCsv(rule.smsNumbersCsv)),
    ),
  )
  return {
    bankCardId: String(card.id),
    bankId: card.bankId,
    ruleBankId: rules[0]?.bankId,
    ruleBankName: rules[0]?.bankName,
    smsSenders: senders,
  }
}

export async function parseBillFromSmsBatch(
  candidates: ISmsCandidatePayload[],
): Promise<ISmsBillParseBatchItem[]> {
  const valid = normalizeCandidates(candidates)
  if (valid.length === 0)
    return []

  const keywords = [
    '账单',
    '应还',
    '还款',
    '最低还款',
    '信用卡',
    '到期还款日',
    '最后还款日',
  ]
  const prioritized = valid
    .filter(it => keywords.some(k => it.body.includes(k)))
    .slice(0, 40)
  const input = prioritized.length > 0 ? prioritized : valid.slice(0, 25)

  const out: ISmsBillParseBatchItem[] = []
  for (const sms of input) {
    const parsed = await parseSingleSms({ body: sms.body })
    if (
      parsed.billAmount != null
      || parsed.dueDateDay != null
      || parsed.reason === 'regex_template_matched'
    ) {
      out.push({
        ...parsed,
        sourceAddress: sms.address || undefined,
        sourceDate: sms.date,
      })
    }
  }
  return out.sort((a, b) => (b.sourceDate ?? 0) - (a.sourceDate ?? 0))
}

export async function parseSingleSms(
  input: { body: string },
  opts?: { bankName?: string, template?: string },
): Promise<ISmsBillParseData> {
  const text = (input.body ?? '').trim()
  if (!text) {
    throw new Error('smsText 不能为空')
  }
  const regexParsed = parseByRegexTemplate(text, opts)
  if (regexParsed.billAmount != null) {
    return {
      ...regexParsed,
      confidence: regexParsed.confidence ?? 0.99,
      raw: text,
    }
  }
  const apiKey = config.bankCardVision.dashscopeApiKey?.trim()
  if (!apiKey) {
    throw new Error('缺少 DASHSCOPE_API_KEY，无法调用短信解析模型')
  }

  const host = config.bankCardVision.dashscopeHost?.trim() || 'dashscope.aliyuncs.com'
  const model = config.bankCardVision.qwenTextModel?.trim() || 'qwen-plus'
  const prompt = buildPrompt(text, opts?.template, opts?.bankName)
  const raw = await callQwen(host, apiKey, model, prompt)
  const content = extractAssistantText(raw)
  const parsed = parseModelResult(content)
  return {
    ...parsed,
    raw: content,
  }
}

async function callQwen(
  host: string,
  bearerToken: string,
  model: string,
  prompt: string,
): Promise<string> {
  const base = host.startsWith('http') ? host : `https://${host}`
  const res = await fetch(`${base.replace(/\/+$/, '')}${DASHSCOPE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': 'application/json',
      'Authorization': `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`DashScope HTTP ${res.status}: ${text}`)
  }
  return text
}

async function requireCardById(bankCardId: string): Promise<BankCardRow> {
  const numId = Number.parseInt(String(bankCardId), 10)
  if (Number.isNaN(numId)) {
    throw new TypeError('bankCardId 无效')
  }
  const [card] = await db.select().from(bankCard).where(eq(bankCard.id, numId)).limit(1)
  if (!card) {
    throw new Error('未找到对应银行卡')
  }
  return card
}

/** 卡号所属银行无规则时，按银行名归一化兜底匹配全部规则 */
async function getRulesByBankCard(card: BankCardRow): Promise<IBankSmsRuleVo[]> {
  let rules = await getEnabledRules([card.bankId])
  if (rules.length > 0)
    return rules

  const bankIdNum = Number.parseInt(card.bankId, 10)
  if (!Number.isNaN(bankIdNum)) {
    const [bankRow] = await db.select().from(bank).where(eq(bank.id, bankIdNum)).limit(1)
    const bankName = (bankRow?.name || '').trim()
    if (bankName) {
      const all = await getEnabledRules()
      const normalizedBank = normalizeBankName(bankName)
      rules = all.filter(it => normalizeBankName(it.bankName).includes(normalizedBank))
    }
  }
  return rules
}

/** 规则匹配 + 解析 + 按 (bankId, 卡尾四, 还款日, 金额) 去重（保留时间最新） */
export async function parseByGivenRules(
  candidates: ISmsCandidatePayload[],
  rules: IBankSmsRuleVo[],
): Promise<ISmsBillParseBatchItem[]> {
  const valid = normalizeCandidates(candidates)
  if (valid.length === 0 || rules.length === 0)
    return []

  const out: ISmsBillParseBatchItem[] = []
  for (const rule of rules) {
    const nums = parseSmsNumbersCsv(rule.smsNumbersCsv)
    const matched: MatchedSms[] = []
    for (const msg of valid) {
      const templatePrefixMatched = isTemplatePrefixMatched(
        msg.body,
        rule.smsTemplate,
        10,
      )
      if (!templatePrefixMatched) {
        continue
      }
      const matchedNum = nums
        .map(num => ({
          num,
          mode: getSenderMatchMode(num, msg.address),
        }))
        .find(it => it.mode != null)
      const templateLikely = isTemplateLikelyMatch(msg.body, rule)
      if (matchedNum?.mode || templateLikely) {
        matched.push({
          ...msg,
          matchedRuleNumber: matchedNum?.num,
          matchMode: matchedNum?.mode ?? 'TEMPLATE_PREFIX',
        })
      }
    }
    for (const sms of matched) {
      const parsed = await parseSingleSms(
        { body: sms.body },
        { bankName: rule.bankName, template: rule.smsTemplate },
      )
      if (parsed.billAmount != null || parsed.dueDateDay != null) {
        out.push({
          ...parsed,
          bankId: rule.bankId,
          sourceRuleId: rule.id,
          matchedRuleNumber: sms.matchedRuleNumber,
          matchMode: sms.matchMode,
          sourceAddress: sms.address || undefined,
          sourceDate: sms.date,
        })
      }
    }
  }
  const dedup = new Map<string, ISmsBillParseBatchItem>()
  out
    .sort((a, b) => (b.sourceDate ?? 0) - (a.sourceDate ?? 0))
    .forEach((item) => {
      const key = `${item.bankId || ''}_${item.cardLastFour || ''}_${item.dueDateText || ''}_${item.billAmount || ''}`
      if (!dedup.has(key))
        dedup.set(key, item)
    })
  return Array.from(dedup.values())
}
