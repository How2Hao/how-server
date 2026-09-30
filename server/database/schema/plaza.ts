// 广场/银行域：银行、银行卡与卡模板、短信规则、卡组织/卡等级、
// 优惠平台与类目、卡券分类、自定义 Tab、地区、管理员、App 版本发布
// 列名/类型以旧库 SQL（db_exports + scripts 迁移）为准，与 TypeORM 实体冲突处取 SQL

import { bigint, char, datetime, double, index, int, json, mediumtext, mysqlTable, text, tinyint, uniqueIndex, varchar } from 'drizzle-orm/mysql-core'

/** 银行 */
export const bank = mysqlTable('bank', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  shortName: varchar('short_name', { length: 50 }),
  /** 银行拼音索引 */
  pinyinIndex: varchar('pinyin_index', { length: 100 }),
  code: varchar('code', { length: 50 }),
  logo: varchar('logo', { length: 255 }),
  /** 主题色，如 #D8B350 */
  themeColor: varchar('theme_color', { length: 255 }),
  creditCardCount: int('credit_card_count'),
  /** 是否账单合一银行（1=是，0=否） */
  isUnifiedBill: tinyint('is_unified_bill').notNull().default(0),
  /** 是否对用户端可见（1=显示，0=隐藏；by-id 查找不受此影响） */
  isVisible: tinyint('is_visible').notNull().default(1),
  /** 数据来源：52credit、flyert */
  source: varchar('source', { length: 255 }),
  /** 银行分类 code：STATE_OWNED/JOINT_STOCK/CITY_COMMERCIAL/RURAL_COMMERCIAL/RURAL_CREDIT_COOP/JOINT_VENTURE/VILLAGE/PRIVATE */
  bankType: varchar('bank_type', { length: 32 }),
  /** 是否热门（1=热门，0=普通） */
  isHot: tinyint('is_hot').notNull().default(0),
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
}, t => [
  index('idx_bank_type_is_hot').on(t.bankType, t.isHot),
])

/**
 * 用户银行卡。
 * 旧库有外键 fk_bank_card_user → users(id)、fk_template_id → bank_card_template(id)，
 * 按约定此处均不加 .references()。
 */
export const bankCard = mysqlTable('bank_card', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull(),
  /** 关联银行 ID（bank.id，字符串） */
  bankId: varchar('bank_id', { length: 50 }).notNull().default(''),
  cardName: varchar('card_name', { length: 255 }),
  /** 用户自定义备注名 */
  remark: varchar('remark', { length: 40 }),
  /** 信用卡等级：金卡、白金卡、钻石卡 */
  cardLevel: varchar('card_level', { length: 255 }),
  /** 借记卡等级：一类卡、二类卡 */
  cardClass: int('card_class'),
  /** DEBIT | CREDIT */
  cardType: varchar('card_type', { length: 20 }).notNull(),
  /** 卡组织 ID（card_organization.id，字符串存储），默认银联 */
  cardOrganization: varchar('card_organization', { length: 50 }).notNull().default('UNIONPAY'),
  cover: varchar('cover', { length: 500 }),
  regionCode: varchar('region_code', { length: 20 }).notNull(),
  cardLastFour: varchar('card_last_four', { length: 10 }).notNull(),
  creditLimit: double('credit_limit'),
  annualFeeType: varchar('annual_fee_type', { length: 20 }),
  rigidFeeAmount: double('rigid_fee_amount'),
  waiverMethod: varchar('waiver_method', { length: 30 }),
  waiverValue: double('waiver_value'),
  feeMonth: int('fee_month'),
  feeDay: int('fee_day'),
  statementDay: int('statement_day'),
  repaymentRuleType: varchar('repayment_rule_type', { length: 32 }),
  repaymentDay: int('repayment_day'),
  repaymentOffsetDays: int('repayment_offset_days'),
  maxInterestFreeDays: int('max_interest_free_days'),
  currency: varchar('currency', { length: 8 }).notNull().default('CNY'),
  /** 有效期，格式 YYYYMM */
  expiry: char('expiry', { length: 6 }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }),
  /** 关联卡模板（bank_card_template.id） */
  templateId: int('template_id'),
  /** 自定义排序值，越小越靠前 */
  sortOrder: int('sort_order'),
}, t => [
  index('idx_bank_card_user_id').on(t.userId),
  index('idx_bank_card_user_sort_order').on(t.userId, t.sortOrder),
])

/** 银行卡模板（外部抓取：51credit / flyert） */
export const bankCardTemplate = mysqlTable('bank_card_template', {
  id: int('id').autoincrement().primaryKey(),
  /** 关联银行 ID（bank.id，字符串）；无外键（与旧库一致） */
  bankId: varchar('bank_id', { length: 50 }).notNull(),
  cardName: varchar('card_name', { length: 255 }).notNull(),
  cardType: varchar('card_type', { length: 20 }).notNull(),
  cardLevel: varchar('card_level', { length: 255 }),
  /** 卡组织 ID（card_organization.id，字符串存储），默认银联 */
  cardOrganization: varchar('card_organization', { length: 50 }).notNull().default('UNIONPAY'),
  /** 封面图片 */
  cover: varchar('cover', { length: 500 }),
  /** 别名/曾用名 */
  alias: varchar('alias', { length: 255 }),
  /** 标签（JSON 字符串，旧库为 varchar，非 json 列） */
  tags: varchar('tags', { length: 1024 }),
  /** 数据来源（51credit/flyert） */
  dataSource: varchar('data_source', { length: 50 }).notNull().default('51credit'),
  /** 用户添加该模板的银行卡次数 */
  relatedCount: int('related_count').notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }),
})

/** 银行账单短信解析规则 */
export const bankSmsRule = mysqlTable('bank_sms_rule', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  /** bank.id（字符串）；无外键（与旧库一致） */
  bankId: varchar('bank_id', { length: 50 }).notNull(),
  bankName: varchar('bank_name', { length: 100 }).notNull(),
  /** 多号码逗号分隔，例如：95561,106920595568 */
  smsNumbersCsv: varchar('sms_numbers_csv', { length: 500 }).notNull(),
  /** 标准短信模板 */
  smsTemplate: text('sms_template').notNull(),
  isEnabled: tinyint('is_enabled').notNull().default(1),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, t => [
  uniqueIndex('uniq_bank_sms_rule_bank_id').on(t.bankId),
  index('idx_bank_sms_rule_enabled').on(t.isEnabled),
])

/** 银行优惠类目 */
export const benefitCategory = mysqlTable('benefit_category', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 50 }).notNull(),
  /** 图标（emoji） */
  icon: varchar('icon', { length: 200 }),
  sortOrder: int('sort_order').notNull().default(0),
  /** 关联记账收入类目 ID（acc_categories.id），NULL 表示不关联记账；无外键（与旧库一致） */
  accCategoryId: int('acc_category_id'),
  /** 关联平台 ID 列表，逗号分隔（如 "1,2,3"），对应 benefit_pay_platform.id */
  benefitPlatformIds: varchar('benefit_platform_ids', { length: 255 }),
}, t => [
  index('idx_acc_category_id').on(t.accCategoryId),
])

/** 优惠支付平台 */
export const benefitPayPlatform = mysqlTable('benefit_pay_platform', {
  id: int('id').autoincrement().primaryKey(),
  /** 平台代码，对应枚举名 */
  code: varchar('code', { length: 50 }).notNull(),
  /** 平台显示名称 */
  name: varchar('name', { length: 50 }).notNull(),
  /** Logo 图片 URL */
  icon: varchar('icon', { length: 255 }),
  sortOrder: int('sort_order').notNull().default(0),
}, t => [
  uniqueIndex('code').on(t.code),
])

/** 优惠使用平台 */
export const benefitUsagePlatform = mysqlTable('benefit_usage_platform', {
  id: int('id').autoincrement().primaryKey(),
  /** 平台代码（如 12306, MEITUAN, JD） */
  code: varchar('code', { length: 50 }).notNull(),
  /** 平台显示名称 */
  name: varchar('name', { length: 50 }).notNull(),
  /** 平台 Logo URL */
  icon: varchar('icon', { length: 255 }),
  remark: varchar('remark', { length: 255 }),
  sortOrder: int('sort_order').notNull().default(0),
}, t => [
  uniqueIndex('code').on(t.code),
])

/** 信用卡等级字典 */
export const cardLevel = mysqlTable('card_level', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 50 }).notNull(),
})

/** 卡组织字典（支持组合组织） */
export const cardOrganization = mysqlTable('card_organization', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  logo: varchar('logo', { length: 255 }).notNull().default(''),
  /** 支持卡类型，逗号分隔：DEBIT,CREDIT */
  supportedCardTypes: varchar('supported_card_types', { length: 64 }),
  /** 组合组织成员 ID，逗号分隔 */
  memberOrgIds: varchar('member_org_ids', { length: 64 }),
  /** ENABLED / DISABLED */
  status: varchar('status', { length: 16 }).notNull().default('ENABLED'),
})

/** 活动分类：支持两级分类（一级：出行、购物、生活；二级：火车票、机票、电商等） */
export const activityCategory = mysqlTable('activity_category', {
  id: int('id').autoincrement().primaryKey(),
  /** 分类编码：TRAVEL, TRAVEL_TRAIN, SHOPPING, SHOPPING_ECOM 等 */
  code: varchar('code', { length: 32 }).notNull(),
  /** 分类名称 */
  name: varchar('name', { length: 50 }).notNull(),
  /** 父分类 ID（NULL 表示一级分类） */
  parentId: int('parent_id'),
  /** 图标 URL */
  icon: varchar('icon', { length: 255 }),
  /** 排序权重 */
  sortOrder: int('sort_order').notNull().default(0),
  /** 创建时间戳（ms） */
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, t => [
  uniqueIndex('code').on(t.code),
  index('idx_parent').on(t.parentId),
])

/**
 * 卡券分类树（外部抓取，来源 quanma51.com）。
 * 自指树形：parent_id = 0 为一级分类，parent_id > 0 为二级品牌（用 0 而非 NULL，
 * 避免 MySQL 唯一索引中 NULL 不参与去重）。
 */
export const couponCategory = mysqlTable('coupon_category', {
  id: int('id').autoincrement().primaryKey(),
  /** 来源标识（目前固定 'quanma51'） */
  source: varchar('source', { length: 32 }).notNull().default('quanma51'),
  parentId: int('parent_id').notNull().default(0),
  /** 名称：一级 = "商超购物"；二级 = "永辉" */
  name: varchar('name', { length: 64 }).notNull(),
  /** 排序：跟来源页面 sidebar 顺序一致 */
  sortOrder: int('sort_order').notNull().default(0),
  /** OSS 上传后 logo URL（自家 bucket）；一级分类无 logo 留 null */
  logoUrl: varchar('logo_url', { length: 500 }),
  /** 来源原图 URL，留底备查 / 失败重传 */
  logoOriginUrl: varchar('logo_origin_url', { length: 500 }),
  /** 反查 SKU 的 query key（POST quanma51 in/infos { name }）；二级品牌行通常 = name */
  skuQueryName: varchar('sku_query_name', { length: 64 }),
  /** 显隐控制（运营手动隐藏不想露出的分类/品牌） */
  isVisible: tinyint('is_visible').notNull().default(1),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: datetime('updated_at').notNull(),
}, t => [
  uniqueIndex('uniq_coupon_category').on(t.source, t.parentId, t.name),
  index('idx_coupon_category_parent_visible').on(t.parentId, t.isVisible),
])

/** 广场自定义 Tab；start/end/created/updated 均为毫秒时间戳（bigint，与旧库一致） */
export const plazaCustomTab = mysqlTable('plaza_custom_tab', {
  id: int('id').autoincrement().primaryKey(),
  code: varchar('code', { length: 32 }).notNull(),
  name: varchar('name', { length: 20 }).notNull(),
  logo: varchar('logo', { length: 255 }),
  /** 关联 task_template.id 列表 */
  templateIds: json('template_ids').$type<number[]>().notNull(),
  sortOrder: int('sort_order').notNull().default(0),
  isVisible: tinyint('is_visible').notNull().default(1),
  startTime: bigint('start_time', { mode: 'number' }),
  endTime: bigint('end_time', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

/** 地区树（自然主键 region_code；100000 表示全国） */
export const region = mysqlTable('region', {
  regionCode: varchar('region_code', { length: 20 }).primaryKey(),
  regionName: varchar('region_name', { length: 50 }),
  parentCode: varchar('parent_code', { length: 20 }),
  level: int('level'),
  /** NORMAL / PLAN_SINGLE_CITY 等 */
  regionType: varchar('region_type', { length: 20 }).default('NORMAL'),
  isPlanSingleCity: tinyint('is_plan_single_city').default(0),
})

/** 管理员账户（how-admin 后台维护，how-api 只读，用于详情页展示发布人信息） */
export const adminUser = mysqlTable('admin_user', {
  id: int('id').autoincrement().primaryKey(),
  username: varchar('username', { length: 64 }).notNull(),
  displayName: varchar('display_name', { length: 100 }),
  avatar: varchar('avatar', { length: 500 }),
  role: varchar('role', { length: 32 }).notNull().default('ADMIN'),
  status: varchar('status', { length: 16 }).notNull().default('ACTIVE'),
})

/** App 发布版本：客户端拉这张表做版本对比 + 升级提示 + 版本记录页展示 */
export const appRelease = mysqlTable('app_release', {
  id: int('id').autoincrement().primaryKey(),
  /** 语义化版本号：如 "1.0.0"、"1.0.0.1"，与客户端 nativeAppVersion + nativeBuildVersion 对齐 */
  version: varchar('version', { length: 32 }).notNull(),
  /** 升级日志（markdown 字符串，前端解析渲染） */
  changelog: text('changelog').notNull(),
  /** Android 下载链接（APK 直链或落地页） */
  androidUrl: varchar('android_url', { length: 500 }),
  /** iOS 下载链接（App Store 或落地页） */
  iosUrl: varchar('ios_url', { length: 500 }),
  /** 是否强制升级；0=可跳过 1=强制 */
  isMandatory: tinyint('is_mandatory').notNull().default(0),
  /** 发布时间戳（ms） */
  publishedAt: bigint('published_at', { mode: 'number' }).notNull(),
  /** 记录创建时间戳（ms） */
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  /** 版本文章正文（markdown）；草稿不进本表，故本表行均为已发布 */
  article: mediumtext('article'),
  /** 版本文章标题 */
  articleTitle: varchar('article_title', { length: 200 }),
}, t => [
  uniqueIndex('uk_app_release_version').on(t.version),
])
