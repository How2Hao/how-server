// 银行优惠类目（移植自旧 src/service/benefit_category.ts）：类目 + 关联支付平台展开
import { asc, inArray } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { benefitCategory, benefitPayPlatform } from '~/server/database/schema/plaza.ts'

/** 从 "1,2,3" CSV 提取正整数平台 ID（旧系统 parseInt + 过滤语义） */
export function parsePlatformIds(csv: string | null | undefined): number[] {
  return (csv || '')
    .split(',')
    .map(s => Number.parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n) && n > 0)
}

type BenefitPayPlatformRow = typeof benefitPayPlatform.$inferSelect

export async function getAllBenefitCategories(): Promise<any[]> {
  const categories = await db.select().from(benefitCategory).orderBy(asc(benefitCategory.sortOrder))

  // 收集所有用到的平台 ID
  const allPlatformIds = Array.from(
    new Set(categories.flatMap(cat => parsePlatformIds(cat.benefitPlatformIds))),
  )

  // 批量查询平台数据
  const platforms = allPlatformIds.length
    ? await db.select().from(benefitPayPlatform).where(inArray(benefitPayPlatform.id, allPlatformIds))
    : []
  const platformMap = new Map<number, BenefitPayPlatformRow>(platforms.map(p => [p.id, p]))

  return categories.map((cat) => {
    const categoryPlatforms = parsePlatformIds(cat.benefitPlatformIds)
      .map(id => platformMap.get(id))
      .filter((p): p is BenefitPayPlatformRow => !!p)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(p => ({
        id: p.id,
        code: p.code,
        name: p.name,
        icon: p.icon ?? null,
        sortOrder: p.sortOrder,
      }))

    return {
      id: cat.id,
      name: cat.name,
      icon: cat.icon ?? null,
      sortOrder: cat.sortOrder,
      accCategoryId: cat.accCategoryId ?? null,
      platforms: categoryPlatforms,
    }
  })
}
