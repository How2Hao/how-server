// 信用卡等级字典（移植自旧 src/service/card_level.ts）
import { asc } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { cardLevel } from '~/server/database/schema/plaza.ts'

export interface CardLevelOptionVo {
  id: string
  name: string
}

export async function getCardLevels(): Promise<CardLevelOptionVo[]> {
  const rows = await db.select().from(cardLevel).orderBy(asc(cardLevel.id))
  return rows.map(row => ({
    id: String(row.id),
    name: row.name,
  }))
}
