import type { SQL } from 'drizzle-orm'
// 广场自定义 Tab（移植自旧 src/service/plaza_custom_tab.ts）
// 本地调试（NODE_ENV=local）无视 is_visible 与起止时间窗口，方便调试未上架/未到期/已过期的
// 自定义 tab；生产正常过滤。与 task_template 的 VISIBILITY_WHERE 同思路。
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { plazaCustomTab } from '~/server/database/schema/plaza.ts'
import { config } from '~/server/utils/config.ts'

export interface PlazaCustomTabVo {
  code: string
  name: string
  logo: string | null
}

function visibilityConditions(): SQL[] {
  if (config.isLocal())
    return []
  const now = Date.now()
  return [
    eq(plazaCustomTab.isVisible, 1),
    sql`(${plazaCustomTab.startTime} IS NULL OR ${plazaCustomTab.startTime} <= ${now})`,
    sql`(${plazaCustomTab.endTime} IS NULL OR ${plazaCustomTab.endTime} > ${now})`,
  ]
}

export async function getVisibleCustomTabs(): Promise<PlazaCustomTabVo[]> {
  const conditions = visibilityConditions()
  const rows = await db.select().from(plazaCustomTab).where(conditions.length > 0 ? and(...conditions) : undefined).orderBy(asc(plazaCustomTab.sortOrder), asc(plazaCustomTab.id))
  return rows.map(r => ({ code: r.code, name: r.name, logo: r.logo }))
}

/** 按 code 找可见 tab 的模板 ID 列表（广场 tab 详情页用） */
export async function getTemplateIdsByTabCode(code: string): Promise<number[] | null> {
  const [row] = await db.select().from(plazaCustomTab).where(and(eq(plazaCustomTab.code, code), ...visibilityConditions())).limit(1)
  return row ? row.templateIds : null
}
