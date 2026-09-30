import type { ActivityCategoryUpsertData } from '~/server/utils/services/activity-category.ts'
import { defineHandler } from 'nitro'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { createActivityCategory } from '~/server/utils/services/activity-category.ts'

/** 新增（公开写接口，与旧系统一致） */
export default defineHandler(async (event) => {
  const body = await readJson<ActivityCategoryUpsertData>(event)
  return respond(() => createActivityCategory(body as ActivityCategoryUpsertData))
})
