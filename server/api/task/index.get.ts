import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { getTasks, getTasksByDate, getTasksByMonth, getTasksByMonthSummary } from '~/server/utils/services/task.ts'

// 三种模式：date=YYYY-MM-DD 单日列表；year+month 按月视图（summaryOnly 只返回摘要）；否则分页列表
export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const q = query(event)
  return respond(async () => {
    // 单日模式：YYYY-MM-DD
    const date = q.get('date') || ''
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return getTasksByDate(userId, date)
    }
    const yearNum = q.get('year') ? Number.parseInt(q.get('year') as string, 10) : Number.NaN
    const monthNum = q.get('month') ? Number.parseInt(q.get('month') as string, 10) : Number.NaN
    if (!Number.isNaN(yearNum) && !Number.isNaN(monthNum) && monthNum >= 1 && monthNum <= 12) {
      if (q.get('summaryOnly') === 'true') {
        // 摘要模式：只返回今天详情 + 其他日期总数，不返回其他日期详情
        return getTasksByMonthSummary(userId, yearNum, monthNum)
      }
      return getTasksByMonth(userId, yearNum, monthNum, { includePast: q.get('includePast') === 'true' })
    }
    const page = Number.parseInt(q.get('page') || '', 10) || 1
    const pageSize = Number.parseInt(q.get('pageSize') || '', 10) || 20
    return getTasks(userId, page, pageSize)
  })
})
