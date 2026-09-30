import { defineHandler } from 'nitro'
import { respond } from '~/server/utils/response.ts'
import { getLatestAppRelease } from '~/server/utils/services/app-release.ts'

/** 最新版本（客户端做版本对比 + 升级提示） */
export default defineHandler(async () => {
  return respond(() => getLatestAppRelease())
})
