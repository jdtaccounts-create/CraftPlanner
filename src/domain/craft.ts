import { normalizeText } from './catalog'
import type { CatalogData, CatalogItem, CraftLine, CraftPlan, CraftRole, SelectedItem } from './types'

function addQuantity(target: Map<number, number>, itemId: number, quantity: number): void {
  target.set(itemId, (target.get(itemId) || 0) + quantity)
}

function makeLines(role: CraftRole, quantities: Map<number, number>, items: Record<string, CatalogItem>): CraftLine[] {
  return Array.from(quantities.entries())
    .map(([itemId, quantity]) => {
      const item = items[String(itemId)]
      return {
        lineKey: `${role}:${itemId}`,
        itemId,
        quantity,
        role,
        name: item?.name || `Item ${itemId}`,
        rawType: item?.type_name || item?.raw_type || 'Item',
        imagePath: item?.image_path || '',
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
}

function isRecipeExcluded(data: CatalogData, itemId: number): boolean {
  const exclusions = data.recipeExclusions
  if (!exclusions) return false
  if ((exclusions.item_ids || []).map(Number).includes(itemId)) return true
  const name = normalizeText(data.items[String(itemId)]?.name || '')
  return (exclusions.name_patterns || []).some((pattern) => name.includes(normalizeText(pattern)))
}

export function buildCraftPlan(data: CatalogData, selected: SelectedItem[]): CraftPlan {
  const direct = new Map<number, number>()
  const subcrafts = new Map<number, number>()
  const ingredients = new Map<number, number>()
  const noncraftable = new Map<number, number>()
  const dependencies = new Map<string, Map<number, number>>()

  const addDependency = (parentKey: string, itemId: number, quantity: number): void => {
    if (!dependencies.has(parentKey)) dependencies.set(parentKey, new Map())
    addQuantity(dependencies.get(parentKey)!, itemId, quantity)
  }

  const expand = (itemId: number, quantity: number, depth: number, stack: number[] = []): Map<number, number> => {
    if (isRecipeExcluded(data, itemId)) {
      addQuantity(depth === 0 ? noncraftable : ingredients, itemId, quantity)
      return new Map()
    }

    if (stack.includes(itemId)) {
      addQuantity(noncraftable, itemId, quantity)
      return new Map()
    }

    const recipe = data.recipes[String(itemId)]
    if (!recipe) {
      addQuantity(depth === 0 ? noncraftable : ingredients, itemId, quantity)
      return new Map()
    }

    const parentKey = `${depth === 0 ? 'direct' : 'subcraft'}:${itemId}`
    addQuantity(depth === 0 ? direct : subcrafts, itemId, quantity)
    const nextStack = [...stack, itemId]
    const descendants = new Map<number, number>()
    recipe.ingredient_ids.forEach((ingredientId, index) => {
      const childId = Number(ingredientId)
      const childQuantity = quantity * Number(recipe.quantities[index] || 0)
      addQuantity(descendants, childId, childQuantity)
      expand(childId, childQuantity, depth + 1, nextStack).forEach((descendantQuantity, descendantId) => {
        addQuantity(descendants, descendantId, descendantQuantity)
      })
    })
    descendants.forEach((descendantQuantity, descendantId) => addDependency(parentKey, descendantId, descendantQuantity))
    return descendants
  }

  selected.forEach((entry) => expand(entry.itemId, entry.quantity, 0))

  return {
    direct: makeLines('direct', direct, data.items),
    subcrafts: makeLines('subcraft', subcrafts, data.items),
    ingredients: makeLines('ingredient', ingredients, data.items),
    noncraftable: makeLines('noncraftable', noncraftable, data.items),
    dependencies: Object.fromEntries(Array.from(dependencies.entries()).map(([lineKey, quantities]) => [
      lineKey,
      Object.fromEntries(quantities),
    ])),
  }
}

export function craftPlanLines(plan: CraftPlan): CraftLine[] {
  return [...plan.direct, ...plan.noncraftable, ...plan.subcrafts, ...plan.ingredients]
}
