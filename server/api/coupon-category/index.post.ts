import { defineHandler } from 'nitro'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { createCouponCategory } from '~/server/utils/services/coupon-category.ts'

/** 新增（旧系统 /coupon-category 全部公开，包括写接口，保持原样） */
export default defineHandler(async (event) => {
  const body = await readJson<{
    parentId?: number
    name?: string
    sortOrder?: number
    logoUrl?: string | null
    skuQueryName?: string | null
  }>(event)
  return respond(() => createCouponCategory({
    parentId: body.parentId == null ? 0 : Number(body.parentId),
    name: String(body.name ?? ''),
    sortOrder: body.sortOrder,
    logoUrl: body.logoUrl,
    skuQueryName: body.skuQueryName,
  }))
})
