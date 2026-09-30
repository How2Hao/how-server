import type { BankCardVisionProvider, BankCardVisionRemoteConfig } from './bank-card-vision-providers.ts'
import type { IBankCardRecognizedItem } from '~/server/utils/types.ts'
import { Buffer } from 'node:buffer'
// 银行卡视觉识别服务：多模态识别截图中全部银行卡条目
// 逐行对应旧 how-api src/service/bank_card_vision.ts（sharp 已移除：封面对比裁切禁用，仅返回坐标）
import { config } from '~/server/utils/config.ts'
import { getBankCardRecognitionPrompt } from './bank-card-vision-prompts.ts'
import {
  callBankCardVisionRemote,
  extractVisionAssistantText,
} from './bank-card-vision-providers.ts'

export type { BankCardVisionProvider } from './bank-card-vision-providers.ts'

/**
 * 多模态识别截图中的**全部**银行卡条目；
 * 返回模型 JSON 每条（coverImgPosition 坐标原样透出；sharp 移除后不再生成 coverImg）。
 * @param imageBase64 截图 base64（空则回退 sourceImageUrl）
 * @param mimeType 图片 MIME（如 image/jpeg）
 * @param visionProvider 默认 qwen；glm 智谱；gemini Google
 */
export async function recognizeFromImageBase64(
  imageBase64: string,
  mimeType: string,
  visionProvider: BankCardVisionProvider = 'qwen',
): Promise<IBankCardRecognizedItem[]> {
  const trimmedB64 = (imageBase64 ?? '').trim()
  let rawBuffer: Buffer
  if (trimmedB64) {
    rawBuffer = Buffer.from(trimmedB64, 'base64')
  }
  else {
    // 未传 base64 时回退到配置的原图 URL（与模型、裁切同源）
    const srcUrl = config.bankCardVision.sourceImageUrl.trim()
    if (!srcUrl) {
      throw new Error('请传入图片 base64，或在配置 bankCardVision.sourceImageUrl / 环境变量 BANK_CARD_SOURCE_IMAGE_URL 中设置原图 URL')
    }
    rawBuffer = await fetchUrlToBuffer(srcUrl)
  }

  // sharp removed: 跳过自动旋转
  const imageBuffer = rawBuffer
  const orientedBase64 = imageBuffer.toString('base64')
  const dataMime = inferImageMime(undefined, mimeType)
  /** 与本地裁切共用同一像素 */
  const dataUrl = `data:${dataMime};base64,${orientedBase64}`

  const remoteCfg: BankCardVisionRemoteConfig = {
    dashscopeApiKey: config.bankCardVision.dashscopeApiKey,
    qwenVisionModel: config.bankCardVision.qwenVisionModel,
    dashscopeHost: config.bankCardVision.dashscopeHost,
    zhipuApiKey: config.bankCardVision.zhipuApiKey,
    zhipuModel: config.bankCardVision.zhipuVisionModel,
    geminiApiKey: config.bankCardVision.geminiApiKey,
    geminiModel: config.bankCardVision.geminiVisionModel,
    geminiHost: config.bankCardVision.geminiHost,
  }

  // eslint-disable-next-line no-console
  console.info(`[BankCardVision] provider=${visionProvider}`)

  const prompt = getBankCardRecognitionPrompt(visionProvider)
  const raw = await callBankCardVisionRemote(visionProvider, remoteCfg, {
    dataUrl,
    orientedBase64,
    dataMime,
    prompt,
  })
  const content = extractVisionAssistantText(raw, visionProvider)
  const items = parseRecognitionArray(content)
  // eslint-disable-next-line no-console
  console.info(`[BankCardVision] 解析到 ${items.length} 条银行卡`)
  // sharp removed：封面对比裁切禁用，坐标字段（coverImgPosition）原样返回，coverImg 不再生成
  return items
}

/** 从 URL 拉取原图字节（与 CDN / 联调 sourceImageUrl 配合） */
async function fetchUrlToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`拉取 bankCardVision.sourceImageUrl 失败: HTTP ${res.status} ${res.statusText}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

export function inferImageMime(format: string | undefined, fallbackMime: string): string {
  const map: Record<string, string> = {
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    tiff: 'image/tiff',
    heif: 'image/heif',
  }
  if (format && map[format]) {
    return map[format]
  }
  if (fallbackMime && /^image\//i.test(fallbackMime.trim())) {
    return fallbackMime.trim()
  }
  return 'image/jpeg'
}

/** 解析模型输出为识别结果数组（兼容围栏 JSON、{cards:[]} 包装、单对象、蛇形命名） */
export function parseRecognitionArray(text: string): IBankCardRecognizedItem[] {
  const trimmed = text.trim()
  const jsonStr = extractJsonArray(trimmed)
  let arr: any[]
  try {
    arr = JSON.parse(jsonStr)
  }
  catch {
    throw new Error(`无法解析模型返回的 JSON：${trimmed.slice(0, 200)}`)
  }
  if (
    !Array.isArray(arr)
    && arr != null
    && typeof arr === 'object'
    && Array.isArray((arr as { cards?: unknown }).cards)
  ) {
    arr = (arr as { cards: any[] }).cards
  }
  if (!Array.isArray(arr)) {
    if (arr != null && typeof arr === 'object') {
      arr = [arr as any]
    }
    else {
      throw new Error('模型返回不是 JSON 数组或对象')
    }
  }

  return arr.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`数组第 ${index + 1} 项不是对象`)
    }
    const bankName = String(item.bankName ?? item.bank_name ?? '').trim()
    const cardType = String(item.cardType ?? item.card_type ?? '').trim()
    const cardLastFour = String(
      item.cardLastFour
      ?? item.card_last_four
      ?? item.lastFour
      ?? item.card_number_suffix
      ?? '',
    ).trim()

    const coverImgPosition = parseCoverImgPositionField(
      item.coverImgPosition
      ?? item.cover_img_position
      ?? item.cover_img
      ?? item.bbox,
    )

    return { bankName, cardType, cardLastFour, coverImgPosition }
  })
}

export function parseCoverImgPositionField(raw: any): [number, number, number, number] | undefined {
  if (raw == null) {
    return undefined
  }
  let arr: any[]
  if (Array.isArray(raw)) {
    arr = raw
  }
  else if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) {
      return undefined
    }
    try {
      const parsed = JSON.parse(s.replace(/'/g, '"'))
      if (!Array.isArray(parsed)) {
        return undefined
      }
      arr = parsed
    }
    catch {
      return undefined
    }
  }
  else {
    return undefined
  }

  if (arr.length < 4) {
    return undefined
  }
  const nums = arr.slice(0, 4).map(v => Number(v))
  if (nums.some(n => !Number.isFinite(n))) {
    return undefined
  }
  return [nums[0], nums[1], nums[2], nums[3]]
}

/** 从模型文本里抠出 JSON 数组：围栏优先 → 平衡括号匹配（需含 bankName 键）→ 首个 [ 起 */
export function extractJsonArray(s: string): string {
  // eslint-disable-next-line regexp/no-super-linear-backtracking -- 旧实现正则原样保留
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fence?.[1] ?? s).trim()

  if (body.startsWith('[')) {
    try {
      const parsed = JSON.parse(body)
      if (Array.isArray(parsed)) {
        return body
      }
    }
    catch {
      // 整段解析失败，继续从正文找数组
    }
  }

  const objectArrayStarts = [...body.matchAll(/\[\s*\{/g)]
  for (const m of objectArrayStarts) {
    const idx = m.index
    if (idx === undefined) {
      continue
    }
    const slice = sliceBalancedBracketArray(body, idx)
    if (!slice) {
      continue
    }
    try {
      const parsed = JSON.parse(slice)
      if (
        Array.isArray(parsed)
        && parsed.some(
          el =>
            el
            && typeof el === 'object'
            && ('bankName' in el || 'bank_name' in el),
        )
      ) {
        return slice
      }
    }
    catch {
      continue
    }
  }

  const first = body.indexOf('[')
  if (first !== -1) {
    const slice = sliceBalancedBracketArray(body, first)
    if (slice) {
      return slice
    }
  }
  return body
}

function sliceBalancedBracketArray(body: string, start: number): string | null {
  if (body[start] !== '[') {
    return null
  }
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < body.length; i++) {
    const c = body[i]
    if (escape) {
      escape = false
      continue
    }
    if (c === '\\' && inString) {
      escape = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (inString) {
      continue
    }
    if (c === '[') {
      depth++
    }
    else if (c === ']') {
      depth--
      if (depth === 0) {
        return body.slice(start, i + 1)
      }
    }
  }
  return null
}
