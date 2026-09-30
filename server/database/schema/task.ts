// 任务域：任务/循环规则/循环实例/活动模板/提醒模板/模板点赞与反馈/达标 Job 体系
// （task / task_recurring / task_recurring_occurrence / task_template / task_template_like /
//   task_template_feedback / reminder_template / job / job_recurring / job_recurring_occurrence / job_template）
// 列名/类型以旧库 SQL（db_exports + scripts 迁移）为准；枚举值集取实体（较 dump 更新）

import { bigint, datetime, decimal, index, int, json, mysqlEnum, mysqlTable, smallint, text, tinyint, uniqueIndex, varchar } from 'drizzle-orm/mysql-core'

/** 任务模板规则来源（rule_source JSON）：外链 URL + 多张原图 URL */
export interface TaskTemplateRuleSource {
  linkUrl?: string | null
  imageUrls?: string[] | null
}

/** 任务模板档位（tiers JSON 数组元素）；档位数 > 1 表示同一行内“互斥取一” */
export interface TaskTemplateTier {
  /** 达标金额；null 表示无门槛 */
  minAmount: number | null
  /** 固定优惠金额（与 Min/Max 互斥） */
  benefitAmountFixed: number | null
  /** 区间优惠下限（与 Fixed 互斥，需配合 Max） */
  benefitAmountMin: number | null
  /** 区间优惠上限（与 Fixed 互斥，需配合 Min） */
  benefitAmountMax: number | null
  /** 优惠文案 */
  benefitDescription: string | null
  /** 每日/每周名额 文本 */
  quotaPerCycleText: string | null
  /** 总名额 文本 */
  quotaTotalText: string | null
}

/** 任务模板关联的电子卡券/会员充值明细（linked_coupons JSON 数组元素） */
export interface LinkedCoupon {
  /** coupon_category.id（必填） */
  couponId: number
  /** 购买花费（元）；0 表示免费领，null 表示尚未录入 */
  purchasePrice: number | null
  /** SKU 文本，如 "20元券" / "月卡" / "季卡" */
  sku: string | null
  /** 实际价值（元） */
  actualValue: number | null
}

/** 达标条件档位（job_template.tiers JSON 数组元素） */
export interface JobTemplateTier {
  logic: 'AND' | 'OR'
  minAmount: number | null
  minCount: number | null
  description: string | null
}

/** 结构化权益窗口规则（job_template.reward_window_rule JSON） */
export interface JobRewardWindowRule {
  mode: 'NEXT_MONTH' | 'NEXT_WEEK' | 'AFTER_COMPLETION_DAYS' | 'FIXED'
  startDay?: number | 'FIRST_DAY'
  endDay?: number | 'LAST_DAY'
  weekStartsOn?: number
  startOffsetDays?: number
  durationDays?: number
  startAt?: number
  endAt?: number
}

/** 用户任务。旧库有外键 fk_task_user → users(id)，按约定此处不加 .references() */
export const task = mysqlTable('task', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  /** 一次性任务的日期（ms）；循环任务此字段存 startDate */
  date: bigint('date', { mode: 'number' }),
  /** ONE_TIME 由 task 表直接管理；其余类型配合 task_recurring 表使用 */
  repeatType: mysqlEnum('repeat_type', ['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']).notNull().default('ONE_TIME'),
  reminderTime: varchar('reminder_time', { length: 10 }),
  /** 卡券/权益过期时间；仅 EXPIRY_REMINDER 使用 */
  expireAt: bigint('expire_at', { mode: 'number' }),
  bankId: varchar('bank_id', { length: 50 }),
  /** 频控 JSON 字符串：{ totalCount, cycleCount }（旧库为 varchar，非 json 列） */
  frequencyControl: varchar('frequency_control', { length: 100 }),
  highPriority: tinyint('high_priority').notNull().default(0),
  /** 提前提醒分钟数（1–60） */
  advanceReminderMinutes: smallint('advance_reminder_minutes'),
  /** 一次性任务的完成状态；循环任务完成状态由 task_recurring_occurrence.is_completed 管理 */
  status: mysqlEnum('status', ['PENDING', 'EXPIRED', 'COMPLETED']).notNull().default('PENDING'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  taskTemplateId: int('task_template_id'),
  /** 来源提醒模板：从 reminder_template 创建的 task 会带上 */
  reminderTemplateId: int('reminder_template_id'),
  /** 来源 job：job 达标后生成提醒 task 时写入 */
  sourceJobId: int('source_job_id'),
  /** 来源 job 周期实例：保证“本月达标只生成对应权益窗口提醒” */
  sourceJobOccurrenceId: int('source_job_occurrence_id'),
  /** 用户选定的银行卡 ID（bank_card.id） */
  bankCardId: int('bank_card_id'),
  /** 优惠类目 ID（benefit_category.id） */
  benefitCategoryId: int('benefit_category_id'),
  /** 选中档的达标金额快照 */
  minAmount: decimal('min_amount', { precision: 10, scale: 2 }),
  /** 选中档的固定优惠金额（与 Min/Max 互斥） */
  benefitAmountFixed: decimal('benefit_amount_fixed', { precision: 10, scale: 2 }),
  /** 选中档的区间优惠下限（与 Fixed 互斥） */
  benefitAmountMin: decimal('benefit_amount_min', { precision: 10, scale: 2 }),
  /** 选中档的区间优惠上限（与 Fixed 互斥） */
  benefitAmountMax: decimal('benefit_amount_max', { precision: 10, scale: 2 }),
  benefitVoucherDescription: varchar('benefit_voucher_description', { length: 500 }),
  /** 选中档的每日/每周名额文案快照 */
  quotaPerCycleText: varchar('quota_per_cycle_text', { length: 200 }),
  /** 选中档的总名额文案快照 */
  quotaTotalText: varchar('quota_total_text', { length: 200 }),
  /** 卡组织（旧列名 bank_card_organization） */
  cardOrganizations: text('bank_card_organization'),
  bankCardType: varchar('bank_card_type', { length: 255 }),
  bankCardLevel: int('bank_card_level'),
  /** 关联优惠平台 ID（benefit_pay_platform.id），单选 */
  benefitPayPlatformId: int('benefit_pay_platform_id'),
  /** 任务种类（实体较 dump 新增 EXPIRY_REMINDER / BILL_REMINDER） */
  kind: mysqlEnum('kind', ['TRACKING', 'REMINDER', 'EXPIRY_REMINDER', 'PIN', 'BILL_REMINDER']),
  /** 用户手填累计金额，仅 ONE_TIME TRACKING 任务使用 */
  cumulativeAmount: decimal('cumulative_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
  /** 用户手填累计笔数，仅 ONE_TIME TRACKING 任务使用 */
  cumulativeCount: int('cumulative_count').notNull().default(0),
  updatedAt: datetime('updated_at').notNull(),
}, t => [
  index('idx_task_user_id').on(t.userId),
])

/** 循环任务规则（task 一对一） */
export const taskRecurring = mysqlTable('task_recurring', {
  id: int('id').autoincrement().primaryKey(),
  taskId: int('task_id').notNull(),
  repeatType: mysqlEnum('repeat_type', ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']).notNull().default('DAILY'),
  daysOfWeek: varchar('days_of_week', { length: 50 }),
  daysOfMonth: varchar('days_of_month', { length: 200 }),
  yearlyMonths: varchar('yearly_months', { length: 100 }),
  yearlyDaysOfMonth: varchar('yearly_days_of_month', { length: 200 }),
  startDate: bigint('start_date', { mode: 'number' }),
  endDate: bigint('end_date', { mode: 'number' }),
  reminderTime: varchar('reminder_time', { length: 10 }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().default(0),
  updatedAt: datetime('updated_at').notNull(),
}, t => [
  uniqueIndex('uniq_task_id').on(t.taskId),
  index('idx_repeat_type').on(t.repeatType),
])

/** 循环任务周期实例 */
export const taskRecurringOccurrence = mysqlTable('task_recurring_occurrence', {
  id: int('id').autoincrement().primaryKey(),
  taskId: int('task_id').notNull(),
  occurrenceDate: bigint('occurrence_date', { mode: 'number' }).notNull(),
  /** 实体较 dump 新增 CANCELLED */
  status: mysqlEnum('status', ['PENDING', 'EXPIRED', 'COMPLETED', 'CANCELLED']).notNull().default('PENDING'),
  isCompleted: tinyint('is_completed').notNull().default(0),
  completedAt: bigint('completed_at', { mode: 'number' }),
  /** 用户手填累计金额，循环 TRACKING 任务按周期独立 */
  cumulativeAmount: decimal('cumulative_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
  /** 用户手填累计笔数，循环 TRACKING 任务按周期独立 */
  cumulativeCount: int('cumulative_count').notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().default(0),
  updatedAt: datetime('updated_at').notNull(),
}, t => [
  uniqueIndex('uniq_task_occurrence').on(t.taskId, t.occurrenceDate),
  index('idx_occurrence_date').on(t.occurrenceDate),
  index('idx_status').on(t.status),
])

/**
 * 任务模板（任务广场一键添加，无执行日期/状态）。
 * task_id/benefit_category_id 等关联列无外键（与旧库一致）。
 */
export const taskTemplate = mysqlTable('task_template', {
  id: int('id').autoincrement().primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  /** AI 生成的简明规则（一句话） */
  ruleBrief: varchar('rule_brief', { length: 500 }),
  /** 详细规则文字 */
  ruleDetail: text('rule_detail'),
  /** 原始规则来源（外链 URL + 多张原图 URL） */
  ruleSource: json('rule_source').$type<TaskTemplateRuleSource>(),
  /** 由 task_template 拆分出的默认提醒模板 */
  reminderTemplateId: int('reminder_template_id'),
  /** 该活动关联的参与条件 job_template */
  jobTemplateId: int('job_template_id'),
  date: bigint('date', { mode: 'number' }),
  repeatType: mysqlEnum('repeat_type', ['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']).notNull().default('ONE_TIME'),
  daysOfWeek: varchar('days_of_week', { length: 50 }),
  daysOfMonth: varchar('days_of_month', { length: 200 }),
  yearlyMonths: varchar('yearly_months', { length: 100 }),
  yearlyDaysOfMonth: varchar('yearly_days_of_month', { length: 200 }),
  reminderTime: varchar('reminder_time', { length: 10 }),
  bankId: int('bank_id').notNull(),
  bankCardTemplateId: int('bank_card_template_id'),
  startDate: bigint('start_date', { mode: 'number' }),
  endDate: bigint('end_date', { mode: 'number' }),
  /** 频控 JSON 字符串（旧库为 varchar，非 json 列） */
  frequencyControl: varchar('frequency_control', { length: 100 }),
  highPriority: tinyint('high_priority').notNull().default(0),
  isCompleted: tinyint('is_completed').notNull().default(0),
  status: mysqlEnum('status', ['PENDING', 'EXPIRED', 'COMPLETED']).notNull().default('PENDING'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  benefitCategoryId: int('benefit_category_id'),
  /** 卡组织（旧列名 bank_card_organization） */
  cardOrganizations: varchar('bank_card_organization', { length: 255 }),
  bankCardType: varchar('bank_card_type', { length: 255 }),
  bankCardLevel: int('bank_card_level'),
  regionCode: varchar('region_code', { length: 20 }).notNull().default('100000'),
  regionMatchStrategy: varchar('region_match_strategy', { length: 255 }),
  benefitPayPlatformId: int('benefit_pay_platform_id'),
  benefitUsagePlatformId: int('benefit_usage_platform_id'),
  /** 活动分类 ID（activity_category.id） */
  activityCategoryId: int('activity_category_id'),
  /** 参与难度：EASY/MEDIUM/HARD */
  participationDifficulty: varchar('participation_difficulty', { length: 16 }),
  /** 附加参与条件（仅文案，不参与硬判定） */
  extraConditionsText: text('extra_conditions_text'),
  /** 操作指南文字 */
  guideText: text('guide_text'),
  updatedAt: datetime('updated_at').notNull(),
  publisher: varchar('publisher', { length: 255 }),
  publishTime: datetime('publish_time'),
  likes: int('likes').default(0),
  addCount: int('add_count').default(0),
  /** 档位信息数组，主存储；至少 1 个元素 */
  tiers: json('tiers').$type<TaskTemplateTier[]>().notNull(),
  /** UI 聚合分组 ID（无业务语义，仅用于“非互斥多档”卡片聚合） */
  groupId: int('group_id'),
  /** 电子卡券/会员充值类活动关联的卡券明细（仅 benefitCategoryId in (1,2) 时填值） */
  linkedCoupons: json('linked_coupons').$type<LinkedCoupon[]>(),
  /** 创建/维护该模板的管理员 admin_user.id，老数据回填为 1 */
  adminUserId: int('admin_user_id').notNull().default(1),
  /** 是否对老 app 可见：1=透出 0=隐藏 */
  isVisible: tinyint('is_visible').notNull().default(0),
}, t => [
  index('idx_activity_category').on(t.activityCategoryId),
])

/** 任务模板点赞关系 */
export const taskTemplateLike = mysqlTable('task_template_like', {
  id: int('id').autoincrement().primaryKey(),
  taskTemplateId: int('task_template_id').notNull(),
  /** 旧库有外键 fk_task_template_like_user → users(id)，按约定此处不加 .references() */
  userId: int('user_id').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().default(0),
}, t => [
  uniqueIndex('uniq_task_template_like_user').on(t.taskTemplateId, t.userId),
  index('idx_task_template_like_template_id').on(t.taskTemplateId),
  index('idx_task_template_like_user_id').on(t.userId),
])

/** 活动详情页用户反馈（追加，不去重） */
export const taskTemplateFeedback = mysqlTable('task_template_feedback', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull(),
  taskTemplateId: int('task_template_id').notNull(),
  content: text('content').notNull(),
  createdAt: datetime('created_at').notNull(),
}, t => [
  index('idx_template').on(t.taskTemplateId),
  index('idx_user').on(t.userId),
])

/** 提醒模板（从 task_template 拆出 / admin 配置） */
export const reminderTemplate = mysqlTable('reminder_template', {
  id: int('id').autoincrement().primaryKey(),
  /** 所属活动模板；task_template 保持表名不变，语义上作为 activity_template 使用 */
  taskTemplateId: int('task_template_id').notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  kind: mysqlEnum('kind', ['REMINDER', 'EXPIRY_REMINDER']).notNull().default('REMINDER'),
  repeatType: mysqlEnum('repeat_type', ['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']).notNull().default('ONE_TIME'),
  /** 一次性提醒日期，或循环提醒的锚点日期；毫秒时间戳 */
  date: bigint('date', { mode: 'number' }),
  /** 模板整体有效期起 */
  startDate: bigint('start_date', { mode: 'number' }),
  /** 模板整体有效期止 */
  endDate: bigint('end_date', { mode: 'number' }),
  daysOfWeek: varchar('days_of_week', { length: 50 }),
  daysOfMonth: varchar('days_of_month', { length: 200 }),
  yearlyMonths: varchar('yearly_months', { length: 100 }),
  yearlyDaysOfMonth: varchar('yearly_days_of_month', { length: 200 }),
  reminderTime: varchar('reminder_time', { length: 10 }),
  advanceReminderMinutes: smallint('advance_reminder_minutes'),
  isVisible: tinyint('is_visible').notNull().default(1),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: datetime('updated_at').notNull(),
}, t => [
  index('idx_reminder_template_task_template').on(t.taskTemplateId),
])

/** 达标 Job：ACTIVITY=活动冲量；REPAYMENT=还款 */
export const job = mysqlTable('job', {
  id: int('id').autoincrement().primaryKey(),
  /** 旧库 job 表各关联列均无外键（与旧库一致） */
  userId: int('user_id').notNull(),
  /** ACTIVITY job 来自 admin job_template；REPAYMENT job 可为空 */
  jobTemplateId: int('job_template_id'),
  /** 活动 job 所属 task_template；还款 job 为空 */
  taskTemplateId: int('task_template_id'),
  sourceType: mysqlEnum('source_type', ['ACTIVITY', 'REPAYMENT']).notNull(),
  subjectType: mysqlEnum('subject_type', ['TASK_TEMPLATE', 'BANK', 'BANK_CARD']).notNull(),
  /** TASK_TEMPLATE/BANK/BANK_CARD 的 id，由 subject_type 决定 */
  subjectId: int('subject_id').notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  repeatType: mysqlEnum('repeat_type', ['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']).notNull().default('ONE_TIME'),
  status: mysqlEnum('status', ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'EXPIRED', 'ARCHIVED']).notNull().default('PENDING'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: datetime('updated_at').notNull(),
}, t => [
  index('idx_job_user_source').on(t.userId, t.sourceType),
  index('idx_job_subject').on(t.subjectType, t.subjectId),
  index('idx_job_template').on(t.jobTemplateId),
  index('idx_job_task_template').on(t.taskTemplateId),
])

/** Job 循环规则（job 一对一） */
export const jobRecurring = mysqlTable('job_recurring', {
  id: int('id').autoincrement().primaryKey(),
  jobId: int('job_id').notNull(),
  repeatType: mysqlEnum('repeat_type', ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']).notNull().default('DAILY'),
  daysOfWeek: varchar('days_of_week', { length: 50 }),
  daysOfMonth: varchar('days_of_month', { length: 200 }),
  yearlyMonths: varchar('yearly_months', { length: 100 }),
  yearlyDaysOfMonth: varchar('yearly_days_of_month', { length: 200 }),
  startDate: bigint('start_date', { mode: 'number' }),
  endDate: bigint('end_date', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: datetime('updated_at').notNull(),
}, t => [
  uniqueIndex('uniq_job_id').on(t.jobId),
])

/** Job 周期实例 */
export const jobRecurringOccurrence = mysqlTable('job_recurring_occurrence', {
  id: int('id').autoincrement().primaryKey(),
  jobId: int('job_id').notNull(),
  /** 周期唯一键，如 2026-06、2026-W23；避免同一 job 周期重复创建 */
  cycleKey: varchar('cycle_key', { length: 64 }).notNull(),
  /** ACTIVITY=达标周期开始；REPAYMENT=账单日 */
  occurrenceStartAt: bigint('occurrence_start_at', { mode: 'number' }).notNull(),
  /** ACTIVITY=达标周期结束；REPAYMENT=还款日 */
  occurrenceEndAt: bigint('occurrence_end_at', { mode: 'number' }).notNull(),
  /** ACTIVITY 达标后的权益窗口开始；REPAYMENT 为空 */
  rewardStartAt: bigint('reward_start_at', { mode: 'number' }),
  /** ACTIVITY 达标后的权益窗口结束；REPAYMENT 为空 */
  rewardEndAt: bigint('reward_end_at', { mode: 'number' }),
  status: mysqlEnum('status', ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'EXPIRED']).notNull().default('PENDING'),
  /** ACTIVITY=消费/支付金额；REPAYMENT=本期账单金额 */
  progressAmount: decimal('progress_amount', { precision: 12, scale: 2 }).notNull().default('0.00'),
  /** ACTIVITY=消费/支付笔数；REPAYMENT 可为空或 0 */
  progressCount: int('progress_count').notNull().default(0),
  completedAt: bigint('completed_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: datetime('updated_at').notNull(),
}, t => [
  index('idx_job_occurrence_window').on(t.occurrenceStartAt, t.occurrenceEndAt),
  index('idx_job_occurrence_reward_window').on(t.rewardStartAt, t.rewardEndAt),
  index('idx_job_occurrence_status').on(t.status),
  uniqueIndex('uniq_job_occurrence').on(t.jobId, t.cycleKey),
])

/** 参与条件 Job 模板（admin 维护） */
export const jobTemplate = mysqlTable('job_template', {
  id: int('id').autoincrement().primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  repeatType: mysqlEnum('repeat_type', ['ONE_TIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']).notNull().default('ONE_TIME'),
  date: bigint('date', { mode: 'number' }),
  startDate: bigint('start_date', { mode: 'number' }),
  endDate: bigint('end_date', { mode: 'number' }),
  daysOfWeek: varchar('days_of_week', { length: 50 }),
  daysOfMonth: varchar('days_of_month', { length: 200 }),
  yearlyMonths: varchar('yearly_months', { length: 100 }),
  yearlyDaysOfMonth: varchar('yearly_days_of_month', { length: 200 }),
  tiers: json('tiers').$type<JobTemplateTier[]>().notNull(),
  taskTemplateId: int('task_template_id'),
  reminderTemplateId: int('reminder_template_id'),
  /** 结构化权益窗口规则，用于由 occurrence 计算 reward_start_at/reward_end_at */
  rewardWindowRule: json('reward_window_rule').$type<JobRewardWindowRule>(),
  /** 权益次数/资格等展示文本，如“下月可抽奖 5 次” */
  rewardDescription: varchar('reward_description', { length: 500 }),
  /** @deprecated 新设计中 job_template 只挂 task_template，银行维度来自 task_template */
  bankId: int('bank_id'),
  /** @deprecated 新设计中 job_template 只挂 task_template，卡模板维度来自 task_template */
  bankCardTemplateId: int('bank_card_template_id'),
  /** @deprecated 新设计中 job_template 只挂 task_template，地区维度来自 task_template */
  regionCode: varchar('region_code', { length: 20 }),
  /** @deprecated 新设计中 job_template 只挂 task_template，地区匹配策略来自 task_template */
  regionMatchStrategy: varchar('region_match_strategy', { length: 255 }),
  adminUserId: int('admin_user_id').notNull().default(1),
  isVisible: tinyint('is_visible').notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: datetime('updated_at').notNull(),
}, t => [
  index('idx_job_template_task_template').on(t.taskTemplateId),
  index('idx_job_template_reminder_template').on(t.reminderTemplateId),
])
