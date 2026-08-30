import type { CatalogData, CatalogItem } from '../domain/types'
import { loadCachedImageIds, loadCharacteristicIconFiles, loadFailedCachedImages, loadSharedJson, type FailedCachedImage } from './storage'

const API_URL = 'https://api.dofusdb.fr'
const PAGE_LIMIT = 50
const CONCURRENCY = 8
const REQUEST_TIMEOUT_MS = 8_000
const FAILED_IMAGE_RETRY_MS = 24 * 60 * 60 * 1000
const TRANSIENT_FAILED_IMAGE_RETRY_MS = 15 * 60 * 1000
const ESTIMATED_JSON_COMPRESSION_RATIO = 0.16
export const ESTIMATED_IMAGE_BYTES = 40 * 1024

export type SyncEndpoint = 'items' | 'recipes' | 'itemSets' | 'characteristics'

export type SyncProgressEvent =
  | { kind: 'endpoint'; endpoint: SyncEndpoint; done: number; total: number; bytesDone: number }
  | { kind: 'images'; done: number; total: number; bytesDone: number; bytesTotal?: number }
  | { kind: 'statIcons'; done: number; total: number; bytesDone: number; bytesTotal?: number }
  | { kind: 'message'; message: string }

export type SyncProgress = (event: SyncProgressEvent) => void

export interface CatalogStatus {
  needsSync: boolean
  labels: string[]
  totals: Record<SyncEndpoint, number>
  latestUpdatedAt: Record<SyncEndpoint, string>
  missingImageGroups: number
  missingCharacteristicIcons: number
}

type EndpointInfo = {
  total: number
  latestUpdatedAt: string
}

const CHARACTERISTIC_ICON_ALIASES: Record<string, string> = {
  tx_lifePoints: 'tx_health.png',
  tx_strengthRes: 'tx_res_strength.png',
  tx_intelligenceRes: 'tx_res_intelligence.png',
  tx_chanceRes: 'tx_res_chance.png',
  tx_agilityRes: 'tx_res_agility.png',
  tx_neutralRes: 'tx_res_neutre.png',
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

function isRecentFailedImage(row: FailedCachedImage, now = Date.now()): boolean {
  return now - Date.parse(row.failedAt) < failedImageRetryMs(row)
}

function recentFailedImageIds(rows: FailedCachedImage[] | null, now = Date.now()): Set<number> {
  return new Set((rows || [])
    .filter((row) => isRecentFailedImage(row, now))
    .map((row) => row.itemId))
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

function characteristicIconFile(asset: string): string | null {
  if (!asset) return null
  return CHARACTERISTIC_ICON_ALIASES[asset] || `${asset}.png`
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
    characteristics: 'characteristic_total',
  }
  return {
    total: Number(remote?.[endpoint]?.total || data.metadata?.[legacyTotals[endpoint]] || 0),
    latestUpdatedAt: String(remote?.[endpoint]?.latestUpdatedAt || ''),
  }
}

export async function checkCatalogStatus(data: CatalogData): Promise<CatalogStatus> {
  const [items, recipes, itemSets, characteristics] = await Promise.all([
    endpointInfo('/items'),
    endpointInfo('/recipes'),
    endpointInfo('/item-sets'),
    endpointInfo('/characteristics'),
  ])
  const labels = []
  const totals = {
    items: items.total,
    recipes: recipes.total,
    itemSets: itemSets.total,
    characteristics: characteristics.total,
  }
  const latestUpdated = {
    items: items.latestUpdatedAt,
    recipes: recipes.latestUpdatedAt,
    itemSets: itemSets.latestUpdatedAt,
    characteristics: characteristics.latestUpdatedAt,
  }
  const localItems = localRemoteMetadata(data, 'items')
  const localRecipes = localRemoteMetadata(data, 'recipes')
  const localItemSets = localRemoteMetadata(data, 'itemSets')
  const localCharacteristics = localRemoteMetadata(data, 'characteristics')
  if (totals.items !== localItems.total || (latestUpdated.items && latestUpdated.items !== localItems.latestUpdatedAt)) labels.push('items')
  if (totals.recipes !== localRecipes.total || (latestUpdated.recipes && latestUpdated.recipes !== localRecipes.latestUpdatedAt)) labels.push('recettes')
  if (totals.itemSets !== localItemSets.total || (latestUpdated.itemSets && latestUpdated.itemSets !== localItemSets.latestUpdatedAt)) labels.push('panoplies')
  if (totals.characteristics !== localCharacteristics.total || (latestUpdated.characteristics && latestUpdated.characteristics !== localCharacteristics.latestUpdatedAt)) labels.push('caractéristiques')
  const cachedIds = new Set(await loadCachedImageIds())
  const ignoredImageIds = recentFailedImageIds(await loadFailedCachedImages())
  const missingImageGroups = groupMissingImages(data, new Set([...cachedIds, ...ignoredImageIds])).length
  if (missingImageGroups > 0) labels.push('images')
  const missingCharacteristicIcons = await missingCharacteristicIconFiles().then((rows) => rows.length)
  if (missingCharacteristicIcons > 0) labels.push('icônes de stats')
  return { needsSync: labels.length > 0, labels, totals, latestUpdatedAt: latestUpdated, missingImageGroups, missingCharacteristicIcons }
}

async function requiredCharacteristicIconFiles(): Promise<string[]> {
  const raw = await fetchAll('/characteristics', 'characteristics')
  const files = raw
    .map((row) => characteristicIconFile(String(row.asset || '')))
    .filter((file): file is string => Boolean(file))
  return [...new Set(files)]
}

async function missingCharacteristicIconFiles(): Promise<string[]> {
  const required = await requiredCharacteristicIconFiles()
  const existing = new Set(await loadCharacteristicIconFiles())
  const manifest = await loadSharedJson<Array<{ file?: string; missing?: boolean }>>('characteristic-icons').catch(() => null)
  const knownMissing = new Set((manifest || [])
    .filter((row) => row.missing && row.file)
    .map((row) => row.file!))
  return required.filter((file) => !existing.has(file) && !knownMissing.has(file))
}
