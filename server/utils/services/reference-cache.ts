// 字典表进程内缓存（移植自旧 ReferenceCacheService）
//
// - module 级单例（不随请求重建）。
// - 全量缓存 + miss-fallback：结果集引用了缓存里没有的 ID（如运营新增银行）时只补查缺失的
//   几条并回填，保证新增数据实时可见，又不重复全表查。
// - single-flight：同 key 并发只放一个去 DB，其余 await 同一 Promise，防缓存击穿。
// - 失败不毒化：fetcher 抛错时不写缓存、清 inflight、向上抛 —— 退化成"无缓存直查 DB"。
// - 进程启动预热（见 server/plugins/warmup.ts）。
// - admin 改字典后最多 TTL（10min）生效；要实时可调 invalidate() 主动清。
import { asc, inArray } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import {
  activityCategory,
  adminUser,
  bank,
  benefitCategory,
  benefitPayPlatform,
  benefitUsagePlatform,
  cardOrganization,
  couponCategory,
  region,
} from '~/server/database/schema/plaza.ts'

type BankRow = typeof bank.$inferSelect
type ActivityCategoryRow = typeof activityCategory.$inferSelect
type CardOrganizationRow = typeof cardOrganization.$inferSelect
type BenefitCategoryRow = typeof benefitCategory.$inferSelect
type BenefitPayPlatformRow = typeof benefitPayPlatform.$inferSelect
type BenefitUsagePlatformRow = typeof benefitUsagePlatform.$inferSelect
type AdminUserRow = typeof adminUser.$inferSelect
type CouponCategoryRow = typeof couponCategory.$inferSelect
type RegionRow = typeof region.$inferSelect

/** Region 索引：按 code 直查 + 按 parentCode 查子节点，供内存遍历替代多次 DB 查 */
export interface RegionIndex {
  byCode: Map<string, RegionRow>
  byParent: Map<string, RegionRow[]>
}

interface CacheEntry { data: unknown, expiry: number }

const TTL_MS = 10 * 60_000

const g = globalThis as typeof globalThis & {
  __refCache?: Map<string, CacheEntry>
  __refInflight?: Map<string, Promise<unknown>>
}
const cache = (g.__refCache ??= new Map<string, CacheEntry>())
const inflight = (g.__refInflight ??= new Map<string, Promise<unknown>>())

/** single-flight + 失败不毒化 */
async function cachedList<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && hit.expiry > Date.now())
    return hit.data as T

  const existing = inflight.get(key)
  if (existing)
    return existing as Promise<T>

  const p = fetcher()
    .then((data) => {
      cache.set(key, { data, expiry: Date.now() + TTL_MS })
      inflight.delete(key)
      return data
    })
    .catch((e) => {
      inflight.delete(key) // 清掉，下次能重试，不卡死
      throw e // 向上抛 = 退化成"无缓存直查 DB 失败"
    })
  inflight.set(key, p)
  return p
}

async function getMap<T>(key: string, fetchAll: () => Promise<T[]>, idOf: (x: T) => number): Promise<Map<number, T>> {
  return cachedList(key, async () => {
    const rows = await fetchAll()
    return new Map<number, T>(rows.map(r => [idOf(r), r]))
  })
}

/** 全量缓存 + miss-fallback：缺失 ID 只补查并回填（self-healing） */
async function resolve<T>(
  key: string,
  idOf: (x: T) => number,
  ids: number[],
  fetchAll: () => Promise<T[]>,
  fetchByIds: (missing: number[]) => Promise<T[]>,
): Promise<Map<number, T>> {
  const map = await getMap(key, fetchAll, idOf)
  const missing = ids.filter(id => Number.isFinite(id) && !map.has(id))
  if (missing.length === 0)
    return map
  const fresh = await fetchByIds(missing)
  for (const row of fresh) map.set(idOf(row), row)
  return map
}

// ─── 公开 API ───────────────────────────────────────────────────────────

/** 卡组织：消费方式是整表构建 context（按名字/组合匹配），无"按 ID"语义 → 全量缓存 */
export function getCardOrganizations(): Promise<CardOrganizationRow[]> {
  return cachedList('cardOrgs', () => db.select().from(cardOrganization).orderBy(asc(cardOrganization.id)))
}

export function resolveBanks(ids: number[]): Promise<Map<number, BankRow>> {
  return resolve(
    'banks',
    b => Number(b.id),
    ids,
    () => db.select().from(bank),
    missing => db.select().from(bank).where(inArray(bank.id, missing)),
  )
}

export function resolveActivityCategories(ids: number[]): Promise<Map<number, ActivityCategoryRow>> {
  return resolve(
    'activityCategories',
    x => Number(x.id),
    ids,
    () => db.select().from(activityCategory),
    missing => db.select().from(activityCategory).where(inArray(activityCategory.id, missing)),
  )
}

export function resolveBenefitCategories(ids: number[]): Promise<Map<number, BenefitCategoryRow>> {
  return resolve(
    'benefitCategories',
    x => Number(x.id),
    ids,
    () => db.select().from(benefitCategory),
    missing => db.select().from(benefitCategory).where(inArray(benefitCategory.id, missing)),
  )
}

export function resolveBenefitPayPlatforms(ids: number[]): Promise<Map<number, BenefitPayPlatformRow>> {
  return resolve(
    'benefitPay',
    x => Number(x.id),
    ids,
    () => db.select().from(benefitPayPlatform),
    missing => db.select().from(benefitPayPlatform).where(inArray(benefitPayPlatform.id, missing)),
  )
}

export function resolveBenefitUsagePlatforms(ids: number[]): Promise<Map<number, BenefitUsagePlatformRow>> {
  return resolve(
    'benefitUsage',
    x => Number(x.id),
    ids,
    () => db.select().from(benefitUsagePlatform),
    missing => db.select().from(benefitUsagePlatform).where(inArray(benefitUsagePlatform.id, missing)),
  )
}

export function resolveAdminUsers(ids: number[]): Promise<Map<number, AdminUserRow>> {
  return resolve(
    'adminUsers',
    x => Number(x.id),
    ids,
    () => db.select().from(adminUser),
    missing => db.select().from(adminUser).where(inArray(adminUser.id, missing)),
  )
}

export function resolveCouponCategories(ids: number[]): Promise<Map<number, CouponCategoryRow>> {
  return resolve(
    'couponCategories',
    x => Number(x.id),
    ids,
    () => db.select().from(couponCategory),
    missing => db.select().from(couponCategory).where(inArray(couponCategory.id, missing)),
  )
}

/**
 * Region 行政区划：静态字典（~3000 行，几乎不变）→ 整表缓存。
 * 运营极少新增行政区划，等 TTL 自然刷新即可。
 */
export function getRegionsOrdered(): Promise<RegionRow[]> {
  return cachedList('regions', () => db.select().from(region).orderBy(asc(region.regionCode)))
}

export function getRegionIndex(): Promise<RegionIndex> {
  return cachedList('regionIndex', async () => {
    const rows = await getRegionsOrdered() // 复用同一份缓存数据，不额外查 DB
    const byCode = new Map<string, RegionRow>()
    const byParent = new Map<string, RegionRow[]>()
    for (const r of rows) {
      byCode.set(r.regionCode, r)
      const pc = (r.parentCode || '').trim()
      if (pc) {
        const arr = byParent.get(pc) ?? []
        arr.push(r)
        byParent.set(pc, arr)
      }
    }
    return { byCode, byParent }
  })
}

/** 进程启动预热（server/plugins/warmup.ts） */
export async function warmup(): Promise<void> {
  const results = await Promise.allSettled([
    getCardOrganizations(),
    getMap('banks', () => db.select().from(bank), b => Number(b.id)),
    getMap('activityCategories', () => db.select().from(activityCategory), x => Number(x.id)),
    getMap('benefitCategories', () => db.select().from(benefitCategory), x => Number(x.id)),
    getMap('benefitPay', () => db.select().from(benefitPayPlatform), x => Number(x.id)),
    getMap('benefitUsage', () => db.select().from(benefitUsagePlatform), x => Number(x.id)),
    getMap('adminUsers', () => db.select().from(adminUser), x => Number(x.id)),
    getMap('couponCategories', () => db.select().from(couponCategory), x => Number(x.id)),
    getRegionIndex(), // 同时填充 'regions' 和 'regionIndex' 两个缓存键
  ])
  const failed = results.filter(r => r.status === 'rejected').length
  if (failed > 0) {
    console.warn(`[refcache] 预热部分失败 ${failed}/${results.length}，失败的表将在首次使用时 lazy 补`)
  }
  else {
    console.warn('[refcache] 字典缓存预热完成')
  }
}

/** 主动失效（admin 改字典后可调；不传 key 清全部） */
export function invalidateReferenceCache(key?: string): void {
  if (key)
    cache.delete(key)
  else cache.clear()
}
