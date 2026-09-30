// GET /bank — 银行列表：page/pageSize 传参时分页（1–50），否则全量
import { defineHandler } from 'nitro'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { getBanks, getBanksPaged, serializeBank } from '~/server/utils/services/bank.ts'

export default defineHandler(async (event) => {
  const q = query(event)
  const keyword = q.get('keyword') || ''
  const page = q.get('page') || ''
  const pageSize = q.get('pageSize') || ''
  const bankType = q.get('bankType') || ''

  return respond(async () => {
    if (page || pageSize) {
      const p = Math.max(1, Number(page) || 1)
      const ps = Math.min(50, Math.max(1, Number(pageSize) || 10))
      const result = await getBanksPaged(keyword, p, ps)
      return {
        items: result.items.map(serializeBank),
        total: result.total,
        page: p,
        pageSize: ps,
      }
    }
    const banks = await getBanks(bankType)
    return banks.map(serializeBank)
  })
})
