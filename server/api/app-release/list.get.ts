import { defineHandler } from 'nitro'
import { respond } from '~/server/utils/response.ts'
import { listAppReleases } from '~/server/utils/services/app-release.ts'

/** 版本发布接口（公开，未登录可访问） */
export default defineHandler(async () => {
  return respond(() => listAppReleases())
})
