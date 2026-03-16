import { v2 as cloudinary } from 'cloudinary'
import { config } from '../config'

const CLOUDINARY_FOLDER = 'vorton-products'
const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes

let cachedPublicIds: Set<string> | null = null
let cacheTs = 0

function toPublicIdNormalized(s: string): string {
  if (!s || typeof s !== 'string') return ''
  const base = s.trim().replace(/^\//, '').replace(/\.[^.]+$/, '')
  let n = base.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase()
  const m = n.match(/^(.+)-\d+$/)
  if (m) n = m[1]
  return n
}

function filenameToPublicId(s: string): string {
  if (!s || typeof s !== 'string') return ''
  const base = s.trim().replace(/^\//, '').replace(/\.[^.]+$/, '')
  return base.replace(/\s*-\s*/g, '-')
}

/**
 * Fetch all image public_ids from Cloudinary vorton-products folder.
 * Caches for 15 min. Returns empty set if API not configured or fails.
 */
export async function getExistingImagePublicIds(): Promise<Set<string>> {
  const { cloudName, apiKey, apiSecret } = config.cloudinary
  if (!cloudName || !apiKey || !apiSecret) {
    return new Set()
  }

  if (cachedPublicIds && Date.now() - cacheTs < CACHE_TTL_MS) {
    return cachedPublicIds
  }

  try {
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret })
    const set = new Set<string>()
    let cursor: string | undefined

    do {
      const result = await cloudinary.api.resources({
        type: 'upload',
        prefix: `${CLOUDINARY_FOLDER}/`,
        max_results: 500,
        next_cursor: cursor,
      }) as { resources?: Array<{ public_id: string }>; next_cursor?: string }

      const resources = result.resources ?? []
      for (const r of resources) {
        const pid = r.public_id ?? ''
        const suffix = pid.startsWith(`${CLOUDINARY_FOLDER}/`)
          ? pid.slice(CLOUDINARY_FOLDER.length + 1)
          : pid
        if (!suffix) continue
        set.add(suffix)
        set.add(suffix.toLowerCase())
        const normalized = toPublicIdNormalized(suffix)
        if (normalized) set.add(normalized)
        const fileId = filenameToPublicId(suffix)
        if (fileId) set.add(fileId)
      }
      cursor = result.next_cursor
    } while (cursor)

    cachedPublicIds = set
    cacheTs = Date.now()
    console.log('[cloudinary] Cached', set.size, 'image public_ids from', CLOUDINARY_FOLDER)
    return set
  } catch (err) {
    console.warn('[cloudinary] Failed to list resources:', (err as Error).message)
    return new Set()
  }
}

/**
 * Check if a public_id exists in Cloudinary (by normalized/suffix match).
 */
export function publicIdExistsInSet(publicId: string, existingIds: Set<string>): boolean {
  if (!publicId || existingIds.size === 0) return false
  const normalized = toPublicIdNormalized(publicId)
  return (
    existingIds.has(publicId) ||
    existingIds.has(publicId.toLowerCase()) ||
    (normalized ? existingIds.has(normalized) : false)
  )
}
