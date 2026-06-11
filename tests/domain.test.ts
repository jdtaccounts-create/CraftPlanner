import assert from 'node:assert/strict'
import test from 'node:test'
import { createCatalogSearchIndex, itemCategory, searchCatalog } from '../src/domain/catalog.ts'
import { buildCraftPlan } from '../src/domain/craft.ts'
import { allocateOwned, setCraftLineAllocation, setCraftLineComplete, toggleOwned } from '../src/domain/possession.ts'
import { addItemSet, addSelectedItem, parseItemLine, parseItemList, splitItemLines } from '../src/domain/selection.ts'
import type { CatalogData, CatalogItem } from '../src/domain/types.ts'

function item(id: number, name: string, categoryId = 2): CatalogItem {
  return {
    id,
    name,
    raw_type: categoryId === 0 ? 'Equipement' : 'Ressource',
    type_id: id,
    type_name: '',
    item_type_category_id: categoryId,
    image_path: '',
  }
}

const data: CatalogData = {
  items: {
    1: item(1, 'Objet final', 0),
    2: item(2, 'Sous-craft', 0),
    3: item(3, 'Bois'),
    4: item(4, 'Pierre'),
    5: item(5, 'Objet non craftable', 0),
  },
  recipes: {
    1: { result_id: 1, ingredient_ids: [2, 3], quantities: [2, 3] },
    2: { result_id: 2, ingredient_ids: [3, 4], quantities: [5, 7] },
  },
  itemSets: {},
  metadata: {},
  recipeExclusions: { item_ids: [], name_patterns: [] },
}

test('catégorise depuis categoryId sans fallback équipement', () => {
  assert.equal(itemCategory(item(1, 'A', 0)), 'Equipement')
  assert.equal(itemCategory(item(2, 'B', 1)), 'Consommable')
  assert.equal(itemCategory(item(3, 'C', 2)), 'Ressource')
  assert.equal(itemCategory(item(4, 'D', 3)), 'Ressource')
  assert.equal(itemCategory(item(5, 'E', 99)), null)
})

test('comprend les séparateurs de quantité usuels', () => {
  assert.deepEqual(parseItemLine('3 x Bois'), { quantity: 3, name: 'Bois' })
  assert.deepEqual(parseItemLine('Bois x 4'), { quantity: 4, name: 'Bois' })
  assert.deepEqual(parseItemLine('Bois\t4'), { quantity: 4, name: 'Bois' })
  assert.deepEqual(parseItemLine('• Bois x 1 234'), { quantity: 1234, name: 'Bois' })
  assert.deepEqual(parseItemLine('[5] Bois'), { quantity: 5, name: 'Bois' })
  assert.deepEqual(parseItemLine("10 x Graine de Scorbute (si vous décidez de suivre Danathor)."), { quantity: 10, name: 'Graine de Scorbute' })
  assert.deepEqual(parseItemLine('Bois'), { quantity: 1, name: 'Bois' })
  assert.deepEqual(splitItemLines('1 x Slip (item équipable, vous ne le perdez pas).\n2 x Bois'), [
    '1 x Slip (item équipable, vous ne le perdez pas).',
    '2 x Bois',
  ])
})

test('agrège collage, doublons et panoplies', () => {
  const parsed = parseItemList(data.items, {
    1: { id: 1, name: 'Panoplie test', name_norm: 'panoplie test', compact: 'panoplietest', item_ids: [1, 3] },
  }, '2 x Bois\nBois:3\nObjet final\n2 x Panoplie test')
  assert.deepEqual(parsed.found, [
    { itemId: 3, quantity: 7 },
    { itemId: 1, quantity: 3 },
  ])
  assert.equal(parsed.matchedLines, 4)
  assert.equal(parsed.matchedSets, 1)
  assert.deepEqual(addItemSet(addSelectedItem([], 1, 2), [1, 2]), [
    { itemId: 1, quantity: 3 },
    { itemId: 2, quantity: 1 },
  ])
})

test('gère les fautes mesurées et les choix avec ou', () => {
  const encyclopediaPotato = { ...item(3, 'Pommes de Terre épluchées'), item_type_in_encyclopedia: true }
  const parsed = parseItemList({
    1: item(1, 'Or'),
    2: item(2, 'Pomme de Terre'),
    3: encyclopediaPotato,
    4: item(4, 'Graine de Scorbute'),
    5: item(5, 'Mandragore'),
    6: { ...item(6, 'Pommes de Terre Épluchées'), type_id: 999 },
  }, {}, "35 x Or.\n25 x Pomme de Terre ou Pommes de Terre épluchées.\n10 x Graine de Scorbute (commentaire).\n3 x Mandragorre\n2 x Orr")
  assert.deepEqual(parsed.found, [
    { itemId: 1, quantity: 35 },
    { itemId: 4, quantity: 10 },
    { itemId: 5, quantity: 3 },
  ])
  assert.equal(parsed.choices.length, 1)
  assert.deepEqual(parsed.choices[0].options.map((option) => option.entries[0]), [
    { itemId: 2, quantity: 25 },
    { itemId: 3, quantity: 25 },
  ])
  assert.deepEqual(parsed.missed, ['2 x Orr'])
})

test('recherche via un index pré-normalisé', () => {
  const index = createCatalogSearchIndex(data.items, {
    1: { id: 1, name: 'Panoplie finale', name_norm: 'panoplie finale', compact: 'panopliefinale', item_ids: [1] },
  })
  assert.equal(searchCatalog(index, 'objet final')[0]?.kind, 'item')
  assert.equal(searchCatalog(index, 'panoplie finale')[0]?.kind, 'set')
})

test('décompose les crafts et agrège les ressources communes', () => {
  const plan = buildCraftPlan(data, [{ itemId: 1, quantity: 2 }, { itemId: 5, quantity: 3 }])
  assert.equal(plan.direct.find((line) => line.itemId === 1)?.quantity, 2)
  assert.equal(plan.subcrafts.find((line) => line.itemId === 2)?.quantity, 4)
  assert.equal(plan.ingredients.find((line) => line.itemId === 3)?.quantity, 26)
  assert.equal(plan.ingredients.find((line) => line.itemId === 4)?.quantity, 28)
  assert.equal(plan.noncraftable.find((line) => line.itemId === 5)?.quantity, 3)
  assert.deepEqual(plan.dependencies['direct:1'], { 2: 4, 3: 26, 4: 28 })
  assert.deepEqual(plan.dependencies['subcraft:2'], { 3: 20, 4: 28 })
})

test('arrête la décomposition des recettes curatées comme les Éklâmes', () => {
  const eklameData: CatalogData = {
    items: {
      10: item(10, "Pierre d'âme", 1),
      11: item(11, 'Éklâme suprême'),
      12: item(12, 'Éklâme majestueuse'),
    },
    recipes: {
      10: { result_id: 10, ingredient_ids: [11], quantities: [10] },
      11: { result_id: 11, ingredient_ids: [12], quantities: [4] },
    },
    itemSets: {},
    metadata: {},
    recipeExclusions: { item_ids: [], name_patterns: ['eklame'] },
  }
  const plan = buildCraftPlan(eklameData, [{ itemId: 10, quantity: 1 }])
  assert.equal(plan.ingredients.find((line) => line.itemId === 11)?.quantity, 10)
  assert.equal(plan.subcrafts.length, 0)
  assert.equal(plan.ingredients.some((line) => line.itemId === 12), false)
})

test('la quantité fine pilote automatiquement la coche', () => {
  assert.deepEqual(toggleOwned({}, 3, 23), { 3: 23 })
  assert.deepEqual(toggleOwned({ 3: 23 }, 3, 23), {})
})

test('une quantité possédée ne remplit jamais deux lignes agrégées', () => {
  const lines = [
    { lineKey: 'direct:2', itemId: 2, quantity: 2, role: 'direct', name: '', rawType: '', imagePath: '' },
    { lineKey: 'subcraft:2', itemId: 2, quantity: 5, role: 'subcraft', name: '', rawType: '', imagePath: '' },
  ] as const
  assert.deepEqual(allocateOwned([...lines], { 2: 4 }), { 'direct:2': 2, 'subcraft:2': 2 })
  assert.deepEqual(setCraftLineComplete({}, [...lines], 'direct:2', true), { 2: 2 })
  assert.deepEqual(setCraftLineComplete({ 2: 7 }, [...lines], 'direct:2', false), {})
})

test('un item principal également sous-craft est alloué une seule fois, principal en premier', () => {
  const lines = [
    { lineKey: 'direct:2', itemId: 2, quantity: 1, role: 'direct', name: '', rawType: '', imagePath: '' },
    { lineKey: 'subcraft:2', itemId: 2, quantity: 3, role: 'subcraft', name: '', rawType: '', imagePath: '' },
  ] as const
  assert.deepEqual(allocateOwned([...lines], { 2: 3 }), { 'direct:2': 1, 'subcraft:2': 2 })
  assert.deepEqual(setCraftLineAllocation({}, [...lines], 'subcraft:2', 3), { 2: 4 })
})

test('baisser un ingrédient ne défait pas un craft terminé', () => {
  const owned = { 1: 1, 3: 10 }
  assert.deepEqual(toggleOwned(owned, 3, 10), { 1: 1 })
})
