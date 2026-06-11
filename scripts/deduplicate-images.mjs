import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const itemsPath = join(root, 'public', 'data', 'generated', 'items.json')
const imagesDir = join(root, 'public', 'cache', 'images')
const items = JSON.parse(await readFile(itemsPath, 'utf8'))
const files = (await readdir(imagesDir)).filter((name) => name.endsWith('.png')).sort((a, b) =>
  Number(a.slice(0, -4)) - Number(b.slice(0, -4)))
const canonicalByHash = new Map()
let removed = 0

for (const file of files) {
  const bytes = await readFile(join(imagesDir, file))
  const hash = createHash('sha256').update(bytes).digest('hex')
  const canonical = canonicalByHash.get(hash)
  if (!canonical) {
    canonicalByHash.set(hash, file)
    continue
  }

  const itemId = file.slice(0, -4)
  if (items[itemId]) items[itemId].image_path = `cache\\images\\${canonical}`
  await unlink(join(imagesDir, file))
  removed += 1
}

for (const item of Object.values(items)) {
  const path = String(item.image_path || '').replace(/\\/g, '/')
  if (path.startsWith('cache/images/') && !existsSync(join(root, 'public', path))) {
    throw new Error(`Image canonique manquante pour ${item.id}: ${item.image_path}`)
  }
}

await writeFile(itemsPath, `${JSON.stringify(items, null, 2)}\n`)
console.log(`Images dédupliquées : ${removed} copies supprimées, ${canonicalByHash.size} fichiers conservés`)
