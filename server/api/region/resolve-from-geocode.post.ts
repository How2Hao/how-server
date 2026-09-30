import type { ResolveFromGeocodeBody } from '~/server/utils/services/region.ts'
// POST /region/resolve-from-geocode：把客户端反向地理编码候选名权威映射成 regionCode（公开接口）
import { defineHandler } from 'nitro'
import { readJson } from '~/server/utils/request.ts'
import { respond } from '~/server/utils/response.ts'
import { resolveFromGeocode } from '~/server/utils/services/region.ts'

export default defineHandler(async (event) => {
  const body = await readJson<ResolveFromGeocodeBody>(event)
  return respond(() => resolveFromGeocode({
    city: body.city as string | undefined,
    region: body.region as string | undefined,
    subregion: body.subregion as string | undefined,
    district: body.district as string | undefined,
    isoCountryCode: body.isoCountryCode as string | undefined,
  }))
})
