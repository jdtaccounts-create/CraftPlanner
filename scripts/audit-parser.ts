import fs from 'node:fs'
import { parseItemList } from '../src/domain/selection'
import type { CatalogItem, ItemSet } from '../src/domain/types'

const items = JSON.parse(fs.readFileSync('public/data/generated/items.json', 'utf8')) as Record<string, CatalogItem>
const itemSets = JSON.parse(fs.readFileSync('public/data/generated/item_sets.json', 'utf8')) as Record<string, ItemSet>
const input = fs.readFileSync(0, 'utf8')
const parsed = parseItemList(items, itemSets, input)

console.log(JSON.stringify({
  found: parsed.found.map((entry) => ({ name: items[String(entry.itemId)]?.name, quantity: entry.quantity })),
  choices: parsed.choices.map((choice) => ({ source: choice.source, options: choice.options.map((option) => option.label) })),
  missed: parsed.missed,
}, null, 2))
