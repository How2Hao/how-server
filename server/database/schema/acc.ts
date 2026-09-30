// 记账域：账本/分类/交易/成员（acc_users / acc_ledgers / acc_categories / acc_transactions）
// 列名/类型以旧库 SQL（db_exports + scripts 迁移）为准，与 TypeORM 实体冲突处取 SQL

import { bigint, decimal, foreignKey, index, int, mysqlEnum, mysqlTable, text, tinyint, uniqueIndex, varchar } from 'drizzle-orm/mysql-core'
import { user } from './auth'
import { benefitPayPlatform } from './plaza'

/** 记账成员：每个登录用户（users.id）可创建多个独立记账账户 */
export const accUser = mysqlTable('acc_users', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id').notNull(),
  username: varchar('username', { length: 50 }).notNull(),
  avatar: varchar('avatar', { length: 500 }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().default(0),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().default(0),
}, t => [
  foreignKey({ name: 'fk_acc_user_owner_user', columns: [t.userId], foreignColumns: [user.id] }).onDelete('cascade'),
  uniqueIndex('uniq_acc_user_owner_username').on(t.userId, t.username),
  index('idx_acc_user_owner').on(t.userId),
])

/** 账本 */
export const accLedger = mysqlTable('acc_ledgers', {
  id: int('id').autoincrement().primaryKey(),
  // 旧库 2026-04-21 dump 及 migrate_user_system_v1.sql 已将该 FK 指向 users(id)
  userId: int('user_id').notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  icon: varchar('icon', { length: 20 }),
  currency: varchar('currency', { length: 10 }).notNull().default('CNY'),
  isDefault: tinyint('is_default').notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().default(0),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().default(0),
}, t => [
  foreignKey({ name: 'fk_acc_ledger_user', columns: [t.userId], foreignColumns: [user.id] }).onDelete('cascade'),
  index('idx_ledger_user').on(t.userId),
])

/** 收支分类；user_id 为 NULL 表示系统内置分类 */
export const accCategory = mysqlTable('acc_categories', {
  id: int('id').autoincrement().primaryKey(),
  userId: int('user_id'),
  type: mysqlEnum('type', ['INCOME', 'EXPENSE']).notNull().default('EXPENSE'),
  name: varchar('name', { length: 50 }).notNull(),
  icon: varchar('icon', { length: 200 }),
  sortOrder: int('sort_order').notNull().default(0),
  /** 1 = 系统内置，不可删除 */
  isSystem: tinyint('is_system').notNull().default(0),
  /** 1 = 前台展示，0 = 不展示（migrate_acc_categories_visibility_and_installment） */
  isVisible: tinyint('is_visible').notNull().default(1),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().default(0),
}, t => [
  index('idx_cat_user_type').on(t.userId, t.type),
])

/** 收支记录 */
export const accTransaction = mysqlTable('acc_transactions', {
  id: int('id').autoincrement().primaryKey(),
  ledgerId: int('ledger_id').notNull(),
  /** 记账账户用户 ID（acc_users.id），nullable，与登录态 userId 无关 */
  accUserId: int('acc_user_id'),
  categoryId: int('category_id').notNull(),
  type: mysqlEnum('type', ['INCOME', 'EXPENSE']).notNull(),
  amount: decimal('amount', { precision: 15, scale: 2 }).notNull(),
  /** 账户/支付方式：微信/支付宝/信用卡 等 */
  account: varchar('account', { length: 50 }),
  /** 关联银行 ID（bank.id，字符串） */
  bankId: varchar('bank_id', { length: 50 }),
  /** 关联银行卡 ID（bank_card.id） */
  bankCardId: int('bank_card_id'),
  /** 关联优惠平台 ID（benefit_pay_platform.id），单选 */
  benefitPayPlatformId: int('benefit_pay_platform_id'),
  /** 来源任务 ID（task.id），用于任务页一键记账回溯 */
  sourceTaskId: int('source_task_id'),
  /** 关联收入 ID：成本支出记录指向对应收入记录（一对一，仅支出记录使用） */
  relatedIncomeId: int('related_income_id'),
  /** 关联成本是否在 list 独立成行：1=独立 0=合并到收入行 */
  showInList: tinyint('show_in_list').notNull().default(1),
  /** 记账时间戳（ms） */
  transactionDate: bigint('transaction_date', { mode: 'number' }).notNull(),
  remark: varchar('remark', { length: 500 }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull().default(0),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull().default(0),
}, t => [
  foreignKey({ name: 'fk_txn_ledger', columns: [t.ledgerId], foreignColumns: [accLedger.id] }).onDelete('cascade'),
  foreignKey({ name: 'fk_txn_category', columns: [t.categoryId], foreignColumns: [accCategory.id] }).onDelete('restrict'),
  foreignKey({ name: 'fk_acc_txn_benefit_pay_platform', columns: [t.benefitPayPlatformId], foreignColumns: [benefitPayPlatform.id] }).onDelete('set null'),
  index('idx_txn_ledger').on(t.ledgerId),
  index('idx_txn_category').on(t.categoryId),
  index('idx_txn_date').on(t.transactionDate),
  index('idx_related_income_id').on(t.relatedIncomeId),
  index('idx_acc_transactions_acc_user_id').on(t.accUserId),
  index('idx_txn_ledger_date').on(t.ledgerId, t.transactionDate),
  index('idx_txn_benefit_pay_platform_id').on(t.benefitPayPlatformId),
  index('idx_source_task_id').on(t.sourceTaskId),
])
