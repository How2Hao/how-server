import { defineHandler } from 'nitro'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { searchCouponCategories } from '~/server/utils/services/coupon-category.ts'

/** 模糊搜（活动表单"添加关联卡券"远程搜索，仅二级品牌） */
export default defineHandler(async (event) => {
  const q = query(event)
  const limitParam = q.get('limit')
  const limit = limitParam ? Number(limitParam) : 30
  return respond(() => searchCouponCategories(q.get('q') ?? '', limit))
})
