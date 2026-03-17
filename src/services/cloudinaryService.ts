import { v2 as cloudinary } from 'cloudinary'
import { config } from '../config'

const CLOUDINARY_FOLDER = 'vorton-products'
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

let cachedPublicIds: Set<string> | null = null
let cachedVersionMap: Map<string, number> | null = null
let cacheTs = 0

export type CloudinaryImageData = {
  existingIds: Set<string>
  versionMap: Map<string, number>
}

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
 * Fetch all image public_ids and versions from Cloudinary vorton-products folder.
 * Caches for 5 min. Returns empty set if API not configured or fails.
 */
export async function getExistingImagePublicIds(): Promise<Set<string>> {
  const data = await getCloudinaryImageData()
  return data.existingIds
}

/**
 * Fetch image data (public_ids + versions) for cache-busting URLs.
 * Version in URL ensures browser shows updated images when replaced in Cloudinary.
 */
export async function getCloudinaryImageData(): Promise<CloudinaryImageData> {
  const { cloudName, apiKey, apiSecret } = config.cloudinary
  const empty: CloudinaryImageData = { existingIds: new Set(), versionMap: new Map() }
  if (!cloudName || !apiKey || !apiSecret) return empty

  if (cachedPublicIds && cachedVersionMap && Date.now() - cacheTs < CACHE_TTL_MS) {
    return { existingIds: cachedPublicIds, versionMap: cachedVersionMap }
  }

  try {
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret })
    const set = new Set<string>()
    const versionMap = new Map<string, number>()
    let cursor: string | undefined

    do {
      const result = await cloudinary.api.resources({
        type: 'upload',
        prefix: `${CLOUDINARY_FOLDER}/`,
        max_results: 500,
        next_cursor: cursor,
      }) as { resources?: Array<{ public_id: string; version?: number }>; next_cursor?: string }

      const resources = result.resources ?? []
      for (const r of resources) {
        const pid = r.public_id ?? ''
        const suffix = pid.startsWith(`${CLOUDINARY_FOLDER}/`)
          ? pid.slice(CLOUDINARY_FOLDER.length + 1)
          : pid
        if (!suffix) continue
        const version = r.version ?? 0
        set.add(suffix)
        set.add(suffix.toLowerCase())
        versionMap.set(suffix, version)
        versionMap.set(suffix.toLowerCase(), version)
        const normalized = toPublicIdNormalized(suffix)
        if (normalized) {
          set.add(normalized)
          if (!versionMap.has(normalized)) versionMap.set(normalized, version)
        }
        const fileId = filenameToPublicId(suffix)
        if (fileId) {
          set.add(fileId)
          if (!versionMap.has(fileId)) versionMap.set(fileId, version)
        }
      }
      cursor = result.next_cursor
    } while (cursor)

    cachedPublicIds = set
    cachedVersionMap = versionMap
    cacheTs = Date.now()
    console.log('[cloudinary] Cached', set.size, 'image public_ids + versions from', CLOUDINARY_FOLDER)
    return { existingIds: set, versionMap }
  } catch (err) {
    console.warn('[cloudinary] Failed to list resources:', (err as Error).message)
    return empty
  }
}

/**
 * Get version for a public_id (for cache-busting URLs). Returns undefined if not found.
 * Uses only exact/lowercase match - never normalized, to avoid using another image's version (causes 404).
 */
export function getVersionForPublicId(publicId: string, versionMap: Map<string, number>): number | undefined {
  if (!publicId || versionMap.size === 0) return undefined
  const v = versionMap.get(publicId) ?? versionMap.get(publicId.toLowerCase())
  if (v != null) return v
  const fileId = filenameToPublicId(publicId)
  if (fileId && fileId !== publicId) {
    const v2 = versionMap.get(fileId) ?? versionMap.get(fileId.toLowerCase())
    if (v2 != null) return v2
  }
  return undefined
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
