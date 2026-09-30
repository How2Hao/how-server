import { defineHandler } from 'nitro'
import { respond } from '~/server/utils/response.ts'
import { findCouponCategoryById } from '~/server/utils/services/coupon-category.ts'

/** 单个详情 */
export default defineHandler(async (event) => {
  const id = Number(event.context.params?.id)
  return respond(async () => {
    const data = await findCouponCategoryById(id)
    if (!data)
      throw new Error('不存在')
    return data
  })
})
