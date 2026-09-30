// GET /bank/hot — 热门银行（规则匹配 code/name）
import { defineHandler } from 'nitro'
import { respond } from '~/server/utils/response.ts'
import { getHotBanks, serializeBank } from '~/server/utils/services/bank.ts'

export default defineHandler(async () => {
  return respond(async () => {
    const banks = await getHotBanks()
    return banks.map(serializeBank)
  })
})
