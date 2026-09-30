import type { ICardCoverQwenGenerateBody, ICardCoverQwenGenerateData, ICardCoverQwenSourceMeta, ICardCoverQwenVariant } from '~/server/utils/types.ts'
// 银行卡封面生成（移植自旧 src/service/card_cover_qwen_edit.ts）：Qwen 图像编辑模型，
// faithful / beautified 双变体。旧实现用 https.request，这里改为 fetch()（Node 18+ 原生），
// 超时用 AbortSignal.timeout，行为与错误文案保持一致。
import { Buffer } from 'node:buffer'
import { config } from '~/server/utils/config.ts'

export type VariantKind = 'faithful' | 'beautified'

export interface PreparedEditInput {
  image: string
  meta: ICardCoverQwenSourceMeta
}

interface QwenResponseBody {
  output?: {
    choices?: Array<{
      message?: {
        content?: Array<{
          image?: string
        }>
      }
    }>
  }
  usage?: {
    image_count?: number
    width?: number
    height?: number
  }
  request_id?: string
  code?: string
  message?: string
}

const PROMPT_VERSION = 'qwen-card-cover-v5'
const CARD_SIZE = '1536*960'
const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024
const DASHSCOPE_HOST = 'dashscope.aliyuncs.com'
const QWEN_EDIT_PATH = '/api/v1/services/aigc/multimodal-generation/generation'

// ---------- 纯函数（wanx 服务与单测复用） ----------

/** 拒绝内网图片地址（SSRF 防护，与旧系统一致） */
export function assertSafeRemoteHost(hostname: string): void {
  const host = hostname.toLowerCase()
  if (
    host === 'localhost'
    || host.startsWith('127.')
    || host.startsWith('10.')
    || host.startsWith('192.168.')
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error(`禁止使用内网图片地址: ${hostname}`)
  }
}

/** sourceBase64 / sourceUrl 二选一，base64 优先；返回可直接投喂模型的 image + 元信息 */
export function prepareEditInput(body: ICardCoverQwenGenerateBody, maxInputBytes: number): PreparedEditInput {
  const sourceBase64 = (body.sourceBase64 ?? '').trim()
  const sourceUrl = (body.sourceUrl ?? '').trim()

  if (!sourceBase64 && !sourceUrl) {
    throw new Error('请传入 sourceBase64 或 sourceUrl')
  }

  if (sourceBase64) {
    return prepareBase64Input(sourceBase64, maxInputBytes)
  }

  return prepareUrlInput(sourceUrl)
}

function prepareBase64Input(sourceBase64: string, maxInputBytes: number): PreparedEditInput {
  const matched = sourceBase64.match(
    /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i,
  )
  const mimeType = matched?.[1] || 'image/jpeg'
  const rawBase64 = (matched?.[2] || sourceBase64).replace(/\s+/g, '')

  let buf: Buffer
  try {
    buf = Buffer.from(rawBase64, 'base64')
  }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new Error(`sourceBase64 不是合法的 base64：${message}`)
  }
  if (!buf.byteLength) {
    throw new Error('sourceBase64 解码后内容为空')
  }
  if (buf.byteLength > maxInputBytes) {
    throw new Error(
      `sourceBase64 图片过大 (${(buf.byteLength / 1024 / 1024).toFixed(2)} MB)，请控制在 ${(maxInputBytes / 1024 / 1024).toFixed(0)} MB 内`,
    )
  }

  return {
    image: `data:${mimeType};base64,${rawBase64}`,
    meta: {
      sourceType: 'base64',
      mimeType,
      byteLength: buf.byteLength,
    },
  }
}

function prepareUrlInput(sourceUrl: string): PreparedEditInput {
  let parsed: URL
  try {
    parsed = new URL(sourceUrl)
  }
  catch {
    throw new Error(`非法图片 URL: ${sourceUrl}`)
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`图片 URL 只支持 http/https，当前为 ${parsed.protocol}`)
  }
  assertSafeRemoteHost(parsed.hostname)

  return {
    image: sourceUrl,
    meta: {
      sourceType: 'url',
      mimeType: null,
      byteLength: null,
      urlHost: parsed.hostname,
    },
  }
}

export function uniqueModels(models: string[]): string[] {
  return Array.from(new Set(models.filter(Boolean)))
}

export function clampOutputCount(n: number): number {
  if (!Number.isFinite(n)) {
    return 1
  }
  return Math.max(1, Math.min(6, Math.floor(n)))
}

function buildPrompt(kind: VariantKind): string {
  const common = [
    '你的任务不是重新设计银行卡，也不是生成宣传海报。',
    '你的任务是：从用户上传的银行卡照片中，把银行卡封面主体准确抠出，并整理成一张像扫描件一样的标准横版银行卡封面图。',
    '',
    '目标结果：',
    '1. 最终图片里只能出现银行卡卡面主体本身。',
    '2. 不能出现任何拍摄环境，包括手、桌面、背景、阴影、边框外场景、衬底、展示台、悬浮效果、光效、装饰图层、留白边距。',
    '3. 输出必须是标准横版卡面，像平板扫描得到的结果，而不是斜拍照片。',
    '4. 卡面必须完全拉正：正面平视，横平竖直，四边规整，四角自然，没有透视倾斜、旋转残留、卷曲、弯折感或镜头畸变。',
    '5. 如果原图是竖着拍的，先将整张卡向右旋转 90 度，再输出横版结果。',
    '',
    '内容保真要求：',
    '1. 必须严格保留原卡面的图案、文字、logo、配色、纹理、材质感和布局。',
    '2. 不允许重绘、脑补、改写、替换、增删或重新设计任何卡面元素。',
    '3. 不允许把原卡面改成更华丽、更简洁或更商业化的版本。',
    '4. 不允许新增任何原图中不存在的图案、光泽、装饰线条、品牌元素、文字或背景。',
    '',
    '允许做的处理仅限：',
    '1. 抠出银行卡主体。',
    '2. 纠正方向与透视。',
    '3. 补齐因拍摄角度、遮挡、裁切、阴影、反光造成的卡片边缘缺失。',
    '4. 轻微修复反光、噪点和模糊，但修复后仍必须保持原卡样貌不变。',
    '',
    '输出要求：',
    '1. 输出画布本身就是银行卡封面，不要任何外背景。',
    '2. 卡面主体必须铺满整张画面，图像四条边就等于卡片四条边，卡片外侧不允许残留任何背景、边框外像素、衬底、阴影、留白或缓冲区域。',
    '3. 结果应看起来像“原卡封面的扫描图”或“从照片中精确矫正提取出的卡面”，而不是 AI 二次创作图。',
    '',
    '硬性验收标准：',
    '1. 如果图片四周还能看到任何背景或卡片外区域，则结果不合格。',
    '2. 如果原图中的文字、logo、图案、纹理、装饰线条、数字、配色有任何改动，则结果不合格。',
    '3. 如果结果看起来像重绘、再设计、美化重做，而不是原卡面被拉正抠出，则结果不合格。',
    '',
    '如果无法完全确定某个细节，应优先选择保守还原，绝不要擅自改动原图案。',
  ].join('\n')

  if (kind === 'faithful') {
    return [
      common,
      '',
      'faithful 模式要求：',
      '请把重点放在“绝对忠实还原”上。',
      '宁可保留原卡面的轻微使用痕迹，也不要让图案、文字、logo、纹理和配色发生任何风格化变化。',
      '如果“去背景”和“保留原内容”之间发生冲突，优先保证原内容不被改动，同时继续把裁切边界压到卡面边缘。',
    ].join('\n')
  }

  return [
    common,
    '',
    'beautified 模式要求：',
    '只允许做非常克制的清理和修复，让卡面更接近平整、干净的扫描件。',
    '但无论如何都不能改变原卡面的设计内容、图案结构、文字信息、logo 位置和主视觉风格。',
    'beautified 不等于重绘或美术增强；它只能去除拍摄带来的噪声，不能修改卡面原始内容。',
    '请优先消除卡片四周残留背景，把输出裁切到只剩卡面封面本身。',
  ].join('\n')
}

function buildNegativePrompt(): string {
  return [
    '不要手',
    '不要桌面',
    '不要背景场景',
    '不要纯色背景',
    '不要渐变背景',
    '不要展示底板',
    '不要边框外环境',
    '不要额外人物',
    '不要额外卡片',
    '不要额外文字',
    '不要水印',
    '不要重复图案',
    '不要重绘图案',
    '不要改动原卡纹样',
    '不要改动原卡文字',
    '不要改动 logo',
    '不要装饰边框',
    '不要悬浮阴影',
    '不要光效',
    '不要留白边距',
    '不要透明外边',
    '不要卡面未铺满画面',
    '不要卡片四周残留背景',
    '不要卡片四周残留边框外像素',
    '不要多余留边',
    '不要畸形透视',
    '不要斜拍视角',
    '不要旋转残留',
    '不要方向错误',
    '不要未旋转的竖版卡面',
    '不要边缘弯曲',
    '不要海报感',
    '不要产品展示图风格',
    '不要 AI 二次设计感',
    '不要改字',
    '不要改图案',
    '不要改配色',
    '不要严重反光',
    '不要低清晰度',
    '不要模糊',
    '不要裁切残缺',
  ].join('，')
}

// ---------- HTTP ----------

async function postJson(url: string, headers: Record<string, string>, body: string, timeoutMs: number, apiLabel: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json',
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
  catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(`${apiLabel} 请求超时 (${timeoutMs} ms)`)
    }
    throw e
  }
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${apiLabel} HTTP ${res.status}: ${text}`)
  }
  return text
}

function parseResponse(raw: string): QwenResponseBody {
  let parsed: QwenResponseBody
  try {
    parsed = JSON.parse(raw) as QwenResponseBody
  }
  catch {
    throw new Error(`Qwen 图像编辑返回了非 JSON 内容：${raw.slice(0, 300)}`)
  }

  if (parsed.code || parsed.message) {
    const code = parsed.code ? `${parsed.code}: ` : ''
    throw new Error(`${code}${parsed.message || 'Qwen 图像编辑调用失败'}`)
  }

  return parsed
}

function extractImageUrl(parsed: QwenResponseBody): string | null {
  const choices = parsed.output?.choices
  if (!Array.isArray(choices)) {
    return null
  }
  for (const choice of choices) {
    const content = choice?.message?.content
    if (!Array.isArray(content)) {
      continue
    }
    for (const item of content) {
      const image = item?.image?.trim()
      if (image) {
        return image
      }
    }
  }
  return null
}

async function callQwenEdit(options: {
  image: string
  kind: VariantKind
  model: string
}): Promise<string> {
  const apiKey = config.bankCardVision.dashscopeApiKey.trim()
  if (!apiKey) {
    throw new Error('缺少 DASHSCOPE_API_KEY，无法调用 Qwen 图像编辑模型')
  }

  const payload = JSON.stringify({
    model: options.model,
    input: {
      messages: [
        {
          role: 'user',
          content: [
            { image: options.image },
            { text: buildPrompt(options.kind) },
          ],
        },
      ],
    },
    parameters: {
      n: clampOutputCount(1),
      negative_prompt: buildNegativePrompt(),
      prompt_extend: false,
      watermark: false,
      size: CARD_SIZE,
    },
  })

  const timeoutMs = config.qwenImageEdit.timeoutMs
  const raw = await postJson(
    `https://${DASHSCOPE_HOST}${QWEN_EDIT_PATH}`,
    { Authorization: `Bearer ${apiKey}` },
    payload,
    timeoutMs,
    `QwenImageEdit ${options.model}`,
  )
  const parsed = parseResponse(raw)
  const imageUrl = extractImageUrl(parsed)
  if (!imageUrl) {
    throw new Error(`Qwen 图像编辑返回中未找到 image URL：${raw.slice(0, 500)}`)
  }
  return imageUrl
}

function resolvePrimaryModel(model?: string): string {
  const chosen = (model ?? '').trim()
  if (chosen) {
    return chosen
  }
  return config.qwenImageEdit.model
}

// ---------- 入口 ----------

export async function generateQwenCardCover(body: ICardCoverQwenGenerateBody): Promise<ICardCoverQwenGenerateData> {
  const prepared = prepareEditInput(body, config.qwenImageEdit.maxInputBytes || DEFAULT_MAX_INPUT_BYTES)
  const runCompare = body.runCompare !== false
  const primaryModel = resolvePrimaryModel(body.model)
  // 对比模型沿用旧系统默认 qwen-image-edit-max（新 config 未提供 compareModel 字段）
  const compareModel = 'qwen-image-edit-max'
  const models = runCompare
    ? uniqueModels([primaryModel, compareModel])
    : [primaryModel]

  const warnings: string[] = []
  if (runCompare && models.length === 1) {
    warnings.push('对比模型与主模型相同，本次只执行一次模型调用。')
  }

  const variants: ICardCoverQwenVariant[] = []
  for (const model of models) {
    for (const kind of ['faithful', 'beautified'] as const) {
      const startedAt = Date.now()
      const imageUrl = await callQwenEdit({
        image: prepared.image,
        kind,
        model,
      })
      variants.push({
        kind,
        model,
        imageUrl,
        elapsedMs: Date.now() - startedAt,
        promptVersion: PROMPT_VERSION,
      })
    }
  }

  return {
    sourceMeta: prepared.meta,
    variants,
    warnings,
  }
}
