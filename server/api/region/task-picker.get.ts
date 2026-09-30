// GET /region/task-picker：任务归属地选择器数据（全国 + 热门城市 + 省份-城市分组，公开接口）
import { defineHandler } from 'nitro'
import { respond } from '~/server/utils/response.ts'
import { getTaskRegionPickerData } from '~/server/utils/services/region.ts'

export default defineHandler(async () => {
  return respond(() => getTaskRegionPickerData())
})
