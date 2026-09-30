import { defineHandler } from 'nitro'
import { respond } from '~/server/utils/response.ts'
import { getAllBenefitCategories } from '~/server/utils/services/benefit-category.ts'

/** 银行优惠类目（含关联支付平台展开） */
export default defineHandler(async () => {
  return respond(() => getAllBenefitCategories())
})
