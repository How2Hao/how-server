// GET /bank_card_template/credit-cards/hot — 热门信用卡模板（related_count 前十）
import { defineHandler } from 'nitro'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { getHotCreditCardTemplates } from '~/server/utils/services/bank-card-template.ts'

export default defineHandler(async (event) => {
  const dataSource = query(event).get('dataSource') || 'flyert'
  return respond(() => getHotCreditCardTemplates(dataSource))
})
