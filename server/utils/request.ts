// 请求元信息与请求体解析工具
import type { H3Event } from 'nitro/h3'

export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

/** 提取客户端 IP / UA（与旧系统一致：x-forwarded-for → x-real-ip） */
export function getRequestMeta(event: H3Event): RequestMeta {
  const forwarded = event.req.headers.get('x-forwarded-for') || ''
  const realIp = event.req.headers.get('x-real-ip') || ''
  const ip = (forwarded || realIp).split(',')[0].trim()
  const userAgent = (event.req.headers.get('user-agent') || '').trim()
  return { ip: ip || null, userAgent: userAgent || null }
}

/** 宽松解析 JSON body：非法/空 body 返回 {}（旧系统 body?.x 防御式写法的前提） */
export async function readJson<T = Record<string, unknown>>(event: H3Event): Promise<Partial<T>> {
  try {
    const raw = await event.req.text()
    if (!raw)
      return {}
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : {}
  }
  catch {
    return {}
  }
}

/** 读取 query 参数（event.url.searchParams） */
export function query(event: H3Event): URLSearchParams {
  return event.url.searchParams
}
