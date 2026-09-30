import type { TaskTemplateFilterParams } from '~/server/utils/services/task-template.ts'
// GET /task-template：活动广场列表（可选登录；登录后用于 canAddOnly 等个性化筛选）
import { defineHandler } from 'nitro'
import { getAuth } from '~/server/utils/auth-guard.ts'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { getTaskTemplates } from '~/server/utils/services/task-template.ts'

/**
 * 接受三种形态（与旧 controller parseListParam 一致）：
 *   1. ?bankIds=1,2,3       → CSV 拆分
 *   2. ?bankIds=1&bankIds=2 → 重复参数 getAll
 *   3. 不传                  → undefined
 */
function parseListParam(searchParams: URLSearchParams, name: string): string[] | undefined {
  const raw = searchParams.getAll(name)
  if (raw.length === 0)
    return undefined
  const out: string[] = []
  for (const v of raw) {
    String(v)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .forEach(s => out.push(s))
  }
  return out.length > 0 ? out : undefined
}

function parseNumberList(raw: string[] | undefined): number[] | undefined {
  const list = raw?.map(v => Number(v)).filter(v => Number.isFinite(v) && v > 0)
  return list && list.length > 0 ? list : undefined
}

export default defineHandler(async (event) => {
  const q = query(event)
  const authUser = getAuth(event)
  const params: TaskTemplateFilterParams = {
    userId: authUser?.userId,
    keyword: q.get('keyword') ?? undefined,
    quickFilter: q.get('quickFilter') ?? undefined,
    canAddOnly: q.get('canAddOnly') === '1' || q.get('canAddOnly') === 'true',
    officialOnly: q.get('officialOnly') === '1' || q.get('officialOnly') === 'true',
    sortBy: q.get('sortBy') ?? undefined,
    bankId: q.get('bankId') ?? undefined,
    bankIds: parseListParam(q, 'bankIds'),
    cardType: q.get('cardType') ?? undefined,
    cardOrganization: q.get('cardOrganization') ?? undefined,
    cardOrganizations: parseListParam(q, 'cardOrganizations'),
    regionCode: q.get('regionCode') ?? undefined,
    regionCodes: parseListParam(q, 'regionCodes'),
    benefitCategoryId: q.get('benefitCategoryId') ? Number(q.get('benefitCategoryId')) : undefined,
    benefitCategoryIds: parseNumberList(parseListParam(q, 'benefitCategoryIds')),
    activityCategoryId: q.get('activityCategoryId') ? Number(q.get('activityCategoryId')) : undefined,
    activityCategoryIds: parseNumberList(parseListParam(q, 'activityCategoryIds')),
    customTabCode: q.get('customTabCode')?.trim() || undefined,
  }
  return respond(() => getTaskTemplates(params))
})
