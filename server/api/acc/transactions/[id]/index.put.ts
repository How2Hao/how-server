import { defineHandler, getRouterParam } from 'nitro/h3'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { updateTransaction } from '~/server/utils/services/acc.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const id = Number.parseInt(getRouterParam(event, 'id') ?? '', 10)
  const body = await readJson(event)
  return respond(async () => {
    if (Number.isNaN(id)) {
      throw new TypeError('记录不存在')
    }
    return updateTransaction(userId, id, {
      categoryId: body.categoryId as number | undefined,
      type: body.type as 'INCOME' | 'EXPENSE' | undefined,
      amount: body.amount as number | undefined,
      account: body.account as string | undefined,
      bankId: body.bankId as string | undefined,
      bankCardId: body.bankCardId as number | undefined,
      benefitPayPlatformId: body.benefitPayPlatformId as number | undefined,
      // 仅 body 显式携带 sourceTaskId 时才允许改写（含 null 清空）
      sourceTaskId: 'sourceTaskId' in body ? (body.sourceTaskId as number | null) : undefined,
      // 与旧 controller 一致：relatedIncomeId 键恒存在——body 缺省即清空该关联
      relatedIncomeId: body.relatedIncomeId as number | null | undefined,
      showInList: body.showInList as number | undefined,
      transactionDate: body.transactionDate as number | undefined,
      remark: body.remark as string | undefined,
      // 'accUserId' in body 语义：显式传 null 清空成员；缺省不动
      accUserId: 'accUserId' in body ? (body.accUserId != null ? Number.parseInt(String(body.accUserId), 10) : null) : undefined,
    })
  })
})
