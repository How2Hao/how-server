// 银行卡视觉识别远端调用：千问 DashScope | 智谱 GLM | Google Gemini（原 https 模块 → fetch）
// 逐行对应旧 how-api src/service/bank_card_vision_providers.ts，错误文案保持一致

/** 视觉识别后端：千问 DashScope | 智谱 GLM | Google Gemini */
export type BankCardVisionProvider = 'qwen' | 'glm' | 'gemini'

/** 各模型 HTTP 调用所需配置（由 config.bankCardVision 映射而来） */
export interface BankCardVisionRemoteConfig {
  dashscopeApiKey?: string
  qwenVisionModel?: string
  dashscopeHost?: string
  zhipuApiKey?: string
  zhipuModel?: string
  geminiApiKey?: string
  geminiModel?: string
  /** 默认 generativelanguage.googleapis.com */
  geminiHost?: string
}

const DASHSCOPE_PATH = '/compatible-mode/v1/chat/completions'
const ZHIPU_HOST = 'open.bigmodel.cn'
const ZHIPU_PATH = '/api/paas/v4/chat/completions'
const GEMINI_HOST_DEFAULT = 'generativelanguage.googleapis.com'

/** URL ?model= 解析；默认 qwen */
export function parseVisionProviderFromQuery(model?: string): BankCardVisionProvider {
  const s = (model ?? '').trim().toLowerCase()
  if (s === 'glm' || s === 'zhipu' || s === 'bigmodel') {
    return 'glm'
  }
  if (s === 'gemini' || s === 'google') {
    return 'gemini'
  }
  return 'qwen'
}

export function assertProviderConfig(
  provider: BankCardVisionProvider,
  cfg: BankCardVisionRemoteConfig,
): void {
  if (provider === 'glm') {
    if (!cfg.zhipuApiKey?.trim()) {
      throw new Error('GLM 需配置 ZHIPU_API_KEY（或 bankCardVision.zhipuApiKey）')
    }
    return
  }
  if (provider === 'gemini') {
    if (!cfg.geminiApiKey?.trim()) {
      throw new Error('Gemini 需配置 GEMINI_API_KEY（或 bankCardVision.geminiApiKey）')
    }
    return
  }
  if (!cfg.dashscopeApiKey?.trim()) {
    throw new Error('千问需配置 DASHSCOPE_API_KEY（或 bankCardVision.dashscopeApiKey）')
  }
}

/** host 可能带协议（如 config 默认 https://dashscope.aliyuncs.com），统一补全为完整 URL */
function toUrl(host: string, path: string): string {
  const base = host.startsWith('http') ? host : `https://${host}`
  return `${base.replace(/\/+$/, '')}${path}`
}

async function postJson(options: {
  url: string
  headers: Record<string, string>
  body: string
  apiLabel: string
}): Promise<string> {
  const { url, headers, body, apiLabel } = options
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': 'application/json',
      ...headers,
    },
    body,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${apiLabel} HTTP ${res.status}: ${text}`)
  }
  return text
}

/** OpenAI 兼容多模态：DashScope / 智谱 */
export async function invokeOpenAiCompatibleVision(options: {
  hostname: string
  path: string
  bearerToken: string
  model: string
  dataUrl: string
  prompt: string
  apiLabel: string
}): Promise<string> {
  const { hostname, path, bearerToken, model, dataUrl, prompt, apiLabel } = options
  const userContent = [
    { type: 'image_url', image_url: { url: dataUrl } },
    { type: 'text', text: prompt },
  ]
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: userContent }],
  })
  return postJson({
    url: toUrl(hostname, path),
    headers: { Authorization: `Bearer ${bearerToken}` },
    body,
    apiLabel,
  })
}

/** Google Generative Language API generateContent */
export async function invokeGeminiVision(options: {
  hostname: string
  apiKey: string
  model: string
  mimeType: string
  imageBase64: string
  prompt: string
}): Promise<string> {
  const { hostname, apiKey, model, mimeType, imageBase64, prompt } = options
  const safeModel = encodeURIComponent(model)
  const path = `/v1beta/models/${safeModel}:generateContent?key=${encodeURIComponent(apiKey)}`
  const body = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data: imageBase64,
            },
          },
          { text: prompt },
        ],
      },
    ],
  })
  return postJson({
    url: toUrl(hostname, path),
    headers: {},
    body,
    apiLabel: `Gemini ${hostname}`,
  })
}

/** 将各厂商原始 JSON 统一为模型文本（供后续 parseRecognitionArray） */
export function extractVisionAssistantText(
  rawJson: string,
  provider: BankCardVisionProvider,
): string {
  if (provider === 'gemini') {
    return extractGeminiAssistantText(rawJson)
  }
  return extractOpenAiCompatibleAssistantText(rawJson)
}

function extractGeminiAssistantText(rawJson: string): string {
  let parsed: any
  try {
    parsed = JSON.parse(rawJson)
  }
  catch {
    return rawJson.trim()
  }
  const parts = parsed?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) {
    return typeof parsed?.error?.message === 'string'
      ? parsed.error.message
      : JSON.stringify(parsed, null, 2)
  }
  const text = parts
    .map((p: { text?: string }) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
  return text.trim() || JSON.stringify(parsed, null, 2)
}

function extractOpenAiCompatibleAssistantText(rawJson: string): string {
  let parsed: any
  try {
    parsed = JSON.parse(rawJson)
  }
  catch {
    return rawJson.trim()
  }

  const content = parsed?.choices?.[0]?.message?.content

  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    const joined = content
      .map((p: any) => {
        if (typeof p?.text === 'string') {
          return p.text
        }
        if (p != null && typeof p === 'object') {
          return JSON.stringify(p)
        }
        return p == null ? '' : String(p)
      })
      .join('')
    return joined.trim() || JSON.stringify(parsed, null, 2)
  }
  if (content != null && typeof content === 'object') {
    return JSON.stringify(content, null, 2)
  }
  return JSON.stringify(parsed, null, 2)
}

/** 按 provider 调用远端，返回原始响应 JSON 字符串 */
export async function callBankCardVisionRemote(
  provider: BankCardVisionProvider,
  cfg: BankCardVisionRemoteConfig,
  input: {
    dataUrl: string
    orientedBase64: string
    dataMime: string
    prompt: string
  },
): Promise<string> {
  assertProviderConfig(provider, cfg)

  if (provider === 'glm') {
    return invokeOpenAiCompatibleVision({
      hostname: ZHIPU_HOST,
      path: ZHIPU_PATH,
      bearerToken: cfg.zhipuApiKey!.trim(),
      model: cfg.zhipuModel?.trim() || 'glm-4v-flash',
      dataUrl: input.dataUrl,
      prompt: input.prompt,
      apiLabel: `智谱 ${ZHIPU_HOST}`,
    })
  }

  if (provider === 'gemini') {
    const host = cfg.geminiHost?.trim() || GEMINI_HOST_DEFAULT
    return invokeGeminiVision({
      hostname: host,
      apiKey: cfg.geminiApiKey!.trim(),
      model: cfg.geminiModel?.trim() || 'gemini-2.0-flash',
      mimeType: input.dataMime,
      imageBase64: input.orientedBase64,
      prompt: input.prompt,
    })
  }

  const host = cfg.dashscopeHost?.trim() || 'dashscope.aliyuncs.com'
  return invokeOpenAiCompatibleVision({
    hostname: host,
    path: DASHSCOPE_PATH,
    bearerToken: cfg.dashscopeApiKey!.trim(),
    model: cfg.qwenVisionModel?.trim() || 'qwen-vl-plus',
    dataUrl: input.dataUrl,
    prompt: input.prompt,
    apiLabel: `DashScope ${host}`,
  })
}
