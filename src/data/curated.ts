import type { CatalogData, CatalogItem, ItemSet, RecipeExclusions } from '../domain/types'

interface CatalogOverrides {
  items?: Record<string, Partial<CatalogItem>>
  item_sets?: Record<string, Partial<ItemSet>>
}

export async function applyCuratedOverrides(data: CatalogData): Promise<CatalogData> {
  const [overrides, recipeExclusions] = await Promise.all([
    fetch('/data/curated/catalog_overrides.json')
      .then((response) => response.json() as Promise<CatalogOverrides>)
      .catch((): CatalogOverrides => ({})),
    fetch('/data/curated/recipe_exclusions.json')
      .then((response) => response.json() as Promise<RecipeExclusions>)
      .catch((): RecipeExclusions => ({ item_ids: [], name_patterns: [] })),
  ])
  const items = { ...data.items }
  const itemSets = { ...data.itemSets }
  Object.entries(overrides.items || {}).forEach(([id, patch]) => {
    if (items[id]) items[id] = { ...items[id], ...patch }
  })
  Object.entries(overrides.item_sets || {}).forEach(([id, patch]) => {
    if (itemSets[id]) itemSets[id] = { ...itemSets[id], ...patch }
  })
  return { ...data, items, itemSets, recipeExclusions }
}
