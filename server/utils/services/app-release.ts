// App 版本发布（移植自旧 src/service/app_release.ts）：列表 / 最新版 / 版本文章
import { desc, eq, sql } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { appRelease } from '~/server/database/schema/plaza.ts'
import { config } from '~/server/utils/config.ts'

export interface AppReleaseDto {
  id: number
  version: string
  changelog: string
  androidUrl: string | null
  iosUrl: string | null
  isMandatory: boolean
  publishedAt: number
  hasArticle: boolean
}

export interface VersionArticleDto {
  id: number
  version: string
  articleTitle: string | null
  article: string
}

type AppReleaseRow = typeof appRelease.$inferSelect

function toDto(entity: AppReleaseRow): AppReleaseDto {
  return {
    id: entity.id,
    version: entity.version,
    changelog: entity.changelog,
    androidUrl: entity.androidUrl,
    iosUrl: entity.iosUrl,
    isMandatory: entity.isMandatory === 1,
    publishedAt: Number(entity.publishedAt),
    hasArticle: !!entity.article,
  }
}

function toDtoFromRaw(row: Record<string, unknown>): AppReleaseDto {
  return {
    id: Number(row.id),
    version: String(row.version ?? ''),
    changelog: String(row.changelog ?? ''),
    androidUrl: (row.android_url as string | null) ?? null,
    iosUrl: (row.ios_url as string | null) ?? null,
    isMandatory: row.is_mandatory === 1,
    publishedAt: Number(row.published_at),
    hasArticle: !!row.article,
  }
}

export async function listAppReleases(): Promise<AppReleaseDto[]> {
  // 排序按 id DESC：自增主键单调递增，admin 按时间顺序插入新版本即天然排好。
  // 版本号字符串大小由客户端解析比较（见 how-app/version.ts compareVersion）
  // 草稿在 how-admin 的 app_release_draft 表里，不进本表，故本表行均已发布，无需过滤。
  const rows = await db.select().from(appRelease).orderBy(desc(appRelease.id))
  return rows.map(toDto)
}

export async function getLatestAppRelease(): Promise<AppReleaseDto | null> {
  // 非生产环境优先读草稿表（how-admin 维护，本服务无 drizzle 实体 → 原生 SQL），
  // 方便在发布前预览升级弹窗效果；表不存在时与旧系统一样向上抛错。
  if (config.nodeEnv() !== 'production') {
    const result = await db.execute(sql`SELECT * FROM app_release_draft ORDER BY id DESC LIMIT 1`)
    const rows = (result[0] ?? []) as unknown as Record<string, unknown>[]
    if (rows.length > 0)
      return toDtoFromRaw(rows[0])
  }
  const [item] = await db.select().from(appRelease).orderBy(desc(appRelease.id)).limit(1)
  return item ? toDto(item) : null
}

/** 版本文章详情：不存在/无文章返回 null */
export async function getReleaseArticleById(id: number): Promise<VersionArticleDto | null> {
  if (!Number.isFinite(id) || id <= 0)
    return null
  const [item] = await db.select().from(appRelease).where(eq(appRelease.id, id)).limit(1)
  if (!item || !item.article)
    return null
  return {
    id: item.id,
    version: item.version,
    articleTitle: item.articleTitle ?? null,
    article: item.article,
  }
}
