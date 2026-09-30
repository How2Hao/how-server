import { defineHandler } from 'nitro'
import { query } from '~/server/utils/request.ts'
import { findUsagePlatformById } from '~/server/utils/services/benefit-usage-platform.ts'

/**
 * CRITICAL QUIRK：旧控制器直接返回 service 结果（行对象或 null），没有
 * {success,message,data} 包装。保持原样。
 */
export default defineHandler(async (event) => {
  const raw = query(event).get('id')
  const id = raw != null ? Number(raw) : Number.NaN
  if (!Number.isFinite(id))
    return null
  return findUsagePlatformById(id)
})
