import type { RawCoupon } from './coupon-parse-core.ts'
// 优惠券截图识别（移植自旧 src/service/coupon_parse.ts）：千问视觉模型 + 银行名称补全
// 纯逻辑（提示词 / JSON 解析 / 到期时间解析）在 ./coupon-parse-core.ts
import { like, or, sql } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { bank } from '~/server/database/schema/plaza.ts'
import { config } from '~/server/utils/config.ts'
import { COUPON_PROMPT, extractVisionAssistantText, parseCouponJson, parseExpiryTs } from './coupon-parse-core.ts'

export interface CouponEntry {
  /** 支付平台 ID：1=支付宝, 2=微信支付 */
  platform: 1 | 2
  /** 银行 ID（匹配到时非 null） */
  bankId: number | null
  /** 银行名称（原始识别，未匹配也保留） */
  bankName: string
  /** 银行 Logo URL */
  bankLogo: string | null
  /** 立减/优惠面额（元），如 10、20.5 */
  amount: number | null
  /** 满减门槛描述，如 "满200可用" */
  condition: string
  /** 到期时间（毫秒时间戳），无法识别时为 null */
  expiryTs: number | null
  /** 原始到期日期字符串 */
  expiryRaw: string
}

/** DashScope OpenAI 兼容多模态接口（旧系统固定用 qwen provider） */
async function callQwenVisionRemote(input: { dataUrl: string, prompt: string }): Promise<string> {
  const apiKey = config.bankCardVision.dashscopeApiKey.trim()
  if (!apiKey) {
    throw new Error('千问需配置 DASHSCOPE_API_KEY（或 bankCardVision.dashscopeApiKey）')
  }
  const host = config.bankCardVision.dashscopeHost.trim() || 'dashscope.aliyuncs.com'
  const model = config.bankCardVision.qwenVisionModel.trim() || 'qwen-vl-plus'
  const body = JSON.stringify({
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: input.dataUrl } },
        { type: 'text', text: input.prompt },
      ],
    }],
  })

  const res = await fetch(`https://${host}/compatible-mode/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`DashScope ${host} HTTP ${res.status}: ${text}`)
  }
  return text
}

async function findBankByName(name: string): Promise<{ id: number, logo: string | null } | null> {
  const kw = `%${name}%`
  const [row] = await db.select({ id: bank.id, logo: bank.logo })
    .from(bank)
    .where(or(like(bank.name, kw), like(bank.shortName, kw)))
    // 名字最短的优先（"建行" 短于 "建设银行信用卡中心"），与旧系统 ORDER BY LENGTH(name) 一致
    .orderBy(sql`LENGTH(${bank.name}) ASC`)
    .limit(1)
  return row ?? null
}

async function enrichWithBankIds(raws: RawCoupon[]): Promise<CouponEntry[]> {
  const results: CouponEntry[] = []
  for (const raw of raws) {
    const bankName = (raw.bankName ?? '').trim()
    let bankId: number | null = null
    let bankLogo: string | null = null

    if (bankName) {
      const found = await findBankByName(bankName)
      if (found) {
        bankId = found.id
        bankLogo = found.logo ?? null
      }
    }

    const amount = raw.amount != null ? Number(raw.amount) : null
    const expiryRaw = (raw.expiryDate ?? '').trim()
    const expiryTs = expiryRaw ? parseExpiryTs(expiryRaw) : null

    const rawPlatform = Number(raw.platform)
    const platform: 1 | 2 = rawPlatform === 1 ? 1 : 2

    // 支付宝卡券反查不到银行则丢弃（避免无法归属的噪声）
    if (platform === 1 && bankId === null)
      continue

    results.push({
      platform,
      bankId,
      bankName,
      bankLogo,
      amount: Number.isFinite(amount) ? amount : null,
      condition: (raw.condition ?? '').trim(),
      expiryTs,
      expiryRaw,
    })
  }
  return results
}

export async function parseFromBase64(imageBase64: string, mimeType = 'image/jpeg'): Promise<CouponEntry[]> {
  const trimmed = (imageBase64 ?? '').trim()
  const b64 = trimmed.startsWith('data:') ? trimmed.replace(/^data:[^;]+;base64,/, '') : trimmed
  const dataMime = /^image\//i.test(mimeType) ? mimeType : 'image/jpeg'
  const dataUrl = `data:${dataMime};base64,${b64}`

  const raw = await callQwenVisionRemote({ dataUrl, prompt: COUPON_PROMPT })

  const text = extractVisionAssistantText(raw)
  const rawCoupons = parseCouponJson(text)
  return enrichWithBankIds(rawCoupons)
}
