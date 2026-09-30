// 环境配置：集中读取 process.env，提供与旧版 how-api 相同的默认值
import process from 'node:process'

function str(key: string, fallback = ''): string {
  const v = process.env[key]
  return v === undefined || v === '' ? fallback : v
}

function num(key: string, fallback: number): number {
  const v = Number(process.env[key])
  return Number.isFinite(v) && process.env[key] !== '' && process.env[key] !== undefined ? v : fallback
}

const ACCESS_TOKEN_TTL_SECONDS = num('AUTH_ACCESS_TOKEN_TTL_SECONDS', 7200)
const REFRESH_TOKEN_TTL_SECONDS = num('AUTH_REFRESH_TOKEN_TTL_SECONDS', 60 * 60 * 24 * 30)

export const config = {
  nodeEnv: () => str('NODE_ENV', 'development'),
  isLocal: () => str('NODE_ENV') === 'local' || str('NODE_ENV') === 'development',
  db: {
    get host() { return str('DB_HOST', '127.0.0.1') },
    get port() { return num('DB_PORT', 3306) },
    get username() { return str('DB_USERNAME', 'root') },
    get password() { return str('DB_PASSWORD', '') },
    get database() { return str('DB_DATABASE', 'how2hao_api') },
  },
  auth: {
    /** 兼容旧系统：JWT 密钥沿用 AUTH_JWT_SECRET，BETTER_AUTH_SECRET 未设置时也用它 */
    get jwtSecret() { return str('AUTH_JWT_SECRET', 'how2hao-local-jwt-secret-change-me') },
    get betterAuthSecret() { return str('BETTER_AUTH_SECRET', str('AUTH_JWT_SECRET', 'how2hao-local-jwt-secret-change-me')) },
    get baseURL() { return str('BETTER_AUTH_URL', str('APP_BASE_URL', 'http://localhost:3000')) },
    accessTokenTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: REFRESH_TOKEN_TTL_SECONDS,
    get smsProvider() { return str('AUTH_SMS_PROVIDER', 'MOCK_PROVIDER') },
  },
  aliyun: {
    get accessKeyId() { return str('ALIYUN_ACCESS_KEY_ID') },
    get accessKeySecret() { return str('ALIYUN_ACCESS_KEY_SECRET') },
    get smsSignName() { return str('ALIYUN_SMS_SIGN_NAME') },
    get smsTemplateCode() { return str('ALIYUN_SMS_TEMPLATE_CODE') },
  },
  oss: {
    get bucket() { return str('OSS_BUCKET', 'how2hao-static') },
    get region() { return str('OSS_REGION', 'oss-cn-beijing') },
    get publicBaseUrl() { return str('OSS_PUBLIC_BASE_URL', '') },
    get feedbackBucket() { return str('OSS_FEEDBACK_BUCKET', 'how2hao-user') },
  },
  bankCardVision: {
    get dashscopeApiKey() { return str('DASHSCOPE_API_KEY') },
    get dashscopeHost() { return str('DASHSCOPE_HOST', 'https://dashscope.aliyuncs.com') },
    get qwenVisionModel() { return str('QWEN_VISION_MODEL', 'qwen3-vl-plus') },
    get qwenTextModel() { return str('QWEN_TEXT_MODEL', 'qwen-plus') },
    get zhipuApiKey() { return str('ZHIPU_API_KEY') },
    get zhipuVisionModel() { return str('ZHIPU_VISION_MODEL', 'glm-4.6v-flash') },
    get geminiApiKey() { return str('GEMINI_API_KEY') },
    get geminiVisionModel() { return str('GEMINI_VISION_MODEL', 'gemini-flash-latest') },
    get geminiHost() { return str('GEMINI_HOST', 'https://generativelanguage.googleapis.com') },
    get coverCanvas() { return str('BANK_CARD_COVER_CANVAS', 'square_1000_fit') },
    get coverBboxOrder() { return str('BANK_CARD_COVER_BBOX_ORDER', 'xmin_ymin_xmax_ymax') },
    get coverPreviewPath() { return str('BANK_CARD_COVER_PREVIEW_PATH', '') },
    get sourceImageUrl() { return str('BANK_CARD_SOURCE_IMAGE_URL', '') },
  },
  qwenImageEdit: {
    get model() { return str('QWEN_IMAGE_EDIT_MODEL', 'qwen-image-edit') },
    get timeoutMs() { return num('QWEN_IMAGE_EDIT_TIMEOUT_MS', 120000) },
    get maxInputBytes() { return num('QWEN_IMAGE_EDIT_MAX_INPUT_BYTES', 10 * 1024 * 1024) },
  },
  wanxImageEdit: {
    get model() { return str('WANX_IMAGE_EDIT_MODEL', 'wanx2.1-imageedit') },
    get function_() { return str('WANX_IMAGE_EDIT_FUNCTION', 'stylization_all') },
    get timeoutMs() { return num('WANX_IMAGE_EDIT_TIMEOUT_MS', 120000) },
    get pollIntervalMs() { return num('WANX_IMAGE_EDIT_POLL_INTERVAL_MS', 2000) },
    get maxInputBytes() { return num('WANX_IMAGE_EDIT_MAX_INPUT_BYTES', 10 * 1024 * 1024) },
  },
}

export type AppConfig = typeof config
