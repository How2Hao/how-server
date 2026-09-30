// OSS 预签名（移植自旧 src/service/oss.ts）：客户端 PUT 直传阿里云 OSS

import * as OSS from 'ali-oss'
import { config } from '~/server/utils/config.ts'

export interface AvatarPresignResult {
  uploadUrl: string
  publicUrl: string
  key: string
  contentType: string
}

function sanitizeExt(ext: string): string {
  return ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg'
}

function sanitizeFolder(folder: string): string {
  return folder.replace(/[^\w-]/g, '') || 'uploads'
}

function datestamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '')
}

function buildClient(bucket?: string): any {
  return new (OSS as any)({
    accessKeyId: config.aliyun.accessKeyId,
    accessKeySecret: config.aliyun.accessKeySecret,
    bucket: bucket ?? config.oss.bucket,
    region: config.oss.region,
    // 让 signatureUrl 生成 https:// 链接。iOS ATS 严格禁 http，
    // expo-file-system 的 uploadAsync 走原生 NSURLSession 直接被拦。
    secure: true,
  })
}

function buildPresignedUrl(bucket: string, key: string, ext: string): AvatarPresignResult {
  const safeExt = sanitizeExt(ext)
  const contentType = `image/${safeExt === 'jpg' ? 'jpeg' : safeExt}`
  const client = buildClient(bucket)
  const uploadUrl = client.signatureUrl(key, {
    'expires': 300,
    'method': 'PUT',
    'Content-Type': contentType,
  })
  const publicUrl = `https://${bucket}.${config.oss.region}.aliyuncs.com/${key}`
  return { uploadUrl, publicUrl, key, contentType }
}

/** 路径: avatars/{uid6}/{YYYYMMDD}_{timestamp}.{ext} */
export function presignAvatarUpload(uid6: string, ext = 'jpg'): AvatarPresignResult {
  const safeExt = sanitizeExt(ext)
  const key = `avatars/${uid6}/${datestamp()}_${Date.now()}.${safeExt}`
  return buildPresignedUrl(config.oss.bucket, key, safeExt)
}

/** 路径: feedback/{uid6}/{YYYYMMDD}_{timestamp}.{ext} */
export function presignFeedbackUpload(uid6: string, ext = 'jpg'): AvatarPresignResult {
  const safeExt = sanitizeExt(ext)
  const key = `feedback/${uid6}/${datestamp()}_${Date.now()}.${safeExt}`
  return buildPresignedUrl(config.oss.feedbackBucket, key, safeExt)
}

/** 通用用户内容。路径: {folder}/{uid6}/{YYYYMMDD}_{timestamp}.{ext} */
export function presignUserContentUpload(uid6: string, folder: string, ext = 'jpg'): AvatarPresignResult {
  const safeFolder = sanitizeFolder(folder)
  const safeExt = sanitizeExt(ext)
  const key = `${safeFolder}/${uid6}/${datestamp()}_${Date.now()}.${safeExt}`
  return buildPresignedUrl(config.oss.feedbackBucket, key, safeExt)
}
