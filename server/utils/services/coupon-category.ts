// 卡券分类树（移植自旧 src/service/coupon_category.ts）：quanma51 来源，parent_id=0 为一级
import { and, asc, eq, gt, inArray, like } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { couponCategory } from '~/server/database/schema/plaza.ts'

export interface CouponCategoryDto {
  id: number
  parentId: number
  name: string
  sortOrder: number
  logoUrl: string | null
  skuQueryName: string | null
  isVisible: boolean
}

export interface CouponCategoryTreeNode extends CouponCategoryDto {
  children: CouponCategoryDto[]
}

type CouponCategoryRow = typeof couponCategory.$inferSelect

function toDto(row: CouponCategoryRow): CouponCategoryDto {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    sortOrder: row.sortOrder,
    logoUrl: row.logoUrl,
    skuQueryName: row.skuQueryName,
    isVisible: !!row.isVisible,
  }
}

/** 一次性返回完整树（一级 + 嵌套二级）；旧代码 includeHidden 两种取值行为一致，原样保留 */
export async function getCategoryTree(_includeHidden = false): Promise<CouponCategoryTreeNode[]> {
  const rows = await db.select().from(couponCategory).orderBy(asc(couponCategory.parentId), asc(couponCategory.sortOrder), asc(couponCategory.id))
  const firstLevels = rows.filter(r => r.parentId === 0)
  const children = rows.filter(r => r.parentId > 0)

  return firstLevels.map(fl => ({
    ...toDto(fl),
    children: children
      .filter(c => c.parentId === fl.id)
      .map(c => toDto(c)),
  }))
}

/** 按 name 模糊搜，给"活动关联"远程下拉用（仅二级品牌） */
export async function searchCouponCategories(keyword: string, limit = 30): Promise<CouponCategoryDto[]> {
  const k = (keyword || '').trim()
  if (!k)
    return []
  const rows = await db.select().from(couponCategory).where(and(
    gt(couponCategory.parentId, 0),
    like(couponCategory.name, `%${k}%`),
    eq(couponCategory.isVisible, 1),
  )).orderBy(asc(couponCategory.sortOrder), asc(couponCategory.id)).limit(limit)
  return rows.map(toDto)
}

/** 按 id 数组拉品牌（活动关联读取用），保持调用方传入的顺序 */
export async function findCouponCategoriesByIds(ids: number[]): Promise<CouponCategoryDto[]> {
  if (ids.length === 0)
    return []
  const rows = await db.select().from(couponCategory).where(inArray(couponCategory.id, ids))
  const map = new Map(rows.map(r => [r.id, r]))
  return ids
    .map(id => map.get(id))
    .filter((r): r is CouponCategoryRow => !!r)
    .map(toDto)
}

export async function findCouponCategoryById(id: number): Promise<CouponCategoryDto | null> {
  const [row] = await db.select().from(couponCategory).where(eq(couponCategory.id, id)).limit(1)
  return row ? toDto(row) : null
}

export async function createCouponCategory(input: {
  parentId: number
  name: string
  sortOrder?: number
  logoUrl?: string | null
  skuQueryName?: string | null
}): Promise<CouponCategoryDto> {
  if (!input.name?.trim())
    throw new Error('name 必填')
  if (input.parentId !== 0) {
    const [parent] = await db.select().from(couponCategory).where(and(eq(couponCategory.id, input.parentId), eq(couponCategory.parentId, 0))).limit(1)
    if (!parent)
      throw new Error('parentId 必须指向一级分类（parent_id=0 的行）')
  }
  const [exists] = await db.select().from(couponCategory).where(and(
    eq(couponCategory.source, 'quanma51'),
    eq(couponCategory.parentId, input.parentId),
    eq(couponCategory.name, input.name.trim()),
  )).limit(1)
  if (exists)
    throw new Error('同 parent 下已存在同名分类')

  const values = {
    source: 'quanma51' as const,
    parentId: input.parentId,
    name: input.name.trim(),
    sortOrder: input.sortOrder ?? 0,
    logoUrl: input.logoUrl ?? null,
    logoOriginUrl: null,
    // 二级品牌行 skuQueryName 默认 = name（POST quanma51 in/infos 反查用）
    skuQueryName: input.skuQueryName ?? (input.parentId > 0 ? input.name.trim() : null),
    isVisible: 1,
    createdAt: Date.now(),
    updatedAt: new Date(),
  }
  const [inserted] = await db.insert(couponCategory).values(values).$returningId()
  const [row] = await db.select().from(couponCategory).where(eq(couponCategory.id, Number(inserted.id))).limit(1)
  return toDto(row)
}

export async function updateCouponCategory(
  id: number,
  patch: { name?: string, sortOrder?: number, isVisible?: boolean, logoUrl?: string | null },
): Promise<CouponCategoryDto> {
  const [row] = await db.select().from(couponCategory).where(eq(couponCategory.id, id)).limit(1)
  if (!row)
    throw new Error('分类不存在')

  const patchValues: Partial<typeof couponCategory.$inferInsert> = { updatedAt: new Date() }
  if (patch.name !== undefined)
    patchValues.name = patch.name.trim()
  if (patch.sortOrder !== undefined)
    patchValues.sortOrder = patch.sortOrder
  if (patch.isVisible !== undefined)
    patchValues.isVisible = patch.isVisible ? 1 : 0
  if (patch.logoUrl !== undefined)
    patchValues.logoUrl = patch.logoUrl

  await db.update(couponCategory).set(patchValues).where(eq(couponCategory.id, id))
  const [saved] = await db.select().from(couponCategory).where(eq(couponCategory.id, id)).limit(1)
  return toDto(saved)
}
