import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const items = JSON.parse(readFileSync(join(root, 'public', 'data', 'generated', 'items.json'), 'utf8'))
const missing = Object.values(items).filter((item) => {
  if (!item.image_path || /^https?:\/\//.test(item.image_path)) return false
  return !existsSync(join(root, 'public', item.image_path.replace(/\\/g, '/')))
})
const referenced = new Set(Object.values(items)
  .map((item) => String(item.image_path || '').replace(/\\/g, '/'))
  .filter((path) => path.startsWith('cache/images/'))
  .map((path) => path.slice('cache/images/'.length)))
const orphaned = (await import('node:fs/promises')).readdir(join(root, 'public', 'cache', 'images'))
  .then((files) => files.filter((file) => file.endsWith('.png') && !referenced.has(file)))

if (missing.length) {
  console.error(`Images embarquées manquantes : ${missing.length}`)
  console.error(missing.slice(0, 20).map((item) => `${item.id} ${item.name}`).join('\n'))
  process.exitCode = 1
} else {
  const orphans = await orphaned
  if (orphans.length) {
    console.error(`Images embarquées orphelines : ${orphans.length}`)
    process.exitCode = 1
  } else {
    console.log(`Images embarquées vérifiées : ${Object.keys(items).length} items, ${referenced.size} fichiers uniques`)
  }
}
