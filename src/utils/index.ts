import { createHash } from 'node:crypto';

/**
 * md5加密
 */
export function md5Encrypt(input: string) {
  // 创建一个 MD5 哈希对象
  const hash = createHash('md5');

  // 更新哈希对象的内容（输入需要是字符串或 Buffer）
  hash.update(input);

  // 计算并返回加密后的结果（以十六进制格式输出）
  return hash.digest('hex');
}
