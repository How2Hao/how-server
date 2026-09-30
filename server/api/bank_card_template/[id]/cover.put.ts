// PUT /bank_card_template/:id/cover — 设置模板封面并同步到 cover 为 NULL 的用户卡（body: { cover }）
import { defineHandler } from 'nitro'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { setCover } from '~/server/utils/services/bank-card-template.ts'

export default defineHandler(async (event) => {
  const id = event.context.params?.id ?? ''
  const body = await readJson<{ cover?: unknown }>(event)
  return respond(async () => {
    const templateId = Number.parseInt(id, 10)
    const cover = typeof body.cover === 'string' ? body.cover.trim() : ''
    if (!Number.isFinite(templateId) || !cover) {
      throw new Error('id 或 cover 参数无效')
    }
    return setCover(templateId, cover)
  })
})
