// ali-oss 未提供类型声明（@types/ali-oss 未安装），这里声明为 any 以通过 tsc。
// 只用到 new OSS(options) + client.signatureUrl(key, options)
declare module 'ali-oss'
