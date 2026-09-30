// GET /bank_card_template — 卡模板列表（?bankId= 可选）
import { defineHandler } from 'nitro'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { getBankCardTemplates } from '~/server/utils/services/bank-card-template.ts'

export default defineHandler(async (event) => {
  const bankId = query(event).get('bankId') || undefined
  return respond(() => getBankCardTemplates(bankId))
})
