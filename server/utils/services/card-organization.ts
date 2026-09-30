// 卡组织字典（移植自旧 src/service/card_organization.ts）：支持组合组织，logos 由成员组织展开
import { asc } from 'drizzle-orm'
import { db } from '~/server/database/db.ts'
import { cardOrganization } from '~/server/database/schema/plaza.ts'

export interface CardOrganizationOptionVo {
  id: string
  name: string
  memberOrgIds: string[]
  supportedCardTypes: string[]
  logos: string[]
  status: string
}

export function parseCsv(raw: string | null | undefined): string[] {
  if (!raw || typeof raw !== 'string')
    return []
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

export async function getCardOrganizationOptions(): Promise<CardOrganizationOptionVo[]> {
  const rows = await db.select().from(cardOrganization).orderBy(asc(cardOrganization.id))

  const orgById = new Map<string, typeof cardOrganization.$inferSelect>(
    rows.map(row => [String(row.id), row]),
  )

  return rows.map(row => ({
    id: String(row.id),
    name: row.name,
    memberOrgIds: parseCsv(row.memberOrgIds),
    supportedCardTypes: parseCsv(row.supportedCardTypes).map(item => item.toUpperCase()),
    logos: (() => {
      // 组合组织：logos 取各成员组织的 logo；单组织：取自身 logo
      const members = parseCsv(row.memberOrgIds)
      if (members.length > 0) {
        return members
          .map(id => orgById.get(id)?.logo || '')
          .map(item => item.trim())
          .filter(Boolean)
      }
      const ownLogo = (row.logo || '').trim()
      return ownLogo ? [ownLogo] : []
    })(),
    status: (row.status || 'ENABLED').trim().toUpperCase() || 'ENABLED',
  }))
}
