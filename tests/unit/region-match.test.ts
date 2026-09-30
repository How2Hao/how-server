import type { RegionRowLike } from '~/server/utils/services/task-template.ts'
// 纯函数单测：地区匹配策略（ADR-003）/ 地区展示文案 / 地理编码候选名去尾展开（不触 DB）
import { describe, expect, it } from 'vitest'
import { expandCandidates } from '~/server/utils/services/region.ts'
import { buildRegionDisplayText, isRegionMatched } from '~/server/utils/services/task-template.ts'

function region(code: string, over: Partial<RegionRowLike> = {}): RegionRowLike {
  return {
    regionName: null,
    parentCode: null,
    level: null,
    isPlanSingleCity: 0,
    regionCode: code,
    ...over,
  }
}

/** 手造最小行政区划：广东（含计划单列市深圳）、江苏、北京（直辖市） */
const regionMap = new Map<string, RegionRowLike>([
  ['440000', region('440000', { regionName: '广东省', level: 2 })],
  ['440100', region('440100', { regionName: '广州市', parentCode: '440000', level: 3 })],
  ['440300', region('440300', { regionName: '深圳市', parentCode: '440000', level: 3, isPlanSingleCity: 1 })],
  ['320000', region('320000', { regionName: '江苏省', level: 2 })],
  ['320100', region('320100', { regionName: '南京市', parentCode: '320000', level: 3 })],
  ['110000', region('110000', { regionName: '北京市', level: 2 })],
  ['110108', region('110108', { regionName: '海淀区', parentCode: '110000', level: 3 })],
])

describe('isRegionMatched（地区匹配策略）', () => {
  it('模板为全国（100000）或空 → 任意卡都匹配', () => {
    expect(isRegionMatched('100000', 'EXACT', '320100', regionMap)).toBe(true)
    expect(isRegionMatched('', 'EXACT', '320100', regionMap)).toBe(true)
  })

  it('卡无地区 → 仅非全国模板不匹配', () => {
    expect(isRegionMatched('440100', 'EXACT', '', regionMap)).toBe(false)
    expect(isRegionMatched('100000', 'EXACT', '', regionMap)).toBe(true)
  })

  it('eXACT：regionCode 全等', () => {
    expect(isRegionMatched('440100', 'EXACT', '440100', regionMap)).toBe(true)
    expect(isRegionMatched('440100', 'EXACT', '440300', regionMap)).toBe(false)
  })

  it('iNCLUDE_ALL：同省即匹配，跨省不匹配', () => {
    expect(isRegionMatched('440000', 'INCLUDE_ALL', '440300', regionMap)).toBe(true)
    expect(isRegionMatched('440100', 'INCLUDE_ALL', '440300', regionMap)).toBe(true)
    expect(isRegionMatched('440000', 'INCLUDE_ALL', '320100', regionMap)).toBe(false)
  })

  it('eXCLUDE_PLAN_SINGLE_CITY：排除计划单列市，普通城市放行', () => {
    expect(isRegionMatched('440000', 'EXCLUDE_PLAN_SINGLE_CITY', '440300', regionMap)).toBe(false)
    expect(isRegionMatched('440000', 'EXCLUDE_PLAN_SINGLE_CITY', '440100', regionMap)).toBe(true)
  })

  it('eXCLUDE_PLAN_SINGLE_CITY：非三级卡（省本身）从宽放行；未知卡地区因省份无法解析而不匹配', () => {
    expect(isRegionMatched('440000', 'EXCLUDE_PLAN_SINGLE_CITY', '440000', regionMap)).toBe(true)
    expect(isRegionMatched('440000', 'EXCLUDE_PLAN_SINGLE_CITY', '999999', regionMap)).toBe(false)
  })

  it('未知策略按 EXACT 兜底', () => {
    expect(isRegionMatched('440100', 'WHATEVER', '440100', regionMap)).toBe(true)
    expect(isRegionMatched('440100', 'WHATEVER', '440300', regionMap)).toBe(false)
  })
})

describe('buildRegionDisplayText（地区展示文案）', () => {
  it('全国 / 空 → 空串', () => {
    expect(buildRegionDisplayText('100000', 'EXACT', regionMap, new Map())).toBe('')
    expect(buildRegionDisplayText('', 'EXACT', regionMap, new Map())).toBe('')
  })

  it('未知地区 → 「区域活动」', () => {
    expect(buildRegionDisplayText('999999', 'EXACT', regionMap, new Map())).toBe('区域活动')
  })

  it('省份 + EXCLUDE 策略 → 「XX除A、B外」', () => {
    const planSingle = new Map([['440000', ['深圳市']]])
    expect(buildRegionDisplayText('440000', 'EXCLUDE_PLAN_SINGLE_CITY', regionMap, planSingle)).toBe('广东省除深圳市外')
  })

  it('省份 + EXCLUDE 策略但无排除名单 → 只回省名；普通城市直接回城市名', () => {
    expect(buildRegionDisplayText('440000', 'EXCLUDE_PLAN_SINGLE_CITY', regionMap, new Map())).toBe('广东省')
    expect(buildRegionDisplayText('440100', 'EXACT', regionMap, new Map())).toBe('广州市')
  })
})

describe('expandCandidates（地理编码候选名去尾）', () => {
  it('追加去尾形式并保持原候选优先', () => {
    expect(expandCandidates(['北京市'])).toEqual(['北京市', '北京'])
    expect(expandCandidates(['浙江省'])).toEqual(['浙江省', '浙江'])
    expect(expandCandidates(['内蒙古自治区'])).toEqual(['内蒙古自治区', '内蒙古'])
  })

  it('原候选里已有去尾形式时不重复', () => {
    expect(expandCandidates(['北京市', '北京'])).toEqual(['北京市', '北京'])
  })

  it('去尾后不足 2 字的候选不参与', () => {
    expect(expandCandidates(['沙县'])).toEqual(['沙县'])
  })

  it('多候选依序展开', () => {
    expect(expandCandidates(['宁波市', '浙江省'])).toEqual(['宁波市', '宁波', '浙江省', '浙江'])
  })
})
