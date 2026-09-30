import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { registerOrUpdateDeviceToken } from '~/server/utils/services/device-token.ts'

/** ha 登录后注册推送 token（UPSERT by (user_id, device_id)） */
export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const body = await readJson<{
    platform?: string
    apnsToken?: string | null
    apnsEnv?: string | null
    deviceId?: string
    appVersion?: string | null
    osVersion?: string | null
  }>(event)
  return respond(async () => {
    const row = await registerOrUpdateDeviceToken(userId, {
      platform: body.platform ?? '',
      apnsToken: body.apnsToken ?? null,
      apnsEnv: body.apnsEnv ?? null,
      deviceId: body.deviceId ?? '',
      appVersion: body.appVersion ?? null,
      osVersion: body.osVersion ?? null,
    })
    return { id: Number(row.id), isActive: row.isActive === 1 }
  })
})
