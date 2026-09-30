// GET /bank_card — 我的银行卡列表（手动排序优先，其余按创建时间倒序）
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { respond } from '~/server/utils/response.ts'
import { getBankCards } from '~/server/utils/services/bank-card.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  return respond(() => getBankCards(userId))
})
