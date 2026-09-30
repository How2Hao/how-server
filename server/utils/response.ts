// 统一响应包装：所有接口返回 { success, message, data }，HTTP 状态恒为 200（仅鉴权中间件返回 401）
export interface IResponse<T = unknown> {
  success: boolean
  message: string
  data: T | null
}

export function ok<T>(data: T, message = 'OK'): IResponse<T> {
  return { success: true, message, data }
}

export function fail(message: string): IResponse<never> {
  return { success: false, message, data: null }
}

/**
 * 执行业务逻辑并包装为 IResponse：
 * 服务层 throw Error（中文 message）→ 捕获后返回 success:false（HTTP 仍为 200，与旧系统一致）。
 */
export async function respond<T>(fn: () => Promise<T>): Promise<IResponse<T>> {
  try {
    return ok(await fn())
  }
  catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}
