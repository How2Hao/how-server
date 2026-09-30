import { defineHandler } from 'nitro'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { getActivityCategoryById } from '~/server/utils/services/activity-category.ts'

/** 按 id 查详情；查不到返回 data: null（与旧系统一致） */
export default defineHandler(async (event) => {
  const id = Number(query(event).get('id'))
  return respond(() => getActivityCategoryById(id))
})
