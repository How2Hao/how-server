import type { AppUserSettings } from '~/server/utils/services/user-settings-core.ts'
// 用户设置服务：user_settings 单表 JSON（schema v1）。
// 纯逻辑（默认值/校验/深合并/归属清洗）在 user-settings-core.ts，本文件只做 DB 读写。
// 语义与旧 how-api UserSettingsService 一致：GET 自愈写回，PATCH 严格校验。
import { eq } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { accLedger, accUser } from '~/server/database/schema/acc.ts'
import { userSettings } from '~/server/database/schema/notification.ts'
import { cloneDefaultSettings, mergeSettings, normalizeSettingsInput, sanitizeSettingsByOwnership } from '~/server/utils/services/user-settings-core.ts'

export type { AppUserSettings } from '~/server/utils/services/user-settings-core.ts'

type UserSettingsRow = typeof userSettings.$inferSelect

/** AppUserSettings（interface 无隐式索引签名）→ JSON 列的 Record 类型 */
function toJson(value: AppUserSettings): Record<string, unknown> {
  return value as unknown as Record<string, unknown>
}

/** 读取用户设置：规范化存量数据 + 归属清洗，需要时自愈写回 DB */
export async function getSettings(userId: number): Promise<unknown> {
  const row = await getOrCreate(userId)
  const normalizedFromDb = normalizeSettingsInput(row.settingsJson, false)
  let merged = mergeSettings(cloneDefaultSettings(), normalizedFromDb)
  merged = await sanitizeByOwnership(userId, merged)

  // 自愈写回：存量数据缺字段 / schema 版本不符时，落库为规范化后的 JSON
  const nextJson = JSON.stringify(merged)
  const currJson = JSON.stringify(row.settingsJson || {})
  if (row.schemaVersion !== 1 || currJson !== nextJson) {
    await db.update(userSettings).set({
      schemaVersion: 1,
      settingsJson: toJson(merged),
      updatedAt: Date.now(),
    }).where(eq(userSettings.id, row.id))
  }

  return merged
}

/** 更新用户设置：深合并补丁 + 归属清洗后整体落库 */
export async function patchSettings(userId: number, patch: Record<string, unknown>): Promise<unknown> {
  const row = await getOrCreate(userId)
  const normalized = normalizeSettingsInput(patch, true)
  const current = mergeSettings(cloneDefaultSettings(), normalizeSettingsInput(row.settingsJson, false))
  let merged = mergeSettings(current, normalized)
  merged = await sanitizeByOwnership(userId, merged)

  await db.update(userSettings).set({
    schemaVersion: 1,
    settingsJson: toJson(merged),
    updatedAt: Date.now(),
  }).where(eq(userSettings.id, row.id))

  return merged
}

/** 不存在则插入一条默认设置行 */
async function getOrCreate(userId: number): Promise<UserSettingsRow> {
  const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1)
  if (row)
    return row

  const now = Date.now()
  const [inserted] = await db.insert(userSettings).values({
    userId,
    schemaVersion: 1,
    settingsJson: toJson(cloneDefaultSettings()),
    createdAt: now,
    updatedAt: now,
  }).$returningId()

  const [created] = await db.select().from(userSettings).where(eq(userSettings.id, Number(inserted.id))).limit(1)
  return created!
}

/** 取该用户的账本/记账成员 id 集合并做归属清洗 */
async function sanitizeByOwnership(userId: number, settings: AppUserSettings): Promise<AppUserSettings> {
  const [ledgers, accUsers] = await Promise.all([
    db.select({ id: accLedger.id }).from(accLedger).where(eq(accLedger.userId, userId)),
    db.select({ id: accUser.id }).from(accUser).where(eq(accUser.userId, userId)),
  ])
  return sanitizeSettingsByOwnership(
    settings,
    new Set(ledgers.map(l => l.id)),
    new Set(accUsers.map(u => u.id)),
  )
}
