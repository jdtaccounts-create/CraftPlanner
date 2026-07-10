import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'data', 'generated')
const itemsPath = join(outDir, 'items.json')
const API_URL = 'https://api.dofusdb.fr'
const PAGE_LIMIT = 50
const PAGE_CONCURRENCY = 6
const REQUEST_RETRIES = 3
const PROTECTOR_RACES = new Set([62, 63, 64, 65, 66])
const JOB_BY_PROTECTOR_RACE = {
  62: 'Paysan',
  63: 'Mineur',
  64: 'Bucheron',
  65: 'Pecheur',
  66: 'Alchimiste',
}
const JOB_BY_TYPE = {
  Bois: 'Bucheron',
  Minerai: 'Mineur',
  'Céréale': 'Paysan',
  Poisson: 'Pecheur',
  Fleur: 'Alchimiste',
  Plante: 'Alchimiste',
  Graine: 'Alchimiste',
}
const JOB_ORDER = {
  Bucheron: 10,
  Mineur: 20,
  Paysan: 30,
  Pecheur: 40,
  Alchimiste: 50,
  Chasseur: 60,
}
const EXCLUDED_PROTECTOR_DROP_TYPES = new Set(['Quêtes principales', 'Mots de haïku'])
const ARCHMONSTER_RACE_ID = 78
const ARCHMONSTER_SUPER_RACE_ID = 20

async function apiGet(path, params = {}) {
  const url = new URL(`${API_URL}${path}`)
  Object.entries(params).forEach(([key, value]) => {
    if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(key, String(entry)))
    else url.searchParams.set(key, String(value))
  })
  let lastError
  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`${url} -> ${response.status}`)
      return response.json()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, attempt * 500))
    }
  }
  throw lastError
}

async function fetchAll(path, params = {}) {
  const first = await apiGet(path, { ...params, $limit: PAGE_LIMIT, $skip: 0 })
  const rows = [...(first.data || [])]
  const pages = []
  for (let skip = PAGE_LIMIT; skip < Number(first.total || 0); skip += PAGE_LIMIT) {
    pages.push(apiGet(path, { ...params, $limit: PAGE_LIMIT, $skip: skip }))
  }
  for (let index = 0; index < pages.length; index += PAGE_CONCURRENCY) {
    const chunk = pages.slice(index, index + PAGE_CONCURRENCY)
    for (const page of await Promise.all(chunk)) rows.push(...(page.data || []))
  }
  return rows
}

function frName(raw, fallback = '') {
  return raw?.name?.fr || raw?.slug?.fr || fallback
}

function maxDropRate(drop) {
  return Math.max(
    Number(drop.percentDropForGrade1) || 0,
    Number(drop.percentDropForGrade2) || 0,
    Number(drop.percentDropForGrade3) || 0,
    Number(drop.percentDropForGrade4) || 0,
    Number(drop.percentDropForGrade5) || 0,
    Number(drop.maxPercentDrop) || 0,
  )
}

function levels(monster) {
  const values = (monster.grades || []).map((grade) => Number(grade.level)).filter(Number.isFinite)
  return {
    min_level: values.length ? Math.min(...values) : null,
    max_level: values.length ? Math.max(...values) : null,
  }
}

function addHarvestable(rows, item, patch) {
  if (!item) return
  const existing = rows.get(String(item.id))
  const next = {
    item_id: item.id,
    job: patch.job,
    rarity: patch.rarity,
    order: patch.order,
    ...(patch.source_item_id ? { source_item_id: patch.source_item_id } : {}),
    ...(patch.source_monster_id ? { source_monster_id: patch.source_monster_id } : {}),
    ...(patch.source_monster_name ? { source_monster_name: patch.source_monster_name } : {}),
  }
  if (!existing || next.order < existing.order || existing.rarity !== 'normal') rows.set(String(item.id), next)
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort((a, b) => Number(a[0]) - Number(b[0])))
}

async function main() {
  const items = JSON.parse(await readFile(itemsPath, 'utf8'))
  const itemValues = Object.values(items)
  const itemById = (id) => items[String(id)]
  const harvestables = new Map()

  const sackItems = itemValues.filter((item) => item.type_name === 'Sac de ressources')
  let sackOrder = 0
  for (const sack of sackItems) {
    const raw = await apiGet(`/items/${sack.id}`)
    const effect = (raw.possibleEffects || []).find((candidate) => Number.isFinite(Number(candidate.value)))
    const item = itemById(Number(effect?.value))
    const job = JOB_BY_TYPE[item?.type_name]
    if (item && job && Number(effect?.diceSide) === 50) {
      addHarvestable(harvestables, item, {
        job,
        rarity: 'normal',
        source_item_id: sack.id,
        order: (JOB_ORDER[job] * 1000) + sackOrder,
      })
      sackOrder += 1
    }
  }

  itemValues
    .filter((item) => item.type_name === 'Viande')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    .forEach((item, index) => addHarvestable(harvestables, item, {
      job: 'Chasseur',
      rarity: 'meat',
      order: JOB_ORDER.Chasseur * 1000 + index,
    }))

  const races = await fetchAll('/monster-races')
  const raceById = new Map(races.map((race) => [Number(race.id), race]))
  const superRaces = await fetchAll('/monster-super-races')
  const superRaceById = new Map(superRaces.map((race) => [Number(race.id), race]))
  const protectorRaceIds = new Set(races
    .filter((race) => /Protecteurs/i.test(frName(race)) || PROTECTOR_RACES.has(Number(race.id)))
    .map((race) => Number(race.id)))

  const monsters = await fetchAll('/monsters', {
    '$select[]': ['id', 'name', 'race', 'isBoss', 'isMiniBoss', 'isQuestMonster', 'grades', 'drops'],
  })

  const rareCounters = new Map()
  const resourceOrigins = new Map()
  for (const monster of monsters) {
    const race = raceById.get(Number(monster.race))
    const superRace = superRaceById.get(Number(race?.superRaceId))
    const isProtector = protectorRaceIds.has(Number(monster.race))
    const isArchmonster = Number(monster.race) === ARCHMONSTER_RACE_ID || Number(race?.superRaceId) === ARCHMONSTER_SUPER_RACE_ID
    const monsterName = frName(monster, `Monstre ${monster.id}`)
    const monsterLevels = levels(monster)

    for (const drop of monster.drops || []) {
      const item = itemById(Number(drop.objectId))
      if (!item || drop.disableDropModificator) continue
      const dropRate = maxDropRate(drop)
      if (dropRate <= 0) continue

      if (isProtector) {
        const job = JOB_BY_PROTECTOR_RACE[Number(monster.race)]
        if (job && job !== 'Mineur' && dropRate <= 5 && !EXCLUDED_PROTECTOR_DROP_TYPES.has(item.type_name)) {
          const order = (JOB_ORDER[job] * 1000) + 500 + (rareCounters.get(job) || 0)
          rareCounters.set(job, (rareCounters.get(job) || 0) + 1)
          addHarvestable(harvestables, item, {
            job,
            rarity: 'rare',
            source_monster_id: Number(monster.id),
            source_monster_name: monsterName,
            order,
          })
        }
        continue
      }

      if (item.item_type_category_id !== 2 && item.item_type_category_id !== 3) continue
      if (isArchmonster) continue
      if (drop.isGlobal || /^Sc!|Az=|HA=|HS=/.test(String(drop.criterions || ''))) continue
      const key = String(item.id)
      const origin = {
        monster_id: Number(monster.id),
        monster_name: monsterName,
        race_id: Number.isFinite(Number(monster.race)) ? Number(monster.race) : null,
        race_name: frName(race),
        super_race_id: Number.isFinite(Number(race?.superRaceId)) ? Number(race.superRaceId) : null,
        super_race_name: frName(superRace),
        ...monsterLevels,
        drop_rate: dropRate,
        has_criterions: Boolean(drop.hasCriterions),
      }
      if (!resourceOrigins.has(key)) resourceOrigins.set(key, { item_id: item.id, origins: [] })
      resourceOrigins.get(key).origins.push(origin)
    }
  }

  for (const origin of resourceOrigins.values()) {
    origin.origins.sort((a, b) =>
      Number(a.has_criterions) - Number(b.has_criterions)
      || b.drop_rate - a.drop_rate
      || a.race_name.localeCompare(b.race_name, 'fr')
      || a.monster_name.localeCompare(b.monster_name, 'fr'))
    origin.origins = origin.origins.slice(0, 12)
  }

  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'harvestable_resources.json'), `${JSON.stringify(sortedObject(harvestables), null, 2)}\n`)
  await writeFile(join(outDir, 'resource_origins.json'), `${JSON.stringify(sortedObject(resourceOrigins), null, 2)}\n`)
  console.log(`Ressources de métiers : ${harvestables.size}`)
  console.log(`Origines de ressources mobs : ${resourceOrigins.size}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
