// 反馈提交的纯校验逻辑（无 DB，可单测）：移植自旧 FeedbackController 的入参处理
export interface FeedbackSubmitInput {
  type: 'BUG' | 'FEATURE' | 'CARD_FACE'
  content: string
  images: string[]
  context: Record<string, unknown> | null
}

/**
 * context 是 app 端无权限采集的设备/环境快照；只接受纯对象，且做 8KB 上限保护。
 * 不合法一律返回 null（与旧系统一致：静默丢弃，不报错）。
 */
export function sanitizeContext(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return null
  try {
    const json = JSON.stringify(raw)
    if (json.length > 8 * 1024)
      return null
    return raw as Record<string, unknown>
  }
  catch {
    return null
  }
}

/** 提交入参校验：非法 type/content 直接抛错（文案与旧系统一致），images 截断到 3 张 */
export function parseFeedbackSubmitInput(body: unknown): FeedbackSubmitInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>

  const type = String(b.type ?? '').toUpperCase() as FeedbackSubmitInput['type']
  if (!['BUG', 'FEATURE', 'CARD_FACE'].includes(type))
    throw new Error('反馈类型无效')

  const content = String(b.content ?? '').trim()
  if (!content)
    throw new Error('请填写反馈内容')

  const images = Array.isArray(b.images) ? (b.images as string[]).slice(0, 3) : []
  const context = sanitizeContext(b.context)

  return { type, content, images, context }
}
