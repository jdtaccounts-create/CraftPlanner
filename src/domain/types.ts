export const ITEM_CATEGORIES = ['Equipement', 'Consommable', 'Ressource'] as const

export type ItemCategory = (typeof ITEM_CATEGORIES)[number]

export interface CatalogItem {
  id: number
  name: string
  name_norm?: string
  compact?: string
  raw_type: string
  type_id: number | null
  type_name: string
  item_type_category_id: number | null
  item_type_in_encyclopedia?: boolean
  image_url?: string
  image_path: string
}

export interface Recipe {
  result_id: number
  ingredient_ids: number[]
  quantities: number[]
}

export interface ItemSet {
  id: number
  name: string
  name_norm: string
  compact: string
  item_ids: number[]
}

export interface RecipeExclusions {
  item_ids: number[]
  name_patterns: string[]
}

export interface CatalogData {
  items: Record<string, CatalogItem>
  recipes: Record<string, Recipe>
  itemSets: Record<string, ItemSet>
  metadata: Record<string, unknown>
  recipeExclusions?: RecipeExclusions
}

export interface SelectedItem {
  itemId: number
  quantity: number
}

export type CraftRole = 'direct' | 'subcraft' | 'ingredient' | 'noncraftable'

export interface CraftLine {
  lineKey: string
  itemId: number
  quantity: number
  role: CraftRole
  name: string
  rawType: string
  imagePath: string
}

export interface CraftPlan {
  direct: CraftLine[]
  subcrafts: CraftLine[]
  ingredients: CraftLine[]
  noncraftable: CraftLine[]
  dependencies: Record<string, Record<number, number>>
}
