// GET /bank_card_template/credit-cards/paged — 信用卡模板按银行分页（bankId 必填）
import { defineHandler } from 'nitro'
import { query } from '~/server/utils/request.ts'
import { fail, respond } from '~/server/utils/response.ts'
import { getCreditCardTemplatesByBankPaged } from '~/server/utils/services/bank-card-template.ts'

export default defineHandler(async (event) => {
  const q = query(event)
  const safeBankId = (q.get('bankId') || '').trim()
  if (!safeBankId) {
    return fail('bankId is required')
  }

  const p = Number.parseInt(q.get('page') || '1', 10) || 1
  const ps = Number.parseInt(q.get('pageSize') || '30', 10) || 30
  return respond(() => getCreditCardTemplatesByBankPaged(
    safeBankId,
    p,
    ps,
    q.get('dataSource') || 'flyert',
  ))
})
