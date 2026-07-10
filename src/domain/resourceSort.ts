import type { CatalogData, CatalogItem, CraftLine } from './types'

export type SortContext = 'selection' | 'craft'

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
  harvestables?: Record<string, HarvestableResource>
  resourceOrigins?: Record<string, ResourceOrigin>
}

const JOB_ORDER: Record<string, number> = {
  Bucheron: 10,
  Mineur: 20,
  Paysan: 30,
  Pecheur: 40,
  Alchimiste: 50,
  Chasseur: 60,
}

function harvestableRank(item: CatalogItem, metadata?: SortMetadata): [number, number, string] {
  const harvestable = metadata?.harvestables?.[String(item.id)]
  if (!harvestable) return [9, 9999, '']
  const rarityRank = harvestable.rarity === 'normal' ? 0 : harvestable.rarity === 'rare' ? 1 : 2
  const bucket = harvestable.rarity === 'rare' ? 1 : 0
  return [bucket, JOB_ORDER[harvestable.job] || 999, `${rarityRank}:${harvestable.order}`]
}

function originRank(item: CatalogItem, metadata?: SortMetadata): [number, string, number] {
  const origin = metadata?.resourceOrigins?.[String(item.id)]
  if (!origin?.origins.length) return [8, '', 9999]
  const first = origin.origins[0]
  return [1, first.race_name || first.super_race_name || first.monster_name, first.min_level || 9999]
}

function baseRank(item: CatalogItem, metadata?: SortMetadata): string {
  const [harvestableBucket, jobOrder, harvestOrder] = harvestableRank(item, metadata)
  if (harvestableBucket < 9) return `${harvestableBucket}:${jobOrder}:${harvestOrder}`
  const [originBucket, originLabel, originLevel] = originRank(item, metadata)
  if (originBucket === 1) return `1:${originLabel}:${originLevel}`
  return `9:${item.type_name || item.raw_type || ''}`
}

export function compareCatalogItems(
  data: CatalogData,
  a: CatalogItem,
  b: CatalogItem,
): number {
  const rankA = baseRank(a, data.sortMetadata)
  const rankB = baseRank(b, data.sortMetadata)
  return rankA.localeCompare(rankB, 'fr')
    || (a.type_name || a.raw_type || '').localeCompare(b.type_name || b.raw_type || '', 'fr')
    || a.name.localeCompare(b.name, 'fr')
    || a.id - b.id
}

export function compareCraftLines(data: CatalogData, a: CraftLine, b: CraftLine): number {
  const itemA = data.items[String(a.itemId)]
  const itemB = data.items[String(b.itemId)]
  if (!itemA || !itemB) return a.name.localeCompare(b.name, 'fr')
  return compareCatalogItems(data, itemA, itemB)
}
