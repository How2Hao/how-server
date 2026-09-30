// 启动预热：字典缓存（失败不阻塞启动，首次使用时 lazy 补）
import { definePlugin } from 'nitro'
import { warmup } from '~/server/utils/services/reference-cache.ts'

export default definePlugin(() => {
  warmup().catch(() => {})
})
