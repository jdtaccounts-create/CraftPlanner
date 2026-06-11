import type { CatalogData, CatalogItem, ItemSet, Recipe } from '../domain/types'
import { loadStoredCatalog } from './storage'
import { applyCuratedOverrides } from './curated'

export async function loadCatalogData(): Promise<CatalogData> {
  const stored = await loadStoredCatalog().catch(() => null)
  if (stored) return applyCuratedOverrides(stored)
  const [items, recipes, itemSets, metadata] = await Promise.all([
    fetch('/data/generated/items.json').then((response) => response.json()) as Promise<Record<string, CatalogItem>>,
    fetch('/data/generated/recipes.json').then((response) => response.json()) as Promise<Record<string, Recipe>>,
    fetch('/data/generated/item_sets.json').then((response) => response.json()).catch(() => ({})) as Promise<Record<string, ItemSet>>,
    fetch('/data/generated/metadata.json').then((response) => response.json()) as Promise<Record<string, unknown>>,
  ])
  return applyCuratedOverrides({ items, recipes, itemSets, metadata })
}
