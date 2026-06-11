import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = packageJson.version
const releaseTag = `v${version}`
const setupName = `CraftPlanner_${version}_x64-setup.exe`
const bundleDir = path.join(root, 'src-tauri', 'target', 'release', 'bundle')
const sigPath = path.join(bundleDir, 'nsis', `${setupName}.sig`)
const outPath = path.join(bundleDir, 'latest.json')

if (!fs.existsSync(sigPath)) throw new Error(`Signature introuvable: ${sigPath}`)

const latest = {
  version,
  notes: process.env.RELEASE_NOTES || 'Première version publique de CraftPlanner.',
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: fs.readFileSync(sigPath, 'utf8').trim(),
      url: `https://github.com/jdtaccounts-create/CraftPlanner/releases/download/${releaseTag}/${setupName}`,
    },
  },
}

fs.writeFileSync(outPath, `${JSON.stringify(latest, null, 2)}\n`)
console.log(outPath)
