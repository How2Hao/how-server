import { defineHandler } from 'nitro'
import { findAllUsagePlatforms } from '~/server/utils/services/benefit-usage-platform.ts'

/**
 * CRITICAL QUIRK：旧控制器直接返回 service 结果，没有 {success,message,data} 包装。
 * 客户端按裸数组消费，必须保持原样。
 */
export default defineHandler(async () => {
  return findAllUsagePlatforms()
})
