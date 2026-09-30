// 阿里云号码认证服务（dypnsapi）：发送/校验短信验证码（与旧系统一致）

import * as RPCClient from '@alicloud/pop-core'

export interface AliyunSmsConfig {
  accessKeyId: string
  accessKeySecret: string
  signName: string
  templateCode?: string
  templateParam?: string
}

export interface SendSmsResult { bizId: string }
export interface CheckSmsResult { pass: boolean }

function buildClient(config: AliyunSmsConfig) {
  return new (RPCClient as any)({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    endpoint: 'https://dypnsapi.aliyuncs.com',
    apiVersion: '2017-05-25',
  })
}

export async function aliyunSendSmsVerifyCode(
  phone: string,
  config: AliyunSmsConfig,
): Promise<SendSmsResult> {
  const client = buildClient(config)
  const templateParam = config.templateParam || JSON.stringify({ code: '##code##', min: '5' })
  const params: Record<string, any> = {
    PhoneNumber: phone,
    CodeLength: 6,
    ValidTime: 300,
  }
  params.SignName = config.signName
  if (config.templateCode) {
    params.TemplateCode = config.templateCode
    params.TemplateParam = templateParam
  }

  const res: any = await client.request('SendSmsVerifyCode', params, { method: 'POST' })

  if (res.Code !== 'OK') {
    throw new Error(`短信发送失败: ${res.Message || res.Code}`)
  }

  const bizId = res?.Model?.BizId
  if (!bizId) {
    throw new Error('短信服务返回数据异常，缺少 BizId')
  }

  return { bizId }
}

export async function aliyunCheckSmsVerifyCode(
  phone: string,
  code: string,
  config: AliyunSmsConfig,
): Promise<CheckSmsResult> {
  const client = buildClient(config)

  const res: any = await client.request(
    'CheckSmsVerifyCode',
    {
      PhoneNumber: phone,
      VerifyCode: code,
    },
    { method: 'POST' },
  )

  if (res.Code !== 'OK') {
    throw new Error(`验证码校验请求失败: ${res.Message || res.Code}`)
  }

  return { pass: res?.Model?.VerifyResult === 'PASS' }
}
