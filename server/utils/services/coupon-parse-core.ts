// 优惠券 OCR 纯逻辑（无 DB / 无网络，可单测）：提示词 / 模型输出解析 / 到期时间解析
// 移植自旧 src/service/coupon_parse.ts 的纯函数部分

export interface RawCoupon {
  bankName?: string
  amount?: string | number
  condition?: string
  expiryDate?: string
  platform?: string | number
}

export const COUPON_PROMPT = `你是一个专门分析银行优惠券截图的助手。

## 任务
分析图片，提取其中所有符合条件的银行优惠券，以JSON数组返回。

## 平台识别（非常重要，必须仔细观察）
- **微信支付（platform=2）**：界面以绿色为主色调，卡券卡片背景通常是白色/浅色，有"微信支付"或"卡包"字样，卡券标题区域有"X元立减金"或"满X元减X元"的文字，右侧有"使用"按钮
- **支付宝（platform=1）**：界面以蓝色为主色调，有"支付宝"或"我的卡券"字样，卡券按银行聚合分组展示
- **判断优先级**：先看界面整体颜色主题（绿色→微信，蓝色→支付宝），再看文字标识
- **默认规则**：如果无法判断，且卡券卡片为独立平铺（每张卡独立一行），倾向于微信支付(2)

## 必须过滤掉的类型（不要提取）
1. **多笔立减优惠**：卡片上显示"多笔立减优惠"或"X笔 剩余可用"，这类是按次数叠加的优惠，不是单张优惠券，**必须跳过**
2. 商户优惠券（美团、京东、拼多多、外卖平台等非银行发行）
3. 交通卡、乘车码
4. 会员权益、积分兑换

## 必须提取的类型
- 银行立减金："X元立减金"、"满X减X"
- 银行代金券：有具体面额的单张优惠券
- 条件：卡片上必须有明确的银行名称

## 关键字段提取规则
- **amount**：优惠金额，如"10元立减金"→10，"满200减20"→20，无法确定→null
- **condition**：按以下优先级填写：
  ① 若有明确使用门槛（如"满200可用"、"满¥30.01可用"），完整照抄该文字
  ② 若无使用门槛，但卡片上有券类型名称（如"储蓄卡立减金"、"银行卡立减金"、"信用卡立减"等描述文字），照抄该文字
  ③ 以上都没有则填""
- **expiryDate**：**严格照抄**图片中到期时间/有效期位置的原始文字，一字不差，禁止转换格式、禁止推断、禁止补全。
  - **微信支付**：格式通常为"有效期至YYYY/MM/DD HH:MM"，在每张卡券卡片底部寻找，照抄完整原文（含"有效期至"前缀）。⚠️ 严禁将"X折""X.X折""立减X.X元"等优惠力度数字误读为日期，这类文字与日期无关。卡片主标题（"X元立减金"）也绝对不是日期。找不到日期填""
  - **支付宝**：在每张卡券条目中找"X月X日HH:MM过期"格式的文字。只提取到"过期"两字为止，"过期"后面紧跟的"规则 >"或其他链接文字**绝对不要包含**。例如图片显示"06月17日15:11过期 规则 >"，只照抄"06月17日15:11过期"。每张卡券各有自己的日期，按组折叠时只提取可见的卡券。无法找到则填""
  - 无论哪个平台，只要无法在卡片中明确找到日期文字，填""，不要猜测

## 输出格式（纯JSON数组，不要markdown代码块）
[
  {
    "bankName": "交通银行",
    "amount": 30,
    "condition": "满¥30.01可用",
    "expiryDate": "有效期至2026/06/23 23:59",
    "platform": 2
  },
  {
    "bankName": "邮政储蓄银行",
    "amount": 2,
    "condition": "储蓄卡立减金",
    "expiryDate": "06月17日15:11过期",
    "platform": 1
  }
]

字段说明：
- bankName: 银行名称（如"招商银行"、"建行"、"平安银行"等）
- amount: 优惠金额（纯数字，单位元）
- condition: 使用门槛（如"满¥30.01可用"）或券类型名称（如"储蓄卡立减金"）
- expiryDate: 到期时间原始字符串，含平台特有前缀/后缀（如"有效期至"、"过期"）
- platform: 1=支付宝, 2=微信支付

图片中无符合条件的券时，返回空数组 []。`

/** 从模型输出解析 JSON 数组：兼容 markdown 代码块包裹 / 前后噪声文本，失败返回 [] */
export function parseCouponJson(text: string): RawCoupon[] {
  const s = text.trim()
  // 保留旧系统原样正则（```json 围栏剥离）
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fence?.[1] ?? s).trim()

  let arr: unknown
  try {
    arr = JSON.parse(body)
  }
  catch {
    const start = body.indexOf('[')
    if (start === -1)
      return []
    try {
      arr = JSON.parse(body.slice(start))
    }
    catch {
      return []
    }
  }
  if (!Array.isArray(arr))
    return []
  return arr.filter(item => item && typeof item === 'object') as RawCoupon[]
}

/** 将 OpenAI 兼容响应（DashScope qwen-vl）统一为模型文本（供 parseCouponJson） */
export function extractVisionAssistantText(rawJson: string): string {
  let parsed: any
  try {
    parsed = JSON.parse(rawJson)
  }
  catch {
    return rawJson.trim()
  }

  const content = parsed?.choices?.[0]?.message?.content

  if (typeof content === 'string')
    return content
  if (Array.isArray(content)) {
    const joined = content
      .map((p: any) => {
        if (typeof p?.text === 'string')
          return p.text
        if (p != null && typeof p === 'object')
          return JSON.stringify(p)
        return p == null ? '' : String(p)
      })
      .join('')
    return joined.trim() || JSON.stringify(parsed, null, 2)
  }
  if (content != null && typeof content === 'object')
    return JSON.stringify(content, null, 2)
  return JSON.stringify(parsed, null, 2)
}

/**
 * 到期时间原始文案 → 毫秒时间戳，无法解析返回 null。
 * - 支付宝："今天HH:MM过期" / "明天HH:MM过期" / "MM月DD日HH:MM过期" / "MM月DD日过期"（默认 23:59，年份取当年）
 * - 微信等："有效期至YYYY/MM/DD HH:MM"、"YYYY.MM.DD"、"MM-DD" 等宽松解析
 */
export function parseExpiryTs(raw: string): number | null {
  const now = new Date()
  const year = now.getFullYear()

  // ── 支付宝格式：找"过期"，取前面的内容做时间表达式 ────────────────────
  const expIdx = raw.indexOf('过期')
  if (expIdx >= 0) {
    const expr = raw.slice(0, expIdx).trim()

    // 今天HH:MM
    const todayM = expr.match(/今天\s*(\d{1,2}):(\d{2})/)
    if (todayM) {
      const d = new Date(now)
      d.setHours(+todayM[1], +todayM[2], 0, 0)
      return d.getTime()
    }

    // 明天HH:MM
    const tmrM = expr.match(/明天\s*(\d{1,2}):(\d{2})/)
    if (tmrM) {
      const d = new Date(now)
      d.setDate(d.getDate() + 1)
      d.setHours(+tmrM[1], +tmrM[2], 0, 0)
      return d.getTime()
    }

    // MM月DD日HH:MM
    const dtM = expr.match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/)
    if (dtM) {
      return new Date(year, +dtM[1] - 1, +dtM[2], +dtM[3], +dtM[4], 0, 0).getTime()
    }

    // MM月DD日（无时间，默认23:59）
    const dOnlyM = expr.match(/(\d{1,2})月(\d{1,2})日/)
    if (dOnlyM) {
      return new Date(year, +dOnlyM[1] - 1, +dOnlyM[2], 23, 59, 0, 0).getTime()
    }

    return null
  }

  // ── 其他格式（微信"有效期至YYYY/MM/DD HH:MM"等）────────────────────────
  let cleaned = raw
    .replace(/有效期至|到期日期?[:：]?|到期[:：]?/g, '')
    .trim()
    .replace(/[^\d\-:/T. ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (/^\d{4}\.\d{1,2}\.\d{1,2}/.test(cleaned))
    cleaned = cleaned.replace(/\./g, '-')
  if (/^\d{4}\/\d{1,2}\/\d{1,2}/.test(cleaned))
    cleaned = cleaned.replace(/\//g, '-')
  if (/^\d{1,2}-\d{1,2}(?:[ T]\d{2}:\d{2})?$/.test(cleaned))
    cleaned = `${year}-${cleaned}`

  const d = new Date(cleaned)
  if (!Number.isFinite(d.getTime()))
    return null

  if (d.getHours() === 0 && d.getMinutes() === 0 && !cleaned.includes(':'))
    d.setHours(23, 59, 0, 0)

  return d.getTime()
}
