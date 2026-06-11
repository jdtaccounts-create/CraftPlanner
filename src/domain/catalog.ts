import type { CatalogItem, ItemCategory, ItemSet } from './types'

export type CatalogSearchResult = { kind: 'item'; item: CatalogItem } | { kind: 'set'; itemSet: ItemSet }

export interface CatalogSearchIndex {
  items: Array<{ item: CatalogItem; normalized: string; compact: string }>
  itemSets: Array<{ itemSet: ItemSet; normalized: string; compact: string }>
}

export function normalizeText(value: string): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr-FR')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function compactText(value: string): string {
  return normalizeText(value).replace(/\s/g, '')
}

export function itemCategory(item: Pick<CatalogItem, 'item_type_category_id' | 'raw_type'>): ItemCategory | null {
  const categoryId = Number(item.item_type_category_id)
  if (categoryId === 0 || categoryId === 5) return 'Equipement'
  if (categoryId === 1) return 'Consommable'
  if (categoryId === 2 || categoryId === 3) return 'Ressource'

  if (categoryId === 4) {
    if (item.raw_type === 'Nourriture') return 'Consommable'
    if (item.raw_type === 'Certificat') return 'Ressource'
  }

  return null
}

function score(query: string, compactQuery: string, normalized: string, compact: string): number {
  if (normalized === query) return 0
  if (normalized.startsWith(query)) return 1
  if (normalized.includes(query)) return 2
  if (compact.includes(compactQuery)) return 3
  return Number.POSITIVE_INFINITY
}

export function createCatalogSearchIndex(
  items: Record<string, CatalogItem>,
  itemSets: Record<string, ItemSet>,
): CatalogSearchIndex {
  return {
    items: Object.values(items)
      .filter((item) => itemCategory(item))
      .map((item) => ({ item, normalized: item.name_norm || normalizeText(item.name), compact: item.compact || compactText(item.name) })),
    itemSets: Object.values(itemSets)
      .map((itemSet) => ({ itemSet, normalized: itemSet.name_norm || normalizeText(itemSet.name), compact: itemSet.compact || compactText(itemSet.name) })),
  }
}

export function searchCatalog(
  index: CatalogSearchIndex,
  query: string,
  limit = 60,
): CatalogSearchResult[] {
  const normalized = normalizeText(query)
  if (!normalized) return []
  const compactQuery = normalized.replace(/\s/g, '')

  const itemResults = index.items
    .map(({ item, normalized: itemName, compact }) => ({ kind: 'item' as const, item, score: score(normalized, compactQuery, itemName, compact) }))
    .filter((result) => Number.isFinite(result.score))

  const setResults = index.itemSets
    .map(({ itemSet, normalized: setName, compact }) => ({ kind: 'set' as const, itemSet, score: score(normalized, compactQuery, setName, compact) - 0.25 }))
    .filter((result) => Number.isFinite(result.score))

  return [...itemResults, ...setResults]
    .sort((a, b) => a.score - b.score || ('item' in a ? a.item.name : a.itemSet.name).localeCompare('item' in b ? b.item.name : b.itemSet.name, 'fr'))
    .slice(0, limit)
    .map(({ score: _score, ...result }) => result)
}
