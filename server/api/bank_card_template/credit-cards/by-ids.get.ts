// GET /bank_card_template/credit-cards/by-ids — 按 id 列表取信用卡模板（?ids= CSV，保持传入顺序）
import { defineHandler } from 'nitro'
import { query } from '~/server/utils/request.ts'
import { ok, respond } from '~/server/utils/response.ts'
import { getCreditCardTemplatesByIds } from '~/server/utils/services/bank-card-template.ts'

export default defineHandler(async (event) => {
  const q = query(event)
  const parsedIds = (q.get('ids') || '')
    .split(',')
    .map(item => Number.parseInt(item.trim(), 10))
    .filter(id => Number.isFinite(id) && id > 0)

  if (parsedIds.length === 0) {
    return ok([])
  }

  return respond(() => getCreditCardTemplatesByIds(parsedIds, q.get('dataSource') || undefined))
})
