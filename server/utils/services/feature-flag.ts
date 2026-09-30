// 功能开关（移植自旧 FeatureFlagService）：system_feature_flag 表，30s 缓存，缺失行视为开启
import { eq } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { systemFeatureFlag } from '~/server/database/schema/notification.ts'

interface FlagEntry { enabled: boolean, expiresAt: number }

const g = globalThis as typeof globalThis & { __featureFlagCache?: Map<string, FlagEntry> }
const flagCache = (g.__featureFlagCache ??= new Map<string, FlagEntry>())

export async function isFeatureEnabled(feature: string): Promise<boolean> {
  const now = Date.now()
  const hit = flagCache.get(feature)
  if (hit && hit.expiresAt > now)
    return hit.enabled

  const [row] = await db.select({ enabled: systemFeatureFlag.enabled })
    .from(systemFeatureFlag)
    .where(eq(systemFeatureFlag.feature, feature))
    .limit(1)
  // 表里没有记录视为开启（不强制所有 feature 都要预先插入）
  const enabled = !row || row.enabled === 1
  flagCache.set(feature, { enabled, expiresAt: now + 30_000 })
  return enabled
}

/** 强制刷新缓存，admin 更新后可选调用 */
export function invalidateFeatureFlag(feature?: string): void {
  if (feature)
    flagCache.delete(feature)
  else flagCache.clear()
}
