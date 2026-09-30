// 优惠使用平台（移植自旧 src/service/benefit_usage_platform.ts）
// 注意：旧控制器直接返回本服务结果（无 {success,message,data} 包装），路由层原样返回
import { asc, eq } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { benefitUsagePlatform } from '~/server/database/schema/plaza.ts'

export type BenefitUsagePlatformRow = typeof benefitUsagePlatform.$inferSelect

export async function findAllUsagePlatforms(): Promise<BenefitUsagePlatformRow[]> {
  return db.select().from(benefitUsagePlatform).orderBy(asc(benefitUsagePlatform.sortOrder))
}

export async function findUsagePlatformById(id: number): Promise<BenefitUsagePlatformRow | null> {
  const [row] = await db.select().from(benefitUsagePlatform).where(eq(benefitUsagePlatform.id, id)).limit(1)
  return row ?? null
}
