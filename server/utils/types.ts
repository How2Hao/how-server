// 广场/任务/记账共享 DTO（与旧系统 src/interface.ts 一致）
export interface ITaskStatusUpdateBody {
  status: string
  occurrenceDate?: number
}

export interface IPageData<T> {
  list: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

/** 按月份拉取时的单条：任务 + 发生日（当天 0 点时间戳） */
export interface ITaskOccurrenceItem {
  task: any
  occurrenceDate: number
  occurrenceId?: number | null
}

/** 按月份拉取返回：今天 + 其他日期分组 */
export interface ITaskMonthData {
  today: ITaskOccurrenceItem[]
  otherDays: Array<{
    date: string
    dateTimestamp: number
    tasks: ITaskOccurrenceItem[]
  }>
}

/**
 * 按月份拉取摘要模式（summaryOnly=true）：只返回今天详情 + 其他日期总数
 */
export interface ITaskMonthSummary {
  today: ITaskOccurrenceItem[]
  otherDaysCount: number
}

/** 批量识别银行卡接口返回的单条 */
export interface IBankCardRecognizedItem {
  bankName: string
  cardType: string
  cardLastFour: string
  /** 框坐标顺序见 bankCardVision.coverBboxOrder。默认 canvas 为 square_1000_fit：1000×1000 画布绝对坐标；image_axes 时为 0–1 相对整图。 */
  coverImgPosition?: [number, number, number, number]
  /** 按 coverImgPosition 从原图裁切后的 JPEG，带 data:image/jpeg;base64, 前缀 */
  coverImg?: string
}

export interface ICardCoverQwenGenerateBody {
  sourceBase64?: string
  sourceUrl?: string
  runCompare?: boolean
  model?: string
}

export interface ICardCoverQwenSourceMeta {
  sourceType: 'base64' | 'url'
  mimeType?: string | null
  byteLength?: number | null
  urlHost?: string | null
}

export interface ICardCoverQwenVariant {
  kind: 'faithful' | 'beautified'
  model: string
  imageUrl: string
  elapsedMs: number
  promptVersion: string
}

export interface ICardCoverQwenGenerateData {
  sourceMeta: ICardCoverQwenSourceMeta
  variants: ICardCoverQwenVariant[]
  warnings: string[]
}

export interface ISmsBillParseData {
  billAmount: number | null
  currency: string
  bankName?: string
  cardLastFour?: string
  statementMonth?: number
  minPayment?: number
  dueDateMonth?: number
  dueDateDay?: number
  dueDateText?: string
  templateSimilarity?: number
  confidence?: number
  reason?: string
  raw?: string
}

export interface ISmsCandidatePayload {
  address?: string
  body: string
  date?: number
}

export interface ISmsBillParseBatchItem extends ISmsBillParseData {
  bankId?: string
  sourceRuleId?: number
  templateSimilarity?: number
  matchMode?: 'EXACT' | 'ENDS_WITH' | 'CONTAINS' | 'TEMPLATE' | 'TEMPLATE_PREFIX'
  matchedRuleNumber?: string
  sourceAddress?: string
  sourceDate?: number
}

export interface IBankSmsRuleVo {
  id: number
  bankId: string
  bankName: string
  smsNumbersCsv: string
  smsTemplate: string
  isEnabled: number
}

export interface IBankCardSmsSenderInfo {
  bankCardId: string
  bankId: string
  ruleBankId?: string
  ruleBankName?: string
  smsSenders: string[]
}

/** sms-parse-by-card 请求体：candidates 每条可含 address；observedSenderAddresses 为去重后的真实发件号，用于合并进 bank_sms_rule */
export interface ISmsParseByCardBody {
  bankCardId: string
  candidates: ISmsCandidatePayload[]
  observedSenderAddresses?: string[]
}
