import { defineHandler } from 'nitro'
import { getAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { fail, respond } from '~/server/utils/response.ts'
import { parseFromBase64 } from '~/server/utils/services/coupon-parse.ts'
import { isFeatureEnabled } from '~/server/utils/services/feature-flag.ts'
import { checkQuota, incrementQuota } from '~/server/utils/services/user-ai-quota.ts'

const FEATURE = 'coupon_ocr'

/** 优惠券截图识别：功能开关 → 配额 → 识别 → 成功后计数 */
export default defineHandler(async (event) => {
  // 鉴权 quirk：/coupon 不在全局中间件白名单 → 手动取登录态；未登录返回 fail（HTTP 200）
  const authUser = getAuth(event)
  if (!authUser)
    return fail('未登录')

  const body = await readJson<{ imageBase64?: string, mimeType?: string }>(event)
  return respond(async () => {
    if (!await isFeatureEnabled(FEATURE)) {
      throw new Error('该功能暂时不可用')
    }

    const { imageBase64, mimeType } = body
    if (!imageBase64?.trim()) {
      throw new Error('imageBase64 不能为空')
    }

    // 兜底拦截超大图（约 2MB 原图）
    const approxBytes = (imageBase64.length * 3) / 4
    if (approxBytes > 2 * 1024 * 1024) {
      throw new Error('图片过大，请压缩后上传')
    }

    await checkQuota(authUser.userId, FEATURE)

    try {
      const coupons = await parseFromBase64(imageBase64, mimeType)
      await incrementQuota(authUser.userId, FEATURE)
      return coupons
    }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[CouponParse] error:', msg)
      throw new Error(`识别失败：${msg}`)
    }
  })
})
