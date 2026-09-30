# how-server

「i羊毛」（how2hao）后端 API —— 由旧版 Midway.js + TypeORM 项目 [how-api](../how-api) 重构而来的全新服务端。

## 技术栈

| 层 | 选型 |
| --- | --- |
| HTTP 框架 | [Nitro v3](https://nitro.build)（[h3 v2](https://h3.dev)，web 标准 Request/Response） |
| ORM | [Drizzle ORM](https://orm.drizzle.team) + mysql2 |
| 认证 | [better-auth](https://better-auth.com)（用户/会话/第三方账号模型 + bcrypt 密码原语） |
| 测试 | [vitest](https://vitest.dev) |
| 构建 | Rolldown（`nitro build`） |

## 快速开始

```bash
pnpm install
cp .env.example .env         # 配置 DB_* 与 AUTH_JWT_SECRET 等
pnpm exec drizzle-kit push   # 空库建表（生产库勿跑，见「从 how-api 迁移」）
pnpm dev                     # http://localhost:3000
pnpm test                    # vitest（单测 + 集成测试）
pnpm build && pnpm preview   # 生产构建与本地预览
```

集成测试要求一个名为 `*_test` 后缀的 MySQL 库（默认 `how2hao_api_test`，可用 `DB_DATABASE` 覆盖），
测试文件会强制校验库名后缀，防止误连真实库：

```bash
mysql -uroot -e "CREATE DATABASE how2hao_api_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
pnpm exec drizzle-kit push --url "mysql://root@127.0.0.1:3306/how2hao_api_test"
pnpm exec vitest run tests/integration
```

## 目录结构

```
auth.ts                  # better-auth 实例（用户/会话/账号模型映射到 users/session/account 表）
drizzle.config.ts        # drizzle-kit 配置
migrations/              # 从 how-api 切换的手工迁移 SQL
server/
  database/
    db.ts                # mysql2 连接池 + drizzle 实例（全局单例）
    schema/              # 45 张表的 Drizzle schema（列名/类型与旧库逐列对齐）
      auth.ts            # users（better-auth user 模型）/ session / account / verification / 短信审计
      acc.ts             # 记账域
      task.ts            # 任务/模板/Job 域
      plaza.ts           # 银行/卡模板/字典域
      notification.ts    # 通知/反馈/设置/配额/功能开关
  middleware/auth.ts     # 全局鉴权中间件（路径前缀白名单 + Bearer JWT 解析，语义同旧系统）
  plugins/warmup.ts      # 启动时预热字典缓存
  error-handler.ts       # 统一错误响应（{ success, message, data }）
  utils/                 # config / response / jwt / session / auth-guard / request / types
  utils/services/        # 业务服务层（纯函数模块，对应旧 service/）
  api/                   # 114 个接口路由（规范路径 /api/*，文件名 = 方法后缀路由）
  routes/                # 根路径页面：/ 健康检查、/privacy、/support、/agreement（HTML）
  assets/all.png         # 银行卡识别调试图（经 assets:server 挂载读取）
tests/
  unit/                  # 纯逻辑单测（解析器/日历计算/匹配规则/设置合并等）
  integration/           # 真实 MySQL 端到端测试（认证/会话轮换/任务/记账/注销）
```

## 路径规范与旧路径兼容

- 接口的规范路径是 **`/api/*`**（处理器在 `server/api/`，遵循 Nitro 约定）。
- 旧版 how-api 的接口是根路径（无前缀）。`nitro.config.ts` 用 routeRules 把 23 个旧前缀
  **代理（rewrite）** 到 `/api/*`：`proxy` 会原样保留 HTTP 方法、请求体与响应状态，
  旧客户端无需跟随重定向即可继续使用根路径。中间件白名单对两种前缀均生效。
- 法律页面（/privacy 等）与健康检查（/）保留在根路径（`server/routes/`），不走 `/api`。
- 全部客户端迁移到 `/api/*` 后，删除 `nitro.config.ts` 中的 `legacyRewrites` 即完成下线。
- 已知修复（有意偏离旧代码处）：
  - 新用户默认账本 icon 改为 emoji `📒`（旧代码写入 URL，超过 `acc_ledgers.icon` varchar(20)，
    在严格 sql_mode 下报错；真实库数据均为 emoji）。
  - 短信审核 bypass（`13800000000`/`888888`）与 `MOCK_PROVIDER` 按旧逻辑保留。
  - `renderer: false`：纯 API 服务禁用 HTML 渲染器（生产构建中未匹配路径落入渲染器会挂起），
    未匹配的 `/api/*` 返回统一 404 结构（`server/api/[...].ts`）。

## 与旧系统的兼容约定

- **API 契约完全保留**：114 个端点的路径、请求/响应结构、错误文案与旧系统逐一对应
  （`{ success, message, data }` 包装、业务错误 HTTP 200、鉴权失败 401、
  `/job-template` 与 `/coupon` 未登录时返回 200 + `success:false`、
  `/benefit-usage-platform` 裸返回、`/internal/card-cover` 公开等历史行为均已保留）。
- **accessToken 二进制兼容**：仍是自签 HS256 JWT（payload `{ sub, uid6, sid, iat, exp }`，
  密钥沿用 `AUTH_JWT_SECRET`）；**refreshToken 换用 better-auth session 表**（token 30 天，
  refresh 时轮换），旧 `user_session` 的 refresh token 经迁移脚本平移后可继续刷新。
- **密码兼容**：旧 `users.password_hash`（bcrypt, rounds=10）迁移到 better-auth
  `account` 表（providerId=`credential`），验证仍走 bcrypt。
- **第三方身份**：旧 `user_identities` → better-auth `account`（PHONE_SMS/WECHAT/APPLE，
  accountId 沿用旧的 providerUid 组装规则）。
- **Schema 对齐**：Drizzle schema 按旧库逐列定义（含 `user_feedback` 的 camelCase 列名、
  bigint 毫秒时间戳、MySQL ENUM、`acc_*` 外键等），不使用 `synchronize`，不跑自动迁移改生产库。

## 从 how-api 迁移（cutover）

1. 停写旧版 how-api，备份 `how2hao_api` 库。
2. 执行 `migrations/001_better_auth_cutover.sql`（幂等，可重复执行）：
   - 创建 better-auth 三表 `session` / `account` / `verification`；
   - `users` 表增加 `email` / `email_verified`，`created_at`/`updated_at` 由 bigint 毫秒转为 datetime；
   - `user_identities` → `account`、`users.password_hash` → `account`（credential）、
     未撤销的 `user_session` → `session`（旧 refreshToken 无感续用）。
3. 部署本服务（环境变量见 `.env.example`），观察期后可删除
   `user_identities` / `user_session` / `users.password_hash`。

## 脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm preview` | Nitro 开发 / 构建 / 预览 |
| `pnpm test` | vitest（watch 模式，CI 用 `vitest run`） |
| `pnpm lint` / `pnpm lint:fix` | ESLint（antfu 配置） |
| `pnpm exec drizzle-kit generate` | 依据 schema 生成迁移 SQL（新表变更时） |

## 说明

- 短信：`AUTH_SMS_PROVIDER=MOCK_PROVIDER`（开发，任意 6 位验证码）或 `ALIYUN_DYPNS`（阿里云号码认证）。
- AI 能力（银行卡识别 / 账单解析 LLM 兜底 / 卡面生成 / 优惠券 OCR）经 `fetch()` 调用
  DashScope / 智谱 / Gemini，密钥见 `.env.example`；未配置时对应端点返回业务错误而非崩溃。
- APNs 推送发送不在本服务（与旧系统一致，由 admin 项目负责；本服务只管理 device token 与收件箱）。
- 旧仓库中的运维脚本（`scripts/migrate_*.sql`、爬虫等）未迁移，保留在 how-api 仓库中执行。
