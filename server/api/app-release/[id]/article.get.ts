import { defineHandler } from 'nitro'
import { respond } from '~/server/utils/response.ts'
import { getReleaseArticleById } from '~/server/utils/services/app-release.ts'

/** 版本文章详情（markdown 正文），不存在/无文章返回 data: null */
export default defineHandler(async (event) => {
  const id = Number(event.context.params?.id)
  return respond(() => getReleaseArticleById(id))
})
