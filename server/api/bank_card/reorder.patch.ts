// PATCH /bank_card/reorder — 卡列表手动排序（body: { orderedIds: [] }）
import { defineHandler } from 'nitro'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { reorderBankCards } from '~/server/utils/services/bank-card.ts'

export default defineHandler(async (event) => {
  const { userId } = requireAuth(event)
  const body = await readJson<{ orderedIds?: unknown }>(event)
  const orderedIds = Array.isArray(body.orderedIds) ? (body.orderedIds as number[]) : []
  return respond(() => reorderBankCards(userId, orderedIds))
})
