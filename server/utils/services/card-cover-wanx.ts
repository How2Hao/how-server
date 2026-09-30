import type { PreparedEditInput, VariantKind } from './card-cover-qwen.ts'
// 银行卡封面生成（移植自旧 src/service/card_cover_wanx_edit.ts）：WanX 2.1 图像编辑，
// 异步任务模式：创建任务（X-DashScope-Async: enable）→ 2s 轮询 → 120s 超时。
// 旧实现用 https.request，这里改为 fetch()，轮询间隔/超时行为与错误文案保持一致。
import type { ICardCoverQwenGenerateBody, ICardCoverQwenGenerateData, ICardCoverQwenVariant } from '~/server/utils/types.ts'
import { config } from '~/server/utils/config.ts'
import { prepareEditInput } from './card-cover-qwen.ts'

interface WanxTaskCreateBody {
  output?: {
    task_id?: string
    task_status?: string
  }
  request_id?: string
  code?: string
  message?: string
}

interface WanxTaskResultBody {
  output?: {
    task_id?: string
    task_status?: string
    code?: string
    message?: string
    results?: Array<{
      url?: string
      code?: string
      message?: string
    }>
  }
  usage?: {
    image_count?: number
  }
  request_id?: string
  code?: string
  message?: string
}

const PROMPT_VERSION = 'wanx-card-cover-v1'
const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024
const DASHSCOPE_HOST = 'dashscope.aliyuncs.com'
const WANX_CREATE_PATH = '/api/v1/services/aigc/image2image/image-synthesis'
const WANX_TASK_BASE_PATH = '/api/v1/tasks'

// ---------- 纯函数 ----------

function resolveStrength(kind: VariantKind): number {
  return kind === 'faithful' ? 0.05 : 0.12
}

function buildPrompt(kind: VariantKind): string {
  const common = [
    '不要重新设计银行卡，不要把它做成海报或商品展示图。',
    '请把输入照片中的银行卡封面主体准确提取出来，并整理成一张像扫描件一样的标准卡面图。',
    '输出里只能有银行卡封面本身，卡片四周不能残留任何背景、留白、衬底、阴影、桌面、手部或环境像素。',
    '卡片必须完全拉正，正面平视，横平竖直，像扫描件一样规整。',
    '如果原图是竖着拍的，请先把银行卡整体向右旋转90度，再输出横版卡面。',
    '必须严格保留原卡面的文字、logo、图案、纹理、配色和布局。',
    '不允许改字、不允许改图案、不允许改logo、不允许改配色、不允许新增装饰。',
    '只允许做以下处理：去背景、拉正透视、裁切到卡片边缘、轻微修复反光和模糊。',
    '如果无法确定细节，请保守还原，绝不要擅自改动原卡内容。',
  ].join('\n')

  if (kind === 'faithful') {
    return [
      common,
      '本次请以“绝对保真”为最高优先级。',
      '宁可保留轻微使用痕迹，也不要让原卡面内容发生任何变化。',
    ].join('\n')
  }

  return [
    common,
    '本次请做非常克制的清理，让结果更接近平整扫描件。',
    '但 beautified 也绝不能改变原卡面的任何设计内容，只能减少拍摄噪声。',
  ].join('\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number, apiLabel: string): Promise<string> {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${apiLabel} HTTP ${res.status}: ${text}`)
  }
  return text
}

function parseCreateResponse(raw: string): WanxTaskCreateBody {
  let parsed: WanxTaskCreateBody
  try {
    parsed = JSON.parse(raw) as WanxTaskCreateBody
  }
  catch {
    throw new Error(`WanX 图像编辑返回了非 JSON 内容：${raw.slice(0, 300)}`)
  }

  if (parsed.code || parsed.message) {
    const code = parsed.code ? `${parsed.code}: ` : ''
    throw new Error(`${code}${parsed.message || 'WanX 图像编辑调用失败'}`)
  }

  return parsed
}

function parseTaskResult(raw: string): WanxTaskResultBody {
  let parsed: WanxTaskResultBody
  try {
    parsed = JSON.parse(raw) as WanxTaskResultBody
  }
  catch {
    throw new Error(`WanX 图像编辑任务结果返回了非 JSON 内容：${raw.slice(0, 300)}`)
  }

  if (parsed.code || parsed.message) {
    const code = parsed.code ? `${parsed.code}: ` : ''
    throw new Error(`${code}${parsed.message || 'WanX 图像编辑任务查询失败'}`)
  }

  return parsed
}

function extractImageUrl(parsed: WanxTaskResultBody): string | null {
  const results = parsed.output?.results
  if (!Array.isArray(results)) {
    return null
  }
  for (const result of results) {
    const image = result?.url?.trim()
    if (image) {
      return image
    }
  }
  return null
}

async function waitForTask(options: {
  apiKey: string
  taskId: string
  timeoutMs: number
  pollIntervalMs: number
}): Promise<WanxTaskResultBody> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < options.timeoutMs) {
    const raw = await getJson(
      `https://${DASHSCOPE_HOST}${WANX_TASK_BASE_PATH}/${encodeURIComponent(options.taskId)}`,
      { Authorization: `Bearer ${options.apiKey}` },
      options.timeoutMs,
      'WanXImageEdit fetch-task',
    )
    const parsed = parseTaskResult(raw)
    const status = parsed.output?.task_status

    if (status === 'SUCCEEDED') {
      return parsed
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      const code = parsed.output?.code || parsed.code || ''
      const message = parsed.output?.message || parsed.message || '任务失败'
      throw new Error(`${code ? `${code}: ` : ''}${message}`)
    }

    await sleep(options.pollIntervalMs)
  }

  throw new Error(`WanX 图像编辑任务等待超时 (${options.timeoutMs} ms)`)
}

// ---------- 入口 ----------

async function callWanxEdit(options: {
  image: string
  kind: VariantKind
}): Promise<string> {
  const apiKey = config.bankCardVision.dashscopeApiKey.trim()
  if (!apiKey) {
    throw new Error('缺少 DASHSCOPE_API_KEY，无法调用 WanX 图像编辑模型')
  }

  const timeoutMs = config.wanxImageEdit.timeoutMs
  const pollIntervalMs = config.wanxImageEdit.pollIntervalMs

  const payload = JSON.stringify({
    // 旧实现硬编码 model 与 function（description_edit），config 里的 function_ 默认值不同，故不读取
    model: 'wanx2.1-imageedit',
    input: {
      function: 'description_edit',
      prompt: buildPrompt(options.kind),
      base_image_url: options.image,
    },
    parameters: {
      n: 1,
      watermark: false,
      strength: resolveStrength(options.kind),
    },
  })

  const createdRaw = await postJson(
    `https://${DASHSCOPE_HOST}${WANX_CREATE_PATH}`,
    {
      'Authorization': `Bearer ${apiKey}`,
      'X-DashScope-Async': 'enable',
    },
    payload,
    timeoutMs,
    'WanXImageEdit create-task',
  )
  const created = parseCreateResponse(createdRaw)
  const taskId = created.output?.task_id?.trim()
  if (!taskId) {
    throw new Error(`WanX 图像编辑未返回 task_id：${createdRaw.slice(0, 500)}`)
  }

  const taskResult = await waitForTask({
    apiKey,
    taskId,
    timeoutMs,
    pollIntervalMs,
  })

  const imageUrl = extractImageUrl(taskResult)
  if (!imageUrl) {
    throw new Error(`WanX 图像编辑返回中未找到 image URL：${JSON.stringify(taskResult).slice(0, 500)}`)
  }
  return imageUrl
}

export async function generateWanxCardCover(body: ICardCoverQwenGenerateBody): Promise<ICardCoverQwenGenerateData> {
  const prepared: PreparedEditInput = prepareEditInput(
    body,
    config.wanxImageEdit.maxInputBytes || DEFAULT_MAX_INPUT_BYTES,
  )
  const warnings = [
    'WanX 2.1 为 legacy 通用图像编辑模型，官方能力上限为 1024x1024 输出，本次主要用于对比“保真轻改”效果。',
  ]

  const variants: ICardCoverQwenVariant[] = []
  for (const kind of ['faithful', 'beautified'] as const) {
    const startedAt = Date.now()
    const imageUrl = await callWanxEdit({
      image: prepared.image,
      kind,
    })
    variants.push({
      kind,
      model: 'wanx2.1-imageedit',
      imageUrl,
      elapsedMs: Date.now() - startedAt,
      promptVersion: PROMPT_VERSION,
    })
  }

  return {
    sourceMeta: prepared.meta,
    variants,
    warnings,
  }
}
