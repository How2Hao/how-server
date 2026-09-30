// 活动分类（移植自旧 src/service/activity_category.ts）：两级分类，公开读写接口
import { asc, eq } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { activityCategory } from '~/server/database/schema/plaza.ts'

export interface ActivityCategoryDto {
  id: number
  code: string
  name: string
  parentId: number | null
  icon: string | null
  sortOrder: number
  children?: ActivityCategoryDto[]
}

type ActivityCategoryRow = typeof activityCategory.$inferSelect

/** 写接口接受的字段（与旧实体字段一致） */
export interface ActivityCategoryUpsertData {
  code?: string
  name?: string
  parentId?: number | null
  icon?: string | null
  sortOrder?: number
}

function toDto(entity: ActivityCategoryRow): ActivityCategoryDto {
  return {
    id: entity.id,
    code: entity.code,
    name: entity.name,
    parentId: entity.parentId,
    icon: entity.icon,
    sortOrder: entity.sortOrder,
  }
}

/** 纯函数：扁平 DTO 列表 → 树（parentId 为 null 的为根，父节点缺失的丢弃） */
export function buildActivityCategoryTree(items: ActivityCategoryDto[]): ActivityCategoryDto[] {
  const map = new Map<number, ActivityCategoryDto>()
  const roots: ActivityCategoryDto[] = []

  items.forEach((item) => {
    map.set(item.id, { ...item, children: [] })
  })

  items.forEach((item) => {
    const node = map.get(item.id)!
    if (item.parentId === null) {
      roots.push(node)
    }
    else {
      const parent = map.get(item.parentId)
      if (parent) {
        parent.children!.push(node)
      }
    }
  })

  return roots
}

export async function getAllActivityCategories(): Promise<ActivityCategoryDto[]> {
  const rows = await db.select().from(activityCategory).orderBy(asc(activityCategory.sortOrder), asc(activityCategory.id))
  return rows.map(toDto)
}

export async function getActivityCategoryTree(): Promise<ActivityCategoryDto[]> {
  const dtoList = await getAllActivityCategories()
  return buildActivityCategoryTree(dtoList)
}

export async function getActivityCategoryById(id: number): Promise<ActivityCategoryDto | null> {
  const [item] = await db.select().from(activityCategory).where(eq(activityCategory.id, id)).limit(1)
  return item ? toDto(item) : null
}

export async function createActivityCategory(data: ActivityCategoryUpsertData): Promise<ActivityCategoryDto> {
  // 缺少必填的 code/name 时由 DB 报错（与旧系统 TypeORM 行为一致），类型上强制断言
  const values = { ...data, createdAt: Date.now() } as typeof activityCategory.$inferInsert
  const [inserted] = await db.insert(activityCategory).values(values).$returningId()
  const created = await getActivityCategoryById(Number(inserted.id))
  if (!created)
    throw new Error('创建失败')
  return created
}

export async function updateActivityCategory(id: number, data: ActivityCategoryUpsertData): Promise<ActivityCategoryDto | null> {
  await db.update(activityCategory).set({ ...data }).where(eq(activityCategory.id, id))
  return getActivityCategoryById(id)
}

export async function deleteActivityCategory(id: number): Promise<boolean> {
  const result = await db.delete(activityCategory).where(eq(activityCategory.id, id))
  return result[0].affectedRows > 0
}
