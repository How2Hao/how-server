import { defineHandler } from 'nitro'
import { respond } from '~/server/utils/response.ts'
import { getCategoryTree } from '~/server/utils/services/coupon-category.ts'

/** 拉完整树（admin 卡券管理页 + 活动表单"已选"展开都用这个） */
export default defineHandler(async () => {
  return respond(() => getCategoryTree())
})
