import { defineHandler } from 'nitro'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { updateCouponCategory } from '~/server/utils/services/coupon-category.ts'

/** 编辑（name / sortOrder / isVisible / logoUrl）；旧系统该写接口同样公开，保持原样 */
export default defineHandler(async (event) => {
  const id = Number(event.context.params?.id)
  const body = await readJson<{
    name?: string
    sortOrder?: number
    isVisible?: boolean
    logoUrl?: string | null
  }>(event)
  return respond(() => updateCouponCategory(id, body))
})
