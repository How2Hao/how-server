// GET /bank_card/recognize-batch — 批量识别银行卡（联调：读 server/assets/all.png）
// **?model=** qwen（默认）| glm/zhipu | gemini/google
import { Buffer } from 'node:buffer'
import { defineHandler } from 'nitro'
import { useStorage } from 'nitro/storage'
import { requireAuth } from '~/server/utils/auth-guard.ts'
import { query } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { parseVisionProviderFromQuery } from '~/server/utils/services/bank-card-vision-providers.ts'
import { recognizeFromImageBase64 } from '~/server/utils/services/bank-card-vision.ts'

export default defineHandler(async (event) => {
  requireAuth(event)
  const model = query(event).get('model') || undefined

  return respond(async () => {
    // 服务端资产：nitro 会把 server/assets 打进 assets:server 挂载点
    const buf = await useStorage('assets:server').getItemRaw('all.png')
    if (!buf) {
      throw new Error('图片资源缺失')
    }
    const base64 = Buffer.from(buf).toString('base64')
    const provider = parseVisionProviderFromQuery(model)
    const list = await recognizeFromImageBase64(base64, 'image/jpeg', provider)
    // eslint-disable-next-line no-console
    console.info('[bank_card recognize-batch] 识别结果:', JSON.stringify(list, null, 2))
    return list
  })
})
