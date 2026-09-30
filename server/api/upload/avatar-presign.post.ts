import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { presignAvatarUpload } from '~/server/utils/services/upload.ts'

/** 头像上传预签名：PUT 直传 OSS，路径 avatars/{uid6}/{YYYYMMDD}_{ts}.{ext} */
export default defineHandler(async (event) => {
  const { uid6 } = requireAuth(event)
  const body = await readJson<{ ext?: string }>(event)
  return respond(async () => {
    const ext = String(body.ext || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg'
    return presignAvatarUpload(uid6, ext)
  })
})
