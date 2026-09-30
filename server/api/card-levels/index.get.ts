import { defineHandler } from 'nitro'
import { respond } from '~/server/utils/response.ts'
import { getCardLevels } from '~/server/utils/services/card-level.ts'

/** 信用卡等级字典 */
export default defineHandler(async () => {
  return respond(() => getCardLevels())
})
