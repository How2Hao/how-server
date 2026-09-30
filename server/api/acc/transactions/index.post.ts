import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { createTransaction } from '~/server/utils/services/acc.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const body = await readJson(event)
  return respond(() => createTransaction(userId, {
    ledgerId: body.ledgerId as number,
    categoryId: body.categoryId as number,
    type: body.type as 'INCOME' | 'EXPENSE',
    amount: body.amount as number,
    account: body.account as string | undefined,
    bankId: body.bankId as string | undefined,
    bankCardId: body.bankCardId as number | undefined,
    benefitPayPlatformId: body.benefitPayPlatformId as number | undefined,
    sourceTaskId: body.sourceTaskId as number | undefined,
    relatedIncomeId: body.relatedIncomeId as number | undefined,
    showInList: body.showInList as number | undefined,
    transactionDate: body.transactionDate as number | undefined,
    remark: body.remark as string | undefined,
    accUserId: body.accUserId != null ? Number.parseInt(String(body.accUserId), 10) : undefined,
  }))
})
