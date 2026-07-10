import { compactText, normalizeText } from '../domain/catalog'
import type { CatalogData, CatalogItem, ItemSet, Recipe } from '../domain/types'
import { loadCachedImageIds, loadFailedCachedImages, pruneCachedImages, saveCachedImage, saveFailedCachedImages, saveStoredCatalog, type FailedCachedImage } from './storage'
import { applyCuratedOverrides } from './curated'

const API_URL = 'https://api.dofusdb.fr'
const PAGE_LIMIT = 50
const CONCURRENCY = 8
const REQUEST_TIMEOUT_MS = 8_000
const FAILED_IMAGE_RETRY_MS = 24 * 60 * 60 * 1000
const TRANSIENT_FAILED_IMAGE_RETRY_MS = 15 * 60 * 1000
const ESTIMATED_JSON_COMPRESSION_RATIO = 0.16
export const ESTIMATED_IMAGE_BYTES = 40 * 1024

export type SyncEndpoint = 'items' | 'recipes' | 'itemSets'

export type SyncProgressEvent =
  | { kind: 'endpoint'; endpoint: SyncEndpoint; done: number; total: number; bytesDone: number }
  | { kind: 'images'; done: number; total: number; bytesDone: number; bytesTotal?: number }
  | { kind: 'message'; message: string }

export type SyncProgress = (event: SyncProgressEvent) => void

export interface CatalogStatus {
  needsSync: boolean
  labels: string[]
  totals: Record<SyncEndpoint, number>
  latestUpdatedAt: Record<SyncEndpoint, string>
  missingImageGroups: number
}

type EndpointInfo = {
  total: number
  latestUpdatedAt: string
}

function isRemoteImage(path: string | undefined): boolean {
  return /^https?:\/\//.test(path || '')
}

function imageSource(item: CatalogItem): string {
  if (isRemoteImage(item.image_url)) return item.image_url!
  return isRemoteImage(item.image_path) ? item.image_path : ''
}

export function groupMissingImages(data: CatalogData, cachedIds: ReadonlySet<number>): Array<[string, CatalogItem[]]> {
  const missingBySource = Object.values(data.items).reduce((groups, item) => {
    const source = imageSource(item)
    if (!source || cachedIds.has(item.id)) return groups
    const group = groups.get(source) || []
    group.push(item)
    groups.set(source, group)
    return groups
  }, new Map<string, CatalogItem[]>())
  return [...missingBySource.entries()]
}

function failedImageRetryMs(row: FailedCachedImage): number {
  return /failed to fetch|timeout|network|abort/i.test(row.reason || '')
    ? TRANSIENT_FAILED_IMAGE_RETRY_MS
    : FAILED_IMAGE_RETRY_MS
}

function isTransientImageFailure(row: FailedCachedImage): boolean {
  return failedImageRetryMs(row) === TRANSIENT_FAILED_IMAGE_RETRY_MS
}

function isRecentFailedImage(row: FailedCachedImage, now = Date.now()): boolean {
  return now - Date.parse(row.failedAt) < failedImageRetryMs(row)
}

function recentFailedImageIds(rows: FailedCachedImage[] | null, now = Date.now()): Set<number> {
  return new Set((rows || [])
    .filter((row) => isRecentFailedImage(row, now))
    .map((row) => row.itemId))
}

function mergeFailedImages(previous: FailedCachedImage[] | null, next: FailedCachedImage[]): FailedCachedImage[] {
  const recent = (previous || []).filter((row) => isRecentFailedImage(row))
  const byId = new Map(recent.map((row) => [row.itemId, row]))
  next.forEach((row) => byId.set(row.itemId, row))
  return [...byId.values()]
}

function estimatedCompressedJsonBytes(text: string, fallbackBytes?: number | null): number {
  const knownBytes = Number(fallbackBytes || 0)
  if (knownBytes > 0) return knownBytes
  return Math.max(1, Math.round(new Blob([text]).size * ESTIMATED_JSON_COMPRESSION_RATIO))
}

async function apiGetPayload(path: string, params: Record<string, number> = {}): Promise<{ data: any; bytes: number }> {
  const url = new URL(`${API_URL}${path}`)
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)))
  if ('__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core')
    try {
      const response = await invoke<{ body: string; content_length?: number | null }>('http_get_with_metadata', { url: url.toString() })
      return { data: JSON.parse(response.body), bytes: estimatedCompressedJsonBytes(response.body, response.content_length) }
    } catch {
      const text = await invoke<string>('http_get', { url: url.toString() })
      return { data: JSON.parse(text), bytes: estimatedCompressedJsonBytes(text) }
    }
  }
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`DofusDB ${response.status}`)
  const text = await response.text()
  const headerBytes = Number(response.headers.get('content-length') || 0)
  const timingEntries = performance
    .getEntriesByName(url.toString())
    .filter((entry): entry is PerformanceResourceTiming => 'encodedBodySize' in entry)
  const timingBytes = timingEntries.length ? timingEntries[timingEntries.length - 1].encodedBodySize : 0
  return { data: JSON.parse(text), bytes: estimatedCompressedJsonBytes(text, headerBytes || timingBytes || 0) }
}

async function apiGet(path: string, params: Record<string, number> = {}): Promise<any> {
  return (await apiGetPayload(path, params)).data
}

async function fetchAll(path: string, endpoint: SyncEndpoint, progress?: SyncProgress): Promise<any[]> {
  const firstPayload = await apiGetPayload(path, { $limit: PAGE_LIMIT, $skip: 0 })
  const first = firstPayload.data
  const rows = [...(first.data || [])]
  const total = Number(first.total || 0)
  let bytesDone = firstPayload.bytes
  progress?.({ kind: 'endpoint', endpoint, done: rows.length, total, bytesDone })
  const skips: number[] = []
  for (let skip = PAGE_LIMIT; skip < total; skip += PAGE_LIMIT) skips.push(skip)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, skips.length) }, async () => {
    while (cursor < skips.length) {
      const skip = skips[cursor++]
      const payload = await apiGetPayload(path, { $limit: PAGE_LIMIT, $skip: skip })
      rows.push(...(payload.data.data || []))
      bytesDone += payload.bytes
      progress?.({ kind: 'endpoint', endpoint, done: Math.min(rows.length, total), total, bytesDone })
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
    criterions: raw.criterions || '',
    quests_that_use: (raw.questsThatUse || []).map(Number),
    quests_that_reward: (raw.questsThatReward || []).map(Number),
    image_url: remoteImage,
    image_path: isRemoteImage(previous?.image_path) ? previous!.image_path : '',
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

async function endpointInfo(path: string): Promise<EndpointInfo> {
  const page = await apiGet(path, { $limit: 1, $skip: 0, '$sort[updatedAt]': -1 } as Record<string, number>)
  return {
    total: Number(page.total || 0),
    latestUpdatedAt: String(page.data?.[0]?.updatedAt || ''),
  }
}

function localRemoteMetadata(data: CatalogData, endpoint: SyncEndpoint): EndpointInfo {
  if (data.metadata?.shared_sync_state === 'bootstrap') {
    return { total: 0, latestUpdatedAt: '' }
  }
  const remote = data.metadata?.remote as Record<string, Partial<EndpointInfo>> | undefined
  const legacyTotals: Record<SyncEndpoint, string> = {
    items: 'item_total',
    recipes: 'recipe_total',
    itemSets: 'item_set_total',
  }
  return {
    total: Number(remote?.[endpoint]?.total || data.metadata?.[legacyTotals[endpoint]] || 0),
    latestUpdatedAt: String(remote?.[endpoint]?.latestUpdatedAt || ''),
  }
}

function latestUpdatedAt(rows: any[]): string {
  return rows.reduce((latest, row) => {
    const value = String(row?.updatedAt || '')
    return value > latest ? value : latest
  }, '')
}

export async function checkCatalogStatus(data: CatalogData): Promise<CatalogStatus> {
  const [items, recipes, itemSets] = await Promise.all([
    endpointInfo('/items'),
    endpointInfo('/recipes'),
    endpointInfo('/item-sets'),
  ])
  const labels = []
  const totals = {
    items: items.total,
    recipes: recipes.total,
    itemSets: itemSets.total,
  }
  const latestUpdated = {
    items: items.latestUpdatedAt,
    recipes: recipes.latestUpdatedAt,
    itemSets: itemSets.latestUpdatedAt,
  }
  const localItems = localRemoteMetadata(data, 'items')
  const localRecipes = localRemoteMetadata(data, 'recipes')
  const localItemSets = localRemoteMetadata(data, 'itemSets')
  if (totals.items !== localItems.total || (latestUpdated.items && latestUpdated.items !== localItems.latestUpdatedAt)) labels.push('items')
  if (totals.recipes !== localRecipes.total || (latestUpdated.recipes && latestUpdated.recipes !== localRecipes.latestUpdatedAt)) labels.push('recettes')
  if (totals.itemSets !== localItemSets.total || (latestUpdated.itemSets && latestUpdated.itemSets !== localItemSets.latestUpdatedAt)) labels.push('panoplies')
  const cachedIds = new Set(await loadCachedImageIds())
  const ignoredImageIds = recentFailedImageIds(await loadFailedCachedImages())
  const missingImageGroups = groupMissingImages(data, new Set([...cachedIds, ...ignoredImageIds])).length
  if (missingImageGroups > 0) labels.push('images')
  return { needsSync: labels.length > 0, labels, totals, latestUpdatedAt: latestUpdated, missingImageGroups }
}

export async function syncCatalogImages(
  data: CatalogData,
  progress?: SyncProgress,
): Promise<Map<number, string>> {
  const cachedIds = await loadCachedImageIds()
  const previousFailures = await loadFailedCachedImages().catch(() => null)
  const ignoredImageIds = recentFailedImageIds(previousFailures)
  const missing = groupMissingImages(data, new Set([...cachedIds, ...ignoredImageIds]))
  let cursor = 0
  let completed = 0
  let bytesDone = 0
  let successful = 0
  let bytesTotal = missing.length * ESTIMATED_IMAGE_BYTES
  const failures: FailedCachedImage[] = []
  progress?.({ kind: 'images', done: 0, total: missing.length, bytesDone, bytesTotal })
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, async () => {
    while (cursor < missing.length) {
      const [source, items] = missing[cursor++]
      const savedItemIds = new Set<number>()
      try {
        const response = await fetch(source, { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        if (!response.ok) throw new Error(`Image ${response.status}`)
        const blob = await response.blob()
        bytesDone += blob.size
        successful += 1
        if (successful > 0) bytesTotal = Math.max(bytesDone, (bytesDone / successful) * missing.length)
        for (const item of items) {
          await saveCachedImage(item.id, blob)
          savedItemIds.add(item.id)
        }
      } catch (error) {
        // A failed image must not prevent the offline catalog from loading.
        const failedItems = items.filter((item) => !savedItemIds.has(item.id))
        if (failedItems.length) {
          const reason = String(error)
          console.warn('[CraftPlanner] image sync failed', {
            source,
            reason,
            items: failedItems.map((item) => ({ id: item.id, name: item.name })),
          })
          failures.push(...failedItems.map((item) => ({ itemId: item.id, source, failedAt: new Date().toISOString(), reason })))
        }
      } finally {
        completed += 1
        if (completed % 50 === 0 || completed === missing.length || completed === 1 || missing.length - completed <= 50) {
          progress?.({ kind: 'images', done: completed, total: missing.length, bytesDone, bytesTotal })
        }
      }
    }
  }))
  const transientFailures = failures.filter(isTransientImageFailure)
  const durableFailures = failures.filter((row) => !isTransientImageFailure(row))
  if (transientFailures.length) {
    throw new Error(`Connexion interrompue : ${transientFailures.length} images restent à télécharger`)
  }
  const validItemIds = Object.keys(data.items).map(Number)
  const validItemIdSet = new Set(validItemIds)
  const nextFailures = mergeFailedImages(previousFailures, durableFailures).filter((row) => validItemIdSet.has(row.itemId))
  if (durableFailures.length || nextFailures.length !== (previousFailures?.length || 0)) {
    await saveFailedCachedImages(nextFailures)
  }
  await pruneCachedImages(validItemIds).catch((error) => {
    console.warn('[CraftPlanner] shared image prune failed', error)
  })
  return new Map()
}

export async function syncCatalogData(previous: CatalogData, progress?: SyncProgress): Promise<CatalogData> {
  const [rawItems, rawRecipes, rawSets] = await Promise.all([
    fetchAll('/items', 'items', progress),
    fetchAll('/recipes', 'recipes', progress),
    fetchAll('/item-sets', 'itemSets', progress),
  ])
  const data: CatalogData = {
    items: byId(rawItems.map((raw) => normalizeItem(raw, previous.items[String(raw.id)])), 'id'),
    recipes: byId(rawRecipes.map(normalizeRecipe), 'result_id'),
    itemSets: byId(rawSets.map(normalizeSet), 'id'),
    metadata: {
      last_sync: new Date().toISOString(),
      item_total: rawItems.length,
      recipe_total: rawRecipes.length,
      item_set_total: rawSets.length,
      remote: {
        items: { total: rawItems.length, latestUpdatedAt: latestUpdatedAt(rawItems) },
        recipes: { total: rawRecipes.length, latestUpdatedAt: latestUpdatedAt(rawRecipes) },
        itemSets: { total: rawSets.length, latestUpdatedAt: latestUpdatedAt(rawSets) },
      },
      shared_sync_state: 'complete',
    },
    sortMetadata: previous.sortMetadata,
  }
  await saveStoredCatalog(data)
  return applyCuratedOverrides(data)
}
