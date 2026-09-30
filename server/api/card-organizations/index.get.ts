import { defineHandler } from 'nitro'
import { respond } from '~/server/utils/response.ts'
import { getCardOrganizationOptions } from '~/server/utils/services/card-organization.ts'

/** 卡组织字典（组合组织展开 memberOrgIds / logos） */
export default defineHandler(async () => {
  return respond(() => getCardOrganizationOptions())
})
