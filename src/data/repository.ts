import type { CatalogData, CatalogItem, ItemSet, Recipe, ResourceOrigin, HarvestableResource } from '../domain/types'
import { loadStoredCatalog, saveStoredCatalog } from './storage'
import { applyCuratedOverrides } from './curated'

async function loadSortMetadata(): Promise<Pick<CatalogData, 'sortMetadata'>> {
  const [harvestables, resourceOrigins] = await Promise.all([
    fetch('/data/generated/harvestable_resources.json').then((response) => response.json()).catch(() => ({})) as Promise<Record<string, HarvestableResource>>,
    fetch('/data/generated/resource_origins.json').then((response) => response.json()).catch(() => ({})) as Promise<Record<string, ResourceOrigin>>,
  ])
  return { sortMetadata: { harvestables, resourceOrigins } }
}

function stripBundledImagePaths(data: CatalogData): { data: CatalogData; changed: boolean } {
  let changed = false
  const items = Object.fromEntries(Object.entries(data.items || {}).map(([id, item]) => {
    if (!item.image_path || item.image_path.startsWith('http://') || item.image_path.startsWith('https://')) return [id, item]
    changed = true
    return [id, { ...item, image_path: '' }]
  }))
  return { data: changed ? { ...data, items } : data, changed }
}

export async function loadCatalogData(): Promise<CatalogData> {
  const stored = await loadStoredCatalog().catch(() => null)
  const sortMetadata = await loadSortMetadata()
  if (stored) {
    const repaired = stripBundledImagePaths(stored)
    if (repaired.changed) await saveStoredCatalog(repaired.data).catch(() => {})
    return applyCuratedOverrides({ ...repaired.data, ...sortMetadata })
  }
  const [items, recipes, itemSets, metadata] = await Promise.all([
    fetch('/data/generated/items.json').then((response) => response.json()) as Promise<Record<string, CatalogItem>>,
    fetch('/data/generated/recipes.json').then((response) => response.json()) as Promise<Record<string, Recipe>>,
    fetch('/data/generated/item_sets.json').then((response) => response.json()).catch(() => ({})) as Promise<Record<string, ItemSet>>,
    fetch('/data/generated/metadata.json').then((response) => response.json()) as Promise<Record<string, unknown>>,
  ])
  const bundled = stripBundledImagePaths({
    items,
    recipes,
    itemSets,
    metadata: { ...metadata, shared_sync_state: 'bootstrap' },
    ...sortMetadata,
  }).data
  await saveStoredCatalog(bundled).catch(() => {})
  return applyCuratedOverrides(bundled)
}
