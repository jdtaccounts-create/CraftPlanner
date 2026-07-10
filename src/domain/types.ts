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
  criterions?: string
  quests_that_use?: number[]
  quests_that_reward?: number[]
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

export interface HarvestableResource {
  item_id: number
  job: string
  rarity: 'normal' | 'rare' | 'meat'
  source_item_id?: number
  source_monster_id?: number
  source_monster_name?: string
  order: number
}

export interface ResourceOrigin {
  item_id: number
  origins: Array<{
    monster_id: number
    monster_name: string
    race_id: number | null
    race_name: string
    super_race_id: number | null
    super_race_name: string
    min_level: number | null
    max_level: number | null
    drop_rate: number
    has_criterions: boolean
  }>
}

export interface SortMetadata {
  harvestables: Record<string, HarvestableResource>
  resourceOrigins: Record<string, ResourceOrigin>
}

export interface CatalogData {
  items: Record<string, CatalogItem>
  recipes: Record<string, Recipe>
  itemSets: Record<string, ItemSet>
  metadata: Record<string, unknown>
  recipeExclusions?: RecipeExclusions
  sortMetadata?: SortMetadata
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
