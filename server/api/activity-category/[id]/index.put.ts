import type { ActivityCategoryUpsertData } from '~/server/utils/services/activity-category.ts'
import { defineHandler } from 'nitro'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { updateActivityCategory } from '~/server/utils/services/activity-category.ts'

/** 更新（公开写接口，与旧系统一致）；id 不存在时返回 data: null */
export default defineHandler(async (event) => {
  const id = Number(event.context.params?.id)
  const body = await readJson<ActivityCategoryUpsertData>(event)
  return respond(() => updateActivityCategory(id, body as ActivityCategoryUpsertData))
})
