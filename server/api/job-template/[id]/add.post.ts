import { defineHandler } from 'nitro'
import { getAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { fail, respond } from '~/server/utils/response.ts'
import { addJobFromTemplate } from '~/server/utils/services/job-template.ts'

// 从模板一键添加：body { date? }（选中日期，缺省当前时刻）
// 注意：/repayment/** 与 /job/** 是静态前缀段，rou3 中静态段优先于本 [id] 动态段，不会冲突
export default defineHandler(async (event) => {
  const authUser = getAuth(event)
  if (!authUser)
    return fail('未登录')
  const id = Number.parseInt(event.context.params?.id ?? '', 10)
  const body = await readJson(event)
  return respond(() => addJobFromTemplate(authUser.userId, id, body.date != null ? Number(body.date) : undefined))
})
