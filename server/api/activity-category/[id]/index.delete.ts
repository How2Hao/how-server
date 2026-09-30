import { defineHandler } from 'nitro'
import { respond } from '~/server/utils/response.ts'
import { deleteActivityCategory } from '~/server/utils/services/activity-category.ts'

/** 删除（公开写接口，与旧系统一致）；返回是否删除成功 */
export default defineHandler(async (event) => {
  const id = Number(event.context.params?.id)
  return respond(() => deleteActivityCategory(id))
})
