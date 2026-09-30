// GET /bank_card_template/credit-cards/bank-groups — 信用卡模板按银行分组
import { defineHandler } from 'nitro'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { getCreditCardTemplateBankGroups } from '~/server/utils/services/bank-card-template.ts'

export default defineHandler(async (event) => {
  const dataSource = query(event).get('dataSource') || 'flyert'
  return respond(() => getCreditCardTemplateBankGroups(dataSource))
})
