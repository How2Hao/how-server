import type { RegionIndex } from '~/server/utils/services/reference-cache.ts'
// 地区服务：任务归属地选择器数据 + 反向地理编码候选名 → 权威 regionCode
// 移植自旧 how-api src/service/region.ts（DB 查询 → reference-cache 行政区划整表缓存 + 内存遍历）
import { getRegionIndex, getRegionsOrdered } from '~/server/utils/services/reference-cache.ts'

type RegionRow = RegionIndex['byCode'] extends Map<string, infer V> ? V : never

/**
 * 给每个候选名追加「去尾」形式：「北京市」→ 同时尝试匹配「北京」、「北京市」。
 * 保持原候选优先级在前。
 *
 * 末尾常见的行政区划后缀都会被剥一份。已有的精确等值匹配会优先命中含后缀那一条，
 * 失败再 fallback 到去尾形式（覆盖反向地理编码偶尔不带「市」后缀的 case）。
 */
export function expandCandidates(raw: string[]): string[] {
  const TRAILING_SUFFIX = /([市省盟州县区旗]|自治区|特别行政区|地区)$/
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of raw) {
    if (!seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
    const stripped = name.replace(TRAILING_SUFFIX, '')
    // 防御：去尾后还得 ≥ 2 字才参与匹配
    if (stripped !== name && stripped.length >= 2 && !seen.has(stripped)) {
      seen.add(stripped)
      out.push(stripped)
    }
  }
  return out
}

export interface RegionCityItem {
  cityCode: string
  cityName: string
  provinceCode: string
  provinceName: string
  regionType: string
  isPlanSingleCity: number
}

export interface RegionProvinceGroup {
  provinceCode: string
  provinceName: string
  regionType: string
  cities: RegionCityItem[]
}

export interface ResolveFromGeocodeBody {
  city?: string
  region?: string
  subregion?: string
  district?: string
  isoCountryCode?: string
}

export interface RegionMatchResult {
  regionCode: string
  regionName: string
  regionLevel: number
  regionType: string
}

// 热门城市只放地级市；直辖市（北京/上海/天津/重庆）从这里剔除 ——
// 它们在归属地选择面板的「省」列已直接出现，不必在热门里再露一次。
const HOT_CITY_NAMES = [
  '广州市',
  '深圳市',
  '杭州市',
  '南京市',
  '苏州市',
  '成都市',
  '武汉市',
  '西安市',
  '长沙市',
]

export async function getTaskRegionPickerData(): Promise<{
  nationwide: { code: string, name: string }
  hotCities: RegionCityItem[]
  provinceCities: RegionProvinceGroup[]
}> {
  const rows = await getRegionsOrdered()

  const nationwideRow = rows.find(r => r.regionCode === '100000')
  const provinces = rows.filter(r => Number(r.level) === 2 && r.regionCode !== '100000')
  const cities = rows.filter(r => Number(r.level) === 3)

  const provinceMap = new Map<string, RegionRow>()
  provinces.forEach(p => provinceMap.set(p.regionCode, p))

  const cityItems: RegionCityItem[] = cities
    .map((city) => {
      const province = provinceMap.get(city.parentCode || '')
      if (!province)
        return null
      return {
        cityCode: city.regionCode,
        cityName: city.regionName || '',
        provinceCode: province.regionCode,
        provinceName: province.regionName || '',
        regionType: city.regionType || 'NORMAL',
        isPlanSingleCity: Number(city.isPlanSingleCity || 0),
      }
    })
    .filter((item): item is RegionCityItem => item !== null)

  const hotSet = new Set(HOT_CITY_NAMES)
  const hotCities = cityItems
    .filter(item => hotSet.has(item.cityName))
    .sort((a, b) => HOT_CITY_NAMES.indexOf(a.cityName) - HOT_CITY_NAMES.indexOf(b.cityName))

  const provinceCities: RegionProvinceGroup[] = provinces
    .map(province => ({
      provinceCode: province.regionCode,
      provinceName: province.regionName || '',
      regionType: province.regionType || 'NORMAL',
      cities: cityItems
        .filter(city => city.provinceCode === province.regionCode)
        .sort((a, b) => a.cityCode.localeCompare(b.cityCode)),
    }))
    .filter(group => group.cities.length > 0)
    .sort((a, b) => a.provinceCode.localeCompare(b.provinceCode))

  return {
    nationwide: {
      code: nationwideRow?.regionCode || '100000',
      name: nationwideRow?.regionName || '全国',
    },
    hotCities,
    provinceCities,
  }
}

/**
 * 把客户端 expo-location 反向地理编码拿到的多个候选名（city/region/subregion/district）
 * 权威映射成 region 表里的 regionCode。
 *
 * 粒度策略（与 task_template.region_code 现存粒度对齐，避免破坏 EXACT 匹配）：
 * - 直接命中 level=2（直辖市 / 省份） → 直接返回
 * - 命中 level=3：
 *   - parent 是 DIRECT 直辖市 → 上滚到直辖市本身（避免 110108 海淀区落库导致活动 EXACT 不匹配）
 *   - parent 是普通省份 → 用 level=3 自身（如 330200 宁波，与 task-picker UI 用户能选到的粒度一致）
 * - 都没命中 → null
 *
 * 仅支持中国境内（isoCountryCode === 'CN' 或不传）；境外明确返回 null。
 */
export async function resolveFromGeocode(input: ResolveFromGeocodeBody): Promise<RegionMatchResult | null> {
  if (input.isoCountryCode && input.isoCountryCode.toUpperCase() !== 'CN') {
    return null
  }

  // 候选名按 city > region > subregion > district 优先级；
  // ⚠ 严格过滤：长度 < 2 的候选直接丢（防御性 —— 「市」/「区」这种 1 字模糊匹配会命中所有地级市/区，乱匹配）
  const rawCandidates = [input.city, input.region, input.subregion, input.district]
    .map(s => (s || '').trim())
    .filter(s => s.length >= 2)

  if (rawCandidates.length === 0)
    return null

  // 同时为每个候选生成「去尾」形式（「北京市」→「北京」，「浙江省」→「浙江」），
  // 让「北京」也能精确命中「北京市」，扩大命中机会但不放松到 1 字
  const candidates = expandCandidates(rawCandidates)

  const { byCode } = await getRegionIndex()
  const rows = Array.from(byCode.values()) // 保持 regionCode 升序（与旧库默认返回顺序一致）

  // 第 1 步：level=3 优先（更具体，地级市/区县）。先匹配粒度更细的，避免「宁波市+浙江省」误回省。
  const level3Hit = findRegionByName(candidates, 3, rows)
  if (level3Hit) {
    const parent = level3Hit.parentCode
      ? byCode.get(level3Hit.parentCode) ?? null
      : null

    // 直辖市的区 → 上滚到直辖市本身（避免 110108 海淀区落库导致 task_template EXACT 匹配 miss）
    if (parent && (parent.regionType || '').toUpperCase() === 'DIRECT') {
      return toMatchResult(parent)
    }
    // 普通省份的地级市 → 用 level=3 自身（如 330200 宁波，与 task-picker UI 用户能选到的粒度一致）
    return toMatchResult(level3Hit)
  }

  // 第 2 步：fallback 到 level=2（直辖市本身 / 省份本身）
  const level2Hit = findRegionByName(candidates, 2, rows)
  if (level2Hit) {
    return toMatchResult(level2Hit)
  }

  return null
}

/**
 * 在指定 level 里按候选名查 region：
 * 1) 优先精确等值（regionName === candidate，按候选优先级返回最先命中的那条）
 * 2) 然后模糊包含兜底（regionName 含 name 或 name 含 regionName，双向）
 * 候选名的相对顺序对应 city/region/subregion/district 的优先级；命中越早的越优先返回。
 */
function findRegionByName(candidates: string[], level: number, rows: RegionRow[]): RegionRow | null {
  if (candidates.length === 0)
    return null
  const atLevel = rows.filter(r => Number(r.level) === level)

  // 精确等值
  for (const name of candidates) {
    const hit = atLevel.find(r => r.regionName === name)
    if (hit)
      return hit
  }

  // 模糊包含兜底：精确等值没命中时，按候选优先级逐个尝试双向包含。
  // 1 字候选已经在 resolveFromGeocode 入口被挡，不会出现「'%市%' 命中所有地级市」这种乱匹配。
  for (const name of candidates) {
    const like = atLevel.find((r) => {
      const rn = r.regionName || ''
      return rn.includes(name) || name.includes(rn)
    })
    if (like)
      return like
  }

  return null
}

function toMatchResult(region: RegionRow): RegionMatchResult {
  return {
    regionCode: region.regionCode,
    regionName: region.regionName || '',
    regionLevel: Number(region.level),
    regionType: (region.regionType || 'NORMAL').toUpperCase(),
  }
}
