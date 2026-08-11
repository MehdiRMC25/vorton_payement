import { MongoClient, ObjectId } from 'mongodb'
import { config } from '../config'
import {
  getCloudinaryImageData,
  getVersionForPublicId,
  publicIdExistsInSet,
} from './cloudinaryService'

let mongoClient: MongoClient | null = null
let productsCollection: import('mongodb').Collection | null = null
let indexesCreated = false

const CACHE_TTL_MS = 60 * 1000
/** Bump when normalized product shape changes so stale entries are not reused. */
const PRODUCTS_CACHE_VERSION = 5
const serverCache: {
  all: { data: Record<string, unknown>[]; ts: number; v: number } | null
  byCategory: Record<string, { data: Record<string, unknown>[]; ts: number; v: number }>
  byId: Record<string, { data: Record<string, unknown>; ts: number; v: number }>
} = {
  all: null,
  byCategory: {},
  byId: {},
}

const PROJECTION = {
  _id: 1, sku: 1, skuColor: 1, id: 1,
  name: 1, Name: 1, ADI: 1, productName: 1, product_name: 1, productTitle: 1, product_title: 1,
  'Product Name': 1, 'Product Title': 1,
  title: 1, Title: 1, description: 1, itemName: 1, item_name: 1,
  nameAz: 1, nameAZ: 1, NameAz: 1,
  /** Azerbaijani: DB uses descriptionAz; descriptionAZ kept for older docs */
  descriptionAz: 1, descriptionAZ: 1,
  /** English: common casing variants (Mongo field names are case-sensitive) */
  descriptionEn: 1, descriptionEN: 1, description_en: 1,
  category: 1, gender: 1, Sex: 1,
  color: 1, Color: 1, colour: 1, Colour: 1, Rəngi: 1,
  fabric: 1, Fabric: 1, material: 1, Material: 1, fabricType: 1, FabricType: 1, 'Fabric Type': 1,
  price: 1, discountedPrice: 1,
  sizes: 1, Sizes: 1, Size: 1, size: 1, size_options: 1, availableSizes: 1, available_sizes: 1, sizeOptions: 1, 'Available Sizes': 1,
  image: 1, images: 1, imageUrls: 1, imageList: 1,
  imageUrl: 1, imagePublicId: 1,
  videoUrl: 1, video: 1,
  isNewCollection: 1, is_new_collection: 1, IsNewCollection: 1, newCollection: 1,
  isDiscounted: 1, is_discounted: 1,
  Display: 1, display: 1,
  'Stok Toplam Miqdar': 1,
}

/** Only products marked online; explicitly exclude stock_only in all common variations. */
const STOCK_ONLY_VALUES = [
  'stock_only', 'stock only', 'Stock_Only', 'Stock Only',
  'stock-only', 'Stock-only', 'Stock-Only', 'STOCK_ONLY',
  'StockOnly', 'stockonly',
]
const DISPLAY_ONLINE_QUERY = {
  $and: [
    {
      $or: [
        { Display: 'online' },
        { Display: 'Online' },
        { display: 'online' },
      ],
    },
    {
      $and: [
        { Display: { $nin: STOCK_ONLY_VALUES } },
        { display: { $nin: STOCK_ONLY_VALUES } },
      ],
    },
  ],
}

/** Safety filter: exclude docs marked stock_only (catches any value not in MongoDB $nin). */
function isStockOnly(doc: Record<string, unknown>): boolean {
  const d = String(doc.Display ?? doc.display ?? '').trim().toLowerCase()
  if (!d) return false
  if (STOCK_ONLY_VALUES.some((v) => v.toLowerCase() === d)) return true
  const normalized = d.replace(/[\s\-_]/g, '')
  return normalized === 'stockonly'
}

/** Require Stok Toplam Miqdar >= 1 (number or numeric string from sheet sync). */
function hasPositiveStock(doc: Record<string, unknown>): boolean {
  const raw = doc['Stok Toplam Miqdar']
  const n = Number(String(raw ?? '').replace(',', '.').trim())
  return Number.isFinite(n) && n >= 1
}

function hasMongoUri(): boolean {
  return !!config.mongodbUri
}

function withCloudinaryTransform(url: string, transform: string): string {
  if (!url || !url.includes('/upload/')) return url
  return url.replace('/upload/', `/upload/${transform}/`)
}

/** Strip image extensions so .jpeg/.png mismatch between MongoDB and Cloudinary does not affect fetching. */
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?)(\?.*)?$/i
function filenameToPublicId(s: string): string {
  if (!s || typeof s !== 'string') return ''
  const base = s.trim().replace(/^\//, '').replace(IMAGE_EXT_RE, '')
  return base.replace(/\s*-\s*/g, '-')
}

function toPublicIdNormalized(s: string): string {
  if (!s || typeof s !== 'string') return ''
  const base = s.trim().replace(/^\//, '').replace(/\.[^.]+$/, '')
  let n = base.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase()
  const m = n.match(/^(.+)-\d+$/)
  if (m) n = m[1]
  return n
}

/** Primary public_id used for image URL (same order as normalize). Returns null for full URLs (cannot verify). */
function getPrimaryPublicIdForDoc(doc: Record<string, unknown>): string | null {
  const cloudBase = config.cloudinaryCloudName
      ? `https://res.cloudinary.com/${config.cloudinaryCloudName}/image/upload/vorton-products/`
      : ''
  if (!cloudBase) return null
  const color = String(doc.color ?? doc.Color ?? doc.colour ?? doc.Rəngi ?? '').trim()
  const skuColor = (String(doc.skuColor ?? '').trim()) || (doc.sku && color
      ? `${String(doc.sku).trim()}-${String(color).trim().replace(/\s+/g, '-')}`
      : '')
  if ((doc.imageUrl as string) || (typeof doc.image === 'string' && (doc.image as string).startsWith('http'))) {
    return null
  }
  if (typeof doc.image === 'string' && doc.image.trim()) {
    const pid = filenameToPublicId(doc.image)
    return pid || null
  }
  if (Array.isArray(doc.images) && doc.images[0]) {
    const pid = filenameToPublicId(String(doc.images[0]))
    return pid || null
  }
  if (skuColor) return toPublicIdNormalized(skuColor) || null
  if (doc.sku) return toPublicIdNormalized(String(doc.sku)) || null
  return toPublicIdNormalized(skuColor || String(doc.sku ?? '')) || null
}

function isCacheValid(entry: { ts: number; v: number } | null): boolean {
  return !!entry && entry.v === PRODUCTS_CACHE_VERSION && Date.now() - entry.ts < CACHE_TTL_MS
}

/** Filter products: only include if image exists in Cloudinary. When existingIds is empty, skip filter (backward compat). */
function passesImageFilter(product: Record<string, unknown>, primaryPublicId: string | null, existingIds: Set<string>): boolean {
  if (existingIds.size === 0) return true
  if (primaryPublicId === null) return true
  return publicIdExistsInSet(primaryPublicId, existingIds)
}

const CLOUDINARY_FOLDER = 'vorton-products'

/** Build Cloudinary URL with version for cache-busting when image is replaced. */
function buildCloudinaryImageUrl(
    publicId: string,
    versionMap: Map<string, number>
): string {
  const cloudName = config.cloudinaryCloudName
  if (!cloudName || !publicId) return ''
  const base = `https://res.cloudinary.com/${cloudName}/image/upload/`
  const version = getVersionForPublicId(publicId, versionMap)
  const path = version != null
      ? `v${version}/${CLOUDINARY_FOLDER}/${encodeURIComponent(publicId)}`
      : `${CLOUDINARY_FOLDER}/${encodeURIComponent(publicId)}`
  return base + path
}

async function getCollection(): Promise<{ collection: import('mongodb').Collection; client: MongoClient }> {
  const uri = config.mongodbUri
  if (!uri) throw new Error('MONGODB_URI not set')
  if (mongoClient && productsCollection) {
    return { collection: productsCollection, client: mongoClient }
  }
  const opts = uri.startsWith('mongodb+srv://')
      ? { serverSelectionTimeoutMS: 15000, autoSelectFamily: false }
      : {}
  mongoClient = new MongoClient(uri, opts)
  await mongoClient.connect()
  const db = mongoClient.db('vorton_app')
  productsCollection = db.collection('products')

  if (!indexesCreated) {
    try {
      await Promise.all([
        productsCollection.createIndex({ gender: 1 }),
        productsCollection.createIndex({ sku: 1 }),
        productsCollection.createIndex({ skuColor: 1 }),
        productsCollection.createIndex({ Display: 1 }),
      ])
      indexesCreated = true
      console.log('[products] MongoDB indexes ensured (gender, sku, skuColor, Display)')
    } catch (e) {
      console.warn('[products] Index creation skipped:', (e as Error).message)
    }
  }

  return { collection: productsCollection, client: mongoClient }
}

function normalize(doc: Record<string, unknown> | null, versionMap: Map<string, number>): Record<string, unknown> | null {
  if (!doc) return null
  const cloudBase = config.cloudinaryCloudName
      ? `https://res.cloudinary.com/${config.cloudinaryCloudName}/image/upload/vorton-products/`
      : ''
  const id = (doc._id ? String(doc._id) : doc.id) ?? ''
  const color = String(doc.color ?? doc.Color ?? doc.colour ?? doc.Rəngi ?? '').trim()
  const skuColor = (String(doc.skuColor ?? '').trim()) || (doc.sku && color
      ? `${String(doc.sku).trim()}-${String(color).trim().replace(/\s+/g, '-')}`
      : '')

  const buildUrl = (publicId: string) => buildCloudinaryImageUrl(publicId, versionMap) || cloudBase + encodeURIComponent(publicId)

  let image: string | null = (doc.imageUrl as string) || null
  if (!image && typeof doc.image === 'string' && (doc.image.startsWith('http://') || doc.image.startsWith('https://'))) {
    image = doc.image
  }
  if (!image && cloudBase && typeof doc.image === 'string' && doc.image.trim()) {
    const publicId = filenameToPublicId(doc.image)
    if (publicId) image = buildUrl(publicId)
  }
  if (!image && cloudBase && Array.isArray(doc.images) && doc.images[0]) {
    const publicId = filenameToPublicId(String(doc.images[0]))
    if (publicId) image = buildUrl(publicId)
  }
  if (!image && cloudBase && skuColor) {
    const publicId = toPublicIdNormalized(skuColor)
    if (publicId) image = buildUrl(publicId)
  }
  if (!image && cloudBase && doc.sku) {
    const publicId = toPublicIdNormalized(String(doc.sku))
    if (publicId) image = buildUrl(publicId)
  }
  if (!image && cloudBase) {
    const publicId = toPublicIdNormalized(skuColor || String(doc.sku ?? ''))
    if (publicId) image = buildUrl(publicId)
  }

  const rawSizes = doc.sizes ?? doc.Sizes ?? doc.availableSizes ?? doc.available_sizes ?? doc['Available Sizes'] ?? doc.sizeOptions ?? doc.size ?? doc.Size ?? doc.size_options
  let sizes: string[] = []
  if (Array.isArray(rawSizes) && rawSizes.length > 0) {
    sizes = rawSizes.map((s) => String(s).trim()).filter(Boolean)
  } else if (typeof rawSizes === 'string' && rawSizes.trim()) {
    const str = rawSizes.trim()
    if (str.startsWith('[')) {
      try {
        const parsed = JSON.parse(str)
        sizes = Array.isArray(parsed) ? parsed.map((s) => String(s).trim()).filter(Boolean) : str.split(',').map((s) => s.trim()).filter(Boolean)
      } catch {
        sizes = str.split(',').map((s) => s.trim()).filter(Boolean)
      }
    } else {
      sizes = str.split(',').map((s) => s.trim()).filter(Boolean)
    }
  }
  if (!hasPositiveStock(doc)) {
    sizes = []
  }
  const soldOut = !hasPositiveStock(doc) || sizes.length === 0

  const rawName = doc.name ?? doc.Name ?? doc.ADI ?? doc.productName ?? doc.product_name ?? doc.productTitle ?? doc.product_title
      ?? doc['Product Name'] ?? doc['Product Title']
      ?? doc.title ?? doc.Title ?? doc.description ?? doc.itemName ?? doc.item_name ?? ''
  const name = String(rawName).trim()
  const strField = (v: unknown): string => {
    if (v == null) return ''
    if (typeof v === 'string') return v.trim()
    return String(v).trim()
  }
  const nameAz = strField(doc.nameAz ?? doc.nameAZ ?? doc.NameAz)
  const descriptionEn = strField(
      doc.descriptionEn ?? doc.descriptionEN ?? doc.description_en
  )
  const descriptionAZ = strField(doc.descriptionAz ?? doc.descriptionAZ)
  const rawFabric = doc.fabric ?? doc.Fabric ?? doc.material ?? doc.Material ?? doc.fabricType ?? doc.FabricType ?? doc['Fabric Type'] ?? ''
  const fabric = String(rawFabric).trim() || 'Not specified'

  const rawImages = doc.images ?? doc.imageUrls ?? doc.imageList
  let images: string[] = []
  if (Array.isArray(rawImages) && rawImages.length > 0) {
    images = rawImages
        .filter((u): u is string => typeof u === 'string' && !!u.trim())
        .map((u) => {
          const s = u.trim().replace(/^\//, '')
          if (s.startsWith('http://') || s.startsWith('https://')) return s
          if (cloudBase) {
            const publicId = filenameToPublicId(s)
            return publicId ? buildUrl(publicId) : null
          }
          return null
        })
        .filter((x): x is string => !!x)
  }
  if (images.length > 0 && !image) image = images[0]
  if (images.length === 0 && image) images = [image]

  const thumb = image ? withCloudinaryTransform(image, 'w_400,q_auto,f_auto') : undefined
  const detail = image ? withCloudinaryTransform(image, 'w_800,q_auto,f_auto') : undefined
  const videoUrl = (doc.videoUrl ?? doc.video ?? '')?.toString().trim() || undefined
  const isNewCollection = !!(doc.isNewCollection === true || doc.is_new_collection === true || doc.IsNewCollection === true || doc.newCollection === true)

  return {
    id: String(id || ''),
    sku: String(doc.sku ?? ''),
    skuColor: skuColor || undefined,
    name: name || String(doc.sku ?? ''),
    nameAz: nameAz || undefined,
    descriptionEn: descriptionEn || undefined,
    /** Azerbaijani body copy (Mongo: descriptionAz); alias keys for clients */
    descriptionAZ: descriptionAZ || undefined,
    descriptionAz: descriptionAZ || undefined,
    category: String(doc.category ?? doc.gender ?? doc.Sex ?? '').toLowerCase().trim(),
    color,
    fabric,
    price: Number(doc.price) || 0,
    discountedPrice: doc.discountedPrice != null ? Number(doc.discountedPrice) : null,
    sizes,
    soldOut,
    image: image || undefined,
    images: images.length ? images : undefined,
    thumbnailUrl: thumb,
    detailImageUrl: detail,
    videoUrl,
    imageType: image ? 'remote' : undefined,
    isNewCollection,
  }
}

const FALLBACK_LIST: Record<string, unknown>[] = []

export async function getAllProducts(): Promise<{ list: Record<string, unknown>[]; fromFallback: boolean }> {
  if (!hasMongoUri()) {
    console.warn('[products] MONGODB_URI not set — returning empty list')
    return { list: FALLBACK_LIST, fromFallback: true }
  }
  if (isCacheValid(serverCache.all)) {
    return { list: serverCache.all!.data, fromFallback: false }
  }
  try {
    const { collection: col } = await getCollection()
    const { existingIds, versionMap } = await getCloudinaryImageData()
    const docs = await col.find(DISPLAY_ONLINE_QUERY, { projection: PROJECTION }).sort({ sku: 1, _id: 1 }).toArray()
    const products = docs
        .map((d) => {
          const doc = d as Record<string, unknown>
          if (!hasPositiveStock(doc)) return null
          const primaryPublicId = getPrimaryPublicIdForDoc(doc)
          if (!passesImageFilter(doc, primaryPublicId, existingIds)) return null
          try { return normalize(doc, versionMap) } catch (e) { console.warn('[products] normalize failed:', (e as Error).message); return null }
        })
        .filter((p): p is Record<string, unknown> => !!p)
    const now = Date.now()
    serverCache.all = { data: products, ts: now, v: PRODUCTS_CACHE_VERSION }
    products.forEach((p) => {
      if (p.id) serverCache.byId[String(p.id)] = { data: p, ts: now, v: PRODUCTS_CACHE_VERSION }
    })
    return { list: products, fromFallback: false }
  } catch (err) {
    console.warn('[products] MongoDB failed —', (err as Error).message)
    return { list: FALLBACK_LIST, fromFallback: true }
  }
}

export async function getProductById(id: string): Promise<Record<string, unknown> | null> {
  if (!hasMongoUri()) return null
  if (isCacheValid(serverCache.byId[id])) return serverCache.byId[id].data
  try {
    const { collection: col } = await getCollection()
    let doc: Record<string, unknown> | null = null
    try {
      if (ObjectId.isValid(id) && String(new ObjectId(id)) === id) {
        doc = await col.findOne({ _id: new ObjectId(id), ...DISPLAY_ONLINE_QUERY }, { projection: PROJECTION }) as Record<string, unknown> | null
      }
    } catch {
      // ignore
    }
    if (!doc) {
      doc = await col.findOne(
          { $and: [{ $or: [{ sku: id }, { skuColor: id }, { id }] }, DISPLAY_ONLINE_QUERY] },
          { projection: PROJECTION }
      ) as Record<string, unknown> | null
    }
    if (doc && !hasPositiveStock(doc)) return null
    const { existingIds, versionMap } = await getCloudinaryImageData()
    const primaryPublicId = doc ? getPrimaryPublicIdForDoc(doc) : null
    if (doc && !passesImageFilter(doc, primaryPublicId, existingIds)) return null
    const product = normalize(doc, versionMap)
    if (product && product.id) {
      serverCache.byId[String(product.id)] = {
        data: product,
        ts: Date.now(),
        v: PRODUCTS_CACHE_VERSION,
      }
    }
    return product
  } catch (err) {
    console.warn('[products] getProductById failed:', (err as Error).message)
    return null
  }
}

export async function getProductsByCategory(category: string): Promise<Record<string, unknown>[]> {
  if (!hasMongoUri()) return []
  const c = String(category).trim().toLowerCase()
  if (isCacheValid(serverCache.byCategory[c])) return serverCache.byCategory[c].data
  try {
    const { collection: col } = await getCollection()
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^${escaped}$`, 'i')
    const docs = await col.find({ $and: [{ $or: [{ category: re }, { gender: re }] }, DISPLAY_ONLINE_QUERY] }, { projection: PROJECTION }).sort({ sku: 1, _id: 1 }).toArray()
    const { existingIds, versionMap } = await getCloudinaryImageData()
    const products = docs
        .map((d) => {
          const doc = d as Record<string, unknown>
          if (!hasPositiveStock(doc)) return null
          const primaryPublicId = getPrimaryPublicIdForDoc(doc)
          if (!passesImageFilter(doc, primaryPublicId, existingIds)) return null
          try { return normalize(doc, versionMap) } catch (e) { return null }
        })
        .filter((p): p is Record<string, unknown> => !!p)
    serverCache.byCategory[c] = { data: products, ts: Date.now(), v: PRODUCTS_CACHE_VERSION }
    return products
  } catch (err) {
    console.warn('[products] getProductsByCategory failed:', (err as Error).message)
    return []
  }
}

export async function getVariantsByBaseSku(baseSku: string): Promise<Record<string, unknown>[]> {
  if (!baseSku || !String(baseSku).trim() || !hasMongoUri()) return []
  const base = String(baseSku).trim()
  const prefix = base + '-'
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    const { collection: col } = await getCollection()
    const docs = await col
        .find({
          $and: [
            {
              $or: [
                { sku: base },
                { sku: { $regex: `^${escapedPrefix}` } },
                { skuColor: base },
                { skuColor: { $regex: `^${escapedPrefix}` } },
              ],
            },
            DISPLAY_ONLINE_QUERY,
          ],
        }, { projection: PROJECTION })
        .sort({ sku: 1, skuColor: 1 })
        .toArray()
    const { existingIds, versionMap } = await getCloudinaryImageData()
    return docs
        .map((d) => {
          const doc = d as Record<string, unknown>
          if (!hasPositiveStock(doc)) return null
          const primaryPublicId = getPrimaryPublicIdForDoc(doc)
          if (!passesImageFilter(doc, primaryPublicId, existingIds)) return null
          try { return normalize(doc, versionMap) } catch (e) { return null }
        })
        .filter((p): p is Record<string, unknown> => !!p)
  } catch (err) {
    console.warn('[products] getVariantsByBaseSku failed:', (err as Error).message)
    return []
  }
}


export async function getHomeVideos(): Promise<string[]> {
  if (!hasMongoUri()) return []
  try {
    const { client } = await getCollection()
    const db = client.db('vorton_app')
    // videos collection uses string _id ("home"), not ObjectId
    const doc = await db.collection<{ _id: string; videoUrls?: unknown[] }>('videos').findOne({ _id: 'home' })
    const urls = doc?.videoUrls
    if (!Array.isArray(urls)) return []
    return urls.filter((u): u is string => typeof u === 'string' && !!u.trim()).slice(0, 10)
  } catch (err) {
    console.warn('[products] getHomeVideos failed:', (err as Error).message)
    return []
  }
}

export async function getHomeNews(): Promise<Record<string, unknown>[]> {
  if (!hasMongoUri()) return []
  try {
    const { client } = await getCollection()
    const db = client.db('vorton_app')
    const doc = await db.collection<{ _id: string; items?: unknown[] }>('News').findOne({ _id: 'home' })
    const items = doc?.items
    if (!Array.isArray(items)) return []
    return items.filter(
        (x): x is Record<string, unknown> => x != null && typeof x === 'object' && !Array.isArray(x)
    )
  } catch (err) {
    console.warn('[products] getHomeNews failed:', (err as Error).message)
    return []
  }
}

export function oneProductPerBaseSku(products: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!Array.isArray(products) || products.length === 0) return []
  const byModel = new Map<string, Record<string, unknown>>()
  for (const p of products) {
    const modelSku = (String(p.sku ?? '').trim()) || String(p.id ?? '')
    if (!modelSku) continue
    const existing = byModel.get(modelSku)
    if (!existing) {
      byModel.set(modelSku, p)
    } else if (p.isNewCollection && !existing.isNewCollection) {
      byModel.set(modelSku, p)
    }
  }
  const result = Array.from(byModel.values())
  const skuHasNew = new Set(products.filter((p) => p.isNewCollection).map((p) => String(p.sku ?? '').trim()).filter(Boolean))
  result.forEach((p) => {
    if (skuHasNew.has(String(p.sku ?? '').trim())) p.isNewCollection = true
  })
  return result
}

export async function checkProductsConnection(): Promise<{ connected: boolean; error?: string }> {
  if (!hasMongoUri()) return { connected: false, error: 'MONGODB_URI not set' }
  try {
    const { collection: col } = await getCollection()
    await col.findOne({}, { projection: { _id: 1 } })
    return { connected: true }
  } catch (err) {
    return { connected: false, error: (err as Error).message }
  }
}
