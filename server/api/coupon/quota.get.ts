import { defineHandler } from 'nitro'
import { getAuth } from '~/server/utils/auth-guard.ts'
import { fail, respond } from '~/server/utils/response.ts'
import { getQuotaLimit, getQuotaUsed } from '~/server/utils/services/user-ai-quota.ts'

const FEATURE = 'coupon_ocr'

/** 本月识别额度：{ used, limit } */
export default defineHandler(async (event) => {
  // 鉴权 quirk：/coupon 不在全局中间件白名单 → 手动取登录态；未登录返回 fail（HTTP 200）
  const authUser = getAuth(event)
  if (!authUser)
    return fail('未登录')
  return respond(async () => {
    const used = await getQuotaUsed(authUser.userId, FEATURE)
    const limit = getQuotaLimit(FEATURE)
    return { used, limit }
  })
})
