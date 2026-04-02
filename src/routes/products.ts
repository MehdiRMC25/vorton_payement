import { Router, Request, Response } from 'express'
import * as productsService from '../services/productsService'

const router = Router()

function toUserMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  if (/authentication failed|bad auth|credentials/i.test(m)) {
    return 'Database login failed. Check MONGODB_URI in .env or Render env vars.'
  }
  if (/ENOTFOUND|getaddrinfo|ECONNREFUSED/i.test(m)) {
    return 'Cannot reach MongoDB. Check MONGODB_URI host and Atlas Network Access.'
  }
  return m || 'Server error.'
}

function omitDescriptions(product: Record<string, unknown>): Record<string, unknown> {
  if (!product || typeof product !== 'object') return product
  // Keep response light for list endpoints; descriptions are available via /api/products/:id.
  const {
    descriptionEn: _en,
    descriptionAZ: _az,
    descriptionAz: _azMongo,
    ...rest
  } = product as Record<string, unknown>
  return rest
}

/** GET /api/home-videos */
router.get('/home-videos', async (_req: Request, res: Response) => {
  try {
    const videoUrls = await productsService.getHomeVideos()
    res.json({ ok: true, videoUrls })
  } catch (e) {
    res.status(500).json({ ok: false, videoUrls: [] })
  }
})

/** GET /api/product-variants/:baseSku */
router.get('/product-variants/:baseSku', async (req: Request, res: Response) => {
  try {
    const baseSku = req.params.baseSku
    if (!baseSku) {
      return res.status(400).json({ ok: false, error: 'baseSku required' })
    }
    const variants = await productsService.getVariantsByBaseSku(baseSku)
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300')
    res.json({ ok: true, variants: variants.map(omitDescriptions) })
  } catch (err) {
    const msg = toUserMessage(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

/** GET /api/products - list all or filter by category */
router.get('/products', async (req: Request, res: Response) => {
  try {
    const category = req.query.category as string | undefined
    const categories = req.query.categories as string | undefined
    const onePerModel = req.query.onePerModel === '1' || req.query.onePerModel === 'true' || req.query.listView === '1'

    let list: Awaited<ReturnType<typeof productsService.getAllProducts>>['list']
    let fromFallback = false

    if (categories) {
      const valid = ['men', 'women', 'unisex']
      const cats = String(categories)
        .toLowerCase()
        .split(',')
        .map((c) => c.trim())
        .filter((c) => valid.includes(c))
      if (cats.length > 0) {
        const results = await Promise.all(cats.map((c) => productsService.getProductsByCategory(c)))
        const seen = new Set<string>()
        list = []
        for (const arr of results) {
          for (const p of arr) {
            const id = String(p?.id ?? '')
            if (p && id && !seen.has(id)) {
              seen.add(id)
              list.push(p)
            }
          }
        }
        list.sort(
          (a, b) =>
            String(a?.sku ?? '').localeCompare(String(b?.sku ?? '')) ||
            String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
        )
      } else {
        const result = await productsService.getAllProducts()
        list = result.list
        fromFallback = result.fromFallback
      }
    } else if (category && ['men', 'women', 'unisex'].includes(String(category).toLowerCase())) {
      list = await productsService.getProductsByCategory(String(category).toLowerCase())
    } else {
      const result = await productsService.getAllProducts()
      list = result.list
      fromFallback = result.fromFallback
    }

    if (onePerModel && list && list.length > 0) {
      list = productsService.oneProductPerBaseSku(list)
    }

    res.set('Cache-Control', 'public, max-age=300, s-maxage=300')
    res.json({ ok: true, products: list.map(omitDescriptions), fromFallback })
  } catch (err) {
    const msg = toUserMessage(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

/** GET /api/products/:id - single product by id, sku, or skuColor */
router.get('/products/:id', async (req: Request, res: Response) => {
  try {
    const product = await productsService.getProductById(req.params.id)
    if (!product) {
      return res.status(404).json({ ok: false, error: 'Product not found' })
    }
    res.set('Cache-Control', 'public, max-age=300, s-maxage=300')
    res.json({ ok: true, product })
  } catch (err) {
    const msg = toUserMessage(err)
    res.status(500).json({ ok: false, error: msg })
  }
})

export { router as productsRouter }
