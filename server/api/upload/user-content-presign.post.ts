import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { presignUserContentUpload } from '~/server/utils/services/upload.ts'

/** 通用用户内容上传预签名：路径 {folder}/{uid6}/{YYYYMMDD}_{ts}.{ext} */
export default defineHandler(async (event) => {
  const { uid6 } = requireAuth(event)
  const body = await readJson<{ folder?: string, ext?: string }>(event)
  return respond(async () => {
    const folder = String(body.folder || 'uploads')
    const ext = String(body.ext || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg'
    return presignUserContentUpload(uid6, folder, ext)
  })
})
