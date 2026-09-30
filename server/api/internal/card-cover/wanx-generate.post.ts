import type { ICardCoverQwenGenerateBody } from '~/server/utils/types.ts'
import { defineHandler } from 'nitro'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { generateWanxCardCover } from '~/server/utils/services/card-cover-wanx.ts'

/** PUBLIC quirk：旧 /internal/card-cover 接口无鉴权，保持原样 */
export default defineHandler(async (event) => {
  const body = await readJson<ICardCoverQwenGenerateBody>(event)
  return respond(() => generateWanxCardCover(body as ICardCoverQwenGenerateBody))
})
