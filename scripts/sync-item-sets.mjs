import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const API_URL = 'https://api.dofusdb.fr/item-sets'
const LIMIT = 50
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'generated')

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr-FR')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function page(skip) {
  const response = await fetch(`${API_URL}?%24limit=${LIMIT}&%24skip=${skip}`)
  if (!response.ok) throw new Error(`DofusDB ${response.status} ${response.statusText}`)
  return response.json()
}

const first = await page(0)
const pages = [first]
for (let skip = LIMIT; skip < first.total; skip += LIMIT) pages.push(await page(skip))

const rows = pages.flatMap((entry) => entry.data || [])
const itemSets = Object.fromEntries(rows.map((raw) => {
  const name = raw.name?.fr || raw.slug?.fr || `Panoplie ${raw.id}`
  return [String(raw.id), {
    id: Number(raw.id),
    name,
    name_norm: normalizeText(name),
    compact: normalizeText(name).replace(/\s/g, ''),
    item_ids: (raw.items || []).map((item) => Number(item.id)).filter(Number.isFinite),
  }]
}))

await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, 'item_sets.json'), `${JSON.stringify(itemSets, null, 2)}\n`)
console.log(`OK ${Object.keys(itemSets).length} panoplies`)
