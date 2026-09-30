// GET /bank_card_template/credit-cards — 信用卡模板检索（bankId?/keyword?/dataSource?）
import { defineHandler } from 'nitro'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { getCreditCardTemplates } from '~/server/utils/services/bank-card-template.ts'

export default defineHandler(async (event) => {
  const q = query(event)
  return respond(() => getCreditCardTemplates(
    q.get('bankId') || undefined,
    q.get('keyword') || undefined,
    q.get('dataSource') || undefined,
  ))
})
