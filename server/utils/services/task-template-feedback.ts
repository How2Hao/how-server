// 活动详情页用户反馈：追加一条 task_template_feedback（不去重）
// 移植自旧 how-api src/service/task_template_feedback.ts
import { eq } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { taskTemplate, taskTemplateFeedback } from '~/server/database/schema/task.ts'

/** 旧服务返回保存后的实体行；这里以相同字段形状返回 */
export interface TaskTemplateFeedbackRow {
  id: number
  userId: number
  taskTemplateId: number
  content: string
  createdAt: Date
}

export async function submit(userId: number, templateId: number, content: string): Promise<TaskTemplateFeedbackRow> {
  const trimmed = (content ?? '').trim()
  if (!trimmed)
    throw new Error('反馈内容不能为空')
  if (trimmed.length > 500)
    throw new Error('反馈内容最多 500 字')
  if (!Number.isInteger(templateId) || templateId <= 0)
    throw new Error('活动 ID 不合法')

  const [tpl] = await db.select({ id: taskTemplate.id }).from(taskTemplate).where(eq(taskTemplate.id, templateId)).limit(1)
  if (!tpl)
    throw new Error('活动不存在')

  const now = new Date()
  const [row] = await db.insert(taskTemplateFeedback).values({
    userId,
    taskTemplateId: templateId,
    content: trimmed,
    createdAt: now,
  }).$returningId()

  return {
    id: Number(row.id),
    userId,
    taskTemplateId: templateId,
    content: trimmed,
    createdAt: now,
  }
}
