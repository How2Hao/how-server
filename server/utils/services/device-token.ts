// 设备推送 token（移植自旧 src/service/device_token.ts）
// 按 (user_id, device_id) UPSERT：同设备重复注册（如 token 变化）更新而非插入新行
import { and, eq } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { deviceToken } from '~/server/database/schema/notification.ts'

export interface DeviceTokenRegisterPayload {
  platform: string // 'IOS' | 'ANDROID'
  apnsToken?: string | null
  apnsEnv?: string | null // 'sandbox' | 'production'
  deviceId: string
  appVersion?: string | null
  osVersion?: string | null
}

export type DeviceTokenRow = typeof deviceToken.$inferSelect

/**
 * UPSERT by (user_id, device_id)：同设备重复注册（如 token 变化）会更新而非插入新行。
 */
export async function registerOrUpdateDeviceToken(
  userId: number,
  payload: DeviceTokenRegisterPayload,
): Promise<DeviceTokenRow> {
  const platform = String(payload.platform || '').toUpperCase()
  if (platform !== 'IOS' && platform !== 'ANDROID') {
    throw new Error('platform 必须是 IOS 或 ANDROID')
  }
  const deviceId = String(payload.deviceId || '').trim()
  if (!deviceId) {
    throw new Error('deviceId 不能为空')
  }
  if (platform === 'IOS') {
    if (!payload.apnsToken)
      throw new Error('iOS 必须提供 apnsToken')
    if (payload.apnsEnv !== 'sandbox' && payload.apnsEnv !== 'production') {
      throw new Error('apnsEnv 必须是 sandbox 或 production')
    }
  }

  const now = Date.now()
  const [existing] = await db.select().from(deviceToken).where(and(eq(deviceToken.userId, userId), eq(deviceToken.deviceId, deviceId))).limit(1)

  if (existing) {
    const patch = {
      platform,
      apnsToken: payload.apnsToken ?? null,
      apnsEnv: payload.apnsEnv ?? null,
      appVersion: payload.appVersion ?? null,
      osVersion: payload.osVersion ?? null,
      isActive: 1,
      lastActiveAt: now,
      updatedAt: now,
    }
    await db.update(deviceToken).set(patch).where(eq(deviceToken.id, existing.id))
    return { ...existing, ...patch }
  }

  const row = {
    userId,
    platform,
    apnsToken: payload.apnsToken ?? null,
    apnsEnv: payload.apnsEnv ?? null,
    deviceId,
    appVersion: payload.appVersion ?? null,
    osVersion: payload.osVersion ?? null,
    isActive: 1,
    lastActiveAt: now,
    createdAt: now,
    updatedAt: now,
  }
  const [inserted] = await db.insert(deviceToken).values(row).$returningId()
  return { id: Number(inserted.id), ...row }
}

export async function deactivateDeviceToken(userId: number, deviceId: string): Promise<void> {
  await db.update(deviceToken)
    .set({ isActive: 0, updatedAt: Date.now() })
    .where(and(eq(deviceToken.userId, userId), eq(deviceToken.deviceId, deviceId)))
}
