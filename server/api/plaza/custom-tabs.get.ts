import { defineHandler } from 'nitro'
import { respond } from '~/server/utils/response.ts'
import { getVisibleCustomTabs } from '~/server/utils/services/plaza-custom-tab.ts'

/** 广场自定义 Tab（生产过滤 is_visible 与起止时间窗口，本地调试不过滤） */
export default defineHandler(async () => {
  return respond(() => getVisibleCustomTabs())
})
