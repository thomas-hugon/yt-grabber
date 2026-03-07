import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const extensionDir = path.resolve(__dirname, '..')

async function readLocale(name) {
  const filePath = path.join(extensionDir, '_locales', name, 'messages.json')
  const raw = await fs.readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

async function run() {
  const [en, fr] = await Promise.all([readLocale('en'), readLocale('fr')])
  const enKeys = Object.keys(en).sort()
  const frKeys = Object.keys(fr).sort()

  const missingInFr = enKeys.filter(key => !frKeys.includes(key))
  const missingInEn = frKeys.filter(key => !enKeys.includes(key))

  if (missingInFr.length || missingInEn.length) {
    throw new Error(`Locale mismatch. missingInFr=${missingInFr.join(',')} missingInEn=${missingInEn.join(',')}`)
  }

  console.log(`Locale consistency OK (${enKeys.length} keys)`)
}

run().catch(error => {
  console.error(error?.stack || String(error))
  process.exit(1)
})
