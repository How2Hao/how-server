import { defineHandler } from 'nitro'
import { respond } from '~/server/utils/response.ts'
import { getActivityCategoryTree } from '~/server/utils/services/activity-category.ts'

export default defineHandler(async () => {
  return respond(() => getActivityCategoryTree())
})
