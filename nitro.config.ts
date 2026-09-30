import { fileURLToPath } from 'node:url'
import { defineConfig } from 'nitro'

/**
 * 旧版 how-api 的接口是根路径（无 /api 前缀）。
 * 规范路径已在 server/api/ 下挂 /api 前缀；这里把旧根路径整体代理到 /api/* 做过渡兼容：
 * proxy（而非 redirect）会原样保留 HTTP 方法、请求体与响应状态，移动端无需跟随重定向。
 */
const legacyApiPrefixes = [
  'auth',
  'acc',
  'task',
  'task-template',
  'job-template',
  'bank',
  'bank_card',
  'bank_card_template',
  'benefit-category',
  'benefit-usage-platform',
  'card-levels',
  'card-organizations',
  'coupon',
  'coupon-category',
  'activity-category',
  'notification',
  'feedback',
  'upload',
  'user',
  'app-release',
  'region',
  'internal',
  'plaza',
]

const legacyRewrites = Object.fromEntries(
  legacyApiPrefixes.flatMap(p => [
    [`/${p}`, { proxy: `/api/${p}` }],
    [`/${p}/**`, { proxy: `/api/${p}/**` }],
  ]),
)

export default defineConfig({
  serverDir: './server',
  compatibilityDate: '2026-09-30',
  errorHandler: './server/error-handler.ts',
  // 纯 API 服务：未匹配路径不应落入 HTML 渲染器（生产构建中渲染器会挂起），统一 404
  renderer: false,
  // tsconfig paths 的 ~/* 别名对 tsc 有效，rolldown 打包需要这里的显式 alias
  alias: {
    '~': fileURLToPath(new URL('./', import.meta.url)),
  },
  routeRules: {
    ...legacyRewrites,
    // 与旧系统一致：全站放行 CORS（origin: *）
    '/**': { cors: { origin: '*' } },
  },
})
