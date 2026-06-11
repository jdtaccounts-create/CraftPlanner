import { compactText, normalizeText } from '../domain/catalog'
import type { CatalogData, CatalogItem, ItemSet, Recipe } from '../domain/types'
import { loadCachedImageIds, loadCachedImages, saveCachedImage, saveStoredCatalog } from './storage'
import { applyCuratedOverrides } from './curated'

const API_URL = 'https://api.dofusdb.fr'
const PAGE_LIMIT = 50
const CONCURRENCY = 8
const REQUEST_TIMEOUT_MS = 8_000

function isRemoteImage(path: string | undefined): boolean {
  return /^https?:\/\//.test(path || '')
}

function imageSource(item: CatalogItem): string {
  if (isRemoteImage(item.image_url)) return item.image_url!
  return isRemoteImage(item.image_path) ? item.image_path : ''
}

async function apiGet(path: string, params: Record<string, number> = {}): Promise<any> {
  const url = new URL(`${API_URL}${path}`)
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)))
  if ('__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core')
    return JSON.parse(await invoke<string>('http_get', { url: url.toString() }))
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`DofusDB ${response.status}`)
  return response.json()
}

async function fetchAll(path: string, progress?: (message: string) => void): Promise<any[]> {
  const first = await apiGet(path, { $limit: PAGE_LIMIT, $skip: 0 })
  const rows = [...(first.data || [])]
  const skips: number[] = []
  for (let skip = PAGE_LIMIT; skip < Number(first.total || 0); skip += PAGE_LIMIT) skips.push(skip)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, skips.length) }, async () => {
    while (cursor < skips.length) {
      const skip = skips[cursor++]
      rows.push(...((await apiGet(path, { $limit: PAGE_LIMIT, $skip: skip })).data || []))
      progress?.(`${path.slice(1)} ${rows.length}/${first.total}`)
    }
  }))
  return rows
}

function normalizeItem(raw: any, previous?: CatalogItem): CatalogItem | null {
  if (raw?.id == null) return null
  const name = raw.name?.fr || raw.name?.en || `Item ${raw.id}`
  const remoteImage = raw.img || raw.image || ''
  return {
    id: Number(raw.id),
    name,
    name_norm: normalizeText(name),
    compact: compactText(name),
    raw_type: raw.type?.superType?.name?.fr || raw.type?.name?.fr || '',
    type_id: Number.isFinite(Number(raw.typeId ?? raw.type?.id)) ? Number(raw.typeId ?? raw.type?.id) : null,
    type_name: raw.type?.name?.fr || '',
    item_type_category_id: Number.isFinite(Number(raw.type?.categoryId)) ? Number(raw.type.categoryId) : null,
    item_type_in_encyclopedia: Boolean(raw.type?.inEncyclopedia),
    image_url: remoteImage,
    image_path: previous?.image_path && !/^https?:/.test(previous.image_path) ? previous.image_path : remoteImage,
  }
}

function normalizeRecipe(raw: any): Recipe | null {
  if (raw?.resultId == null) return null
  return { result_id: Number(raw.resultId), ingredient_ids: (raw.ingredientIds || []).map(Number), quantities: (raw.quantities || []).map(Number) }
}

function normalizeSet(raw: any): ItemSet | null {
  if (raw?.id == null) return null
  const name = raw.name?.fr || raw.slug?.fr || `Panoplie ${raw.id}`
  return { id: Number(raw.id), name, name_norm: normalizeText(name), compact: compactText(name), item_ids: (raw.items || []).map((item: any) => Number(item.id)) }
}

function byId<T extends { id?: number; result_id?: number }>(rows: Array<T | null>, key: 'id' | 'result_id'): Record<string, T> {
  return Object.fromEntries(rows.filter((row): row is T => Boolean(row && row[key] != null)).map((row) => [String(row[key]), row]))
}

export async function checkCatalogStatus(data: CatalogData): Promise<{ needsSync: boolean; labels: string[] }> {
  const [items, recipes, itemSets] = await Promise.all([
    apiGet('/items', { $limit: 1, $skip: 0 }),
    apiGet('/recipes', { $limit: 1, $skip: 0 }),
    apiGet('/item-sets', { $limit: 1, $skip: 0 }),
  ])
  const labels = []
  if (Number(items.total) !== Object.keys(data.items).length) labels.push('items')
  if (Number(recipes.total) !== Object.keys(data.recipes).length) labels.push('recettes')
  if (Number(itemSets.total) !== Object.keys(data.itemSets).length) labels.push('panoplies')
  const cachedIds = new Set(await loadCachedImageIds())
  if (Object.values(data.items).some((item) => isRemoteImage(item.image_path) && !cachedIds.has(item.id))) labels.push('images')
  return { needsSync: labels.length > 0, labels }
}

export async function syncCatalogImages(
  data: CatalogData,
  progress?: (message: string) => void,
): Promise<Map<number, string>> {
  const cached = await loadCachedImages()
  const urls = new Map(cached.map(({ itemId, blob }) => [itemId, URL.createObjectURL(blob)]))
  const missing = Object.values(data.items).filter((item) => imageSource(item) && isRemoteImage(item.image_path) && !urls.has(item.id))
  let cursor = 0
  let completed = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, async () => {
    while (cursor < missing.length) {
      const item = missing[cursor++]
      try {
        const response = await fetch(imageSource(item), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        if (!response.ok) throw new Error(`Image ${response.status}`)
        const blob = await response.blob()
        await saveCachedImage(item.id, blob)
        urls.set(item.id, URL.createObjectURL(blob))
      } catch {
        // A failed image must not prevent the offline catalog from loading.
      } finally {
        completed += 1
        if (completed % 25 === 0 || completed === missing.length) progress?.(`Images ${completed}/${missing.length}`)
      }
    }
  }))
  return urls
}

export async function syncCatalogData(previous: CatalogData, progress?: (message: string) => void): Promise<CatalogData> {
  const [rawItems, rawRecipes, rawSets] = await Promise.all([
    fetchAll('/items', progress),
    fetchAll('/recipes', progress),
    fetchAll('/item-sets', progress),
  ])
  const data: CatalogData = {
    items: byId(rawItems.map((raw) => normalizeItem(raw, previous.items[String(raw.id)])), 'id'),
    recipes: byId(rawRecipes.map(normalizeRecipe), 'result_id'),
    itemSets: byId(rawSets.map(normalizeSet), 'id'),
    metadata: { last_sync: new Date().toISOString(), item_total: rawItems.length, recipe_total: rawRecipes.length, item_set_total: rawSets.length },
  }
  await saveStoredCatalog(data)
  return applyCuratedOverrides(data)
}
