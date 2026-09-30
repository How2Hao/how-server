import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { patchSettings } from '~/server/utils/services/user-settings.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  // 宽松解析：空/非法 body 与旧系统 `body || {}` 等价（strict 校验再报错）
  const body = await readJson(event)
  return respond(() => patchSettings(userId, body as Record<string, unknown>))
})
