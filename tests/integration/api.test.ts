import { randomBytes } from 'node:crypto'
// 集成测试：真实 MySQL（独立 *_test 库）上的认证/任务/记账端到端流程
// 仅当测试库可达时运行；强制要求库名以 _test 结尾，防止误连真实数据库
import process from 'node:process'
import { eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

process.env.DB_DATABASE ??= 'how2hao_api_test'
const TEST_DB = process.env.DB_DATABASE
if (!TEST_DB.endsWith('_test')) {
  throw new Error(`集成测试拒绝运行：DB_DATABASE=${TEST_DB} 不是 *_test 测试库`)
}

process.env.AUTH_SMS_PROVIDER ??= 'MOCK_PROVIDER'

const { db } = await import('../../server/database/db.ts')
const { user } = await import('../../server/database/schema/auth.ts')
const { task } = await import('../../server/database/schema/task.ts')

let dbOk = true
try {
  await db.execute(sql`SELECT 1`)
}
catch {
  dbOk = false
}

// 动态导入服务模块（保证 env 先行）
const authSvc = await import('../../server/utils/services/auth.ts')
const accSvc = await import('../../server/utils/services/acc.ts')
const settingsSvc = await import('../../server/utils/services/user-settings.ts')
const taskSvc = await import('../../server/utils/services/task.ts')

const meta = { ip: '127.0.0.1', userAgent: 'vitest' }

function uniquePhone(): string {
  return `139${Date.now().toString().slice(-8)}${randomBytes(1).readUInt8(0) % 10}`.slice(0, 11)
}

const createdUserIds: number[] = []

async function loginBySms(): Promise<{ userId: number, accessToken: string, refreshToken: string }> {
  const phone = uniquePhone()
  const { providerRequestId } = await authSvc.sendSmsCode(phone, 'LOGIN', meta)
  const result = await authSvc.smsLogin({ phone, providerRequestId, code: '123456', meta })
  createdUserIds.push(result.user.id)
  return { userId: result.user.id, accessToken: result.accessToken, refreshToken: result.refreshToken }
}

describe.skipIf(!dbOk)('auth 集成流程（需要 *_test 测试库）', () => {
  it('短信发送 → 登录 → me → refresh 轮换 → logout', async () => {
    const phone = uniquePhone()
    const { providerRequestId } = await authSvc.sendSmsCode(phone, 'LOGIN', meta)

    // MOCK_PROVIDER：任意 6 位数字
    const login = await authSvc.smsLogin({ phone, providerRequestId, code: '654321', meta })
    expect(login.isNewUser).toBe(true)
    expect(login.user.phone).toBe(phone)
    expect(login.user.username).toBe('羊羊羊')
    expect(login.user.hasPassword).toBe(false)
    expect(login.accessToken.split('.')).toHaveLength(3)
    expect(login.refreshToken).toHaveLength(32)
    createdUserIds.push(login.user.id)

    // 防重放：同一 providerRequestId 再次校验应失败
    await expect(authSvc.smsLogin({ phone, providerRequestId, code: '654321', meta }))
      .rejects
      .toThrow('验证码已失效，请重新发送')

    const me = await authSvc.getMe(login.user.id)
    expect(me.uid6).toMatch(/^[0-9A-Z]{6}$/)

    // refresh：旧 refreshToken 轮换后失效
    const refreshed = await authSvc.refresh(login.refreshToken, meta)
    expect(refreshed.user.id).toBe(login.user.id)
    await expect(authSvc.refresh(login.refreshToken, meta)).rejects.toThrow('refreshToken 无效')

    // logout 后新 refreshToken 也失效
    await authSvc.logout(refreshed.refreshToken)
    await expect(authSvc.refresh(refreshed.refreshToken, meta)).rejects.toThrow('refreshToken 无效')
  })

  it('微信登录创建 PENDING_BIND 用户并初始化账本/设置，bindPhone 后转 ACTIVE', async () => {
    const unionid = `test_${randomBytes(8).toString('hex')}`
    const login = await authSvc.wechatLogin({ unionid, username: '微信用户', meta })
    createdUserIds.push(login.user.id)

    const me = await authSvc.getMe(login.user.id)
    expect(me.status).toBe('PENDING_BIND')
    expect(me.needBindPhone).toBe(true)

    // 新用户初始化：默认账本 + 默认设置联动
    const ledgers = await accSvc.getLedgers(login.user.id)
    expect(ledgers).toHaveLength(1)
    expect(ledgers[0]!.isDefault).toBe(true)
    const settings = await settingsSvc.getSettings(login.user.id) as { finance: { defaultLedgerId: number } }
    expect(settings.finance.defaultLedgerId).toBe((ledgers[0] as any).id)

    // 绑定手机号 → ACTIVE
    const phone = uniquePhone()
    const { providerRequestId } = await authSvc.sendSmsCode(phone, 'BIND_PHONE', meta)
    const bound = await authSvc.bindPhone(login.user.id, phone, providerRequestId, '123456', meta)
    expect(bound.status).toBe('ACTIVE')
    expect(bound.phone).toBe(phone)
  })

  it('设置密码 → 密码登录 → 重复设置被拒', async () => {
    const { userId } = await loginBySms()
    await authSvc.setPassword(userId, 'test12345')
    const me = await authSvc.getMe(userId)
    expect(me.phone).toBeTruthy()
    const status = await authSvc.phoneStatus(me.phone!)
    expect(status.hasPassword).toBe(true)

    const login = await authSvc.passwordLogin(me.phone!, 'test12345', meta)
    expect(login.user.id).toBe(userId)

    await expect(authSvc.setPassword(userId, 'test99999')).rejects.toThrow('密码已设置')
  })

  it('注销账号清理全部业务数据', async () => {
    const { userId, accessToken } = await loginBySms()
    await taskSvc.createTask(userId, { title: '待清理任务', date: Date.now() } as any)

    const before = await db.select().from(user).where(eq(user.id, userId))
    expect(before).toHaveLength(1)

    await authSvc.deleteAccount(userId)
    createdUserIds.splice(createdUserIds.indexOf(userId), 1)

    const after = await db.select().from(user).where(eq(user.id, userId))
    expect(after).toHaveLength(0)
    const tasks = await db.select().from(task).where(eq(task.userId, userId))
    expect(tasks).toHaveLength(0)
    // token 已随 session 级联删除：verify 应返回 null
    const { verifyAccessTokenAndGetUser } = await import('../../server/utils/session.ts')
    expect(await verifyAccessTokenAndGetUser(accessToken)).toBeNull()
  })
})

describe.skipIf(!dbOk)('任务/记账集成流程（需要 *_test 测试库）', () => {
  it('创建任务 → 月视图 → 状态更新 → 删除', async () => {
    const { userId } = await loginBySms()
    const now = new Date()
    const date = new Date(now.getFullYear(), now.getMonth(), 15, 10).getTime()

    const created = await taskSvc.createTask(userId, {
      title: '集成测试任务',
      date,
      repeatType: 'ONE_TIME',
    } as any)
    expect(created.title).toBe('集成测试任务')

    // includePast=true：日历圆点语义，本月任意日期（含今天之前）都应返回
    const month = await taskSvc.getTasksByMonth(userId, now.getFullYear(), now.getMonth() + 1, { includePast: true })
    const allTasks = [
      ...month.today.map((x: any) => x.task),
      ...month.otherDays.flatMap((d: any) => d.tasks.map((x: any) => x.task)),
    ]
    expect(allTasks.some((t: any) => t.id === created.id)).toBe(true)

    const updated = await taskSvc.updateTaskStatus(userId, String(created.id), 'COMPLETED', undefined)
    expect(updated.status).toBe('COMPLETED')

    await taskSvc.deleteTask(userId, String(created.id), {})
    const found = await taskSvc.getTaskById(userId, String(created.id))
    expect(found).toBeNull()
  })

  it('记账：建分类 → 建交易 → 月度查询 → 更新 → 删除', async () => {
    const { userId } = await loginBySms()
    const cat = await accSvc.createCategory({ userId, type: 'EXPENSE', name: '交通' })
    const ledgers = await accSvc.getLedgers(userId)
    const txn = await accSvc.createTransaction(userId, {
      ledgerId: (ledgers[0] as any).id,
      categoryId: (cat as any).id,
      type: 'EXPENSE',
      amount: 25.5,
      transactionDate: Date.now(),
      remark: '地铁',
    } as any)
    expect(Number(txn.amount)).toBe(25.5)

    const month = new Date()
    const list = await accSvc.getTransactionsByMonth(userId, (ledgers[0] as any).id, month.getFullYear(), month.getMonth() + 1)
    expect(list.some((t: any) => t.id === txn.id)).toBe(true)

    const updated = await accSvc.updateTransaction(userId, txn.id as number, { amount: 30 } as any)
    expect(Number(updated.amount)).toBe(30)

    await accSvc.deleteTransaction(userId, txn.id as number)
    await expect(accSvc.getTransactionById(userId, txn.id as number)).rejects.toThrow('记录不存在')
  })
})

afterAll(async () => {
  // 清理本轮创建的测试用户（session/account 经外键级联）
  for (const id of createdUserIds) {
    await db.delete(user).where(eq(user.id, id)).catch(() => {})
  }
  await (await import('../../server/database/db.ts')).pool.end().catch(() => {})
})
