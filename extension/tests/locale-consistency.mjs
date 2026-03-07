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

  validateLocaleShape('en', en)
  validateLocaleShape('fr', fr)
  validatePlaceholderParity(en, fr)

  console.log(`Locale consistency OK (${enKeys.length} keys)`)
}

function validateLocaleShape(locale, messages) {
  for (const [key, entry] of Object.entries(messages)) {
    if (!entry || typeof entry.message !== 'string' || entry.message.length === 0) {
      throw new Error(`Locale ${locale}:${key} must define a non-empty message`)
    }

    const placeholders = entry.placeholders || {}
    const tokens = [...entry.message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)].map(match => match[1])

    for (const token of tokens) {
      if (!Object.prototype.hasOwnProperty.call(placeholders, token)) {
        throw new Error(`Locale ${locale}:${key} references $${token}$ without a matching placeholders entry`)
      }
    }

    for (const [placeholderName, placeholder] of Object.entries(placeholders)) {
      if (!placeholder || typeof placeholder.content !== 'string' || !/^\$\d+$/.test(placeholder.content)) {
        throw new Error(`Locale ${locale}:${key} placeholder ${placeholderName} must use content like "$1"`)
      }
    }
  }
}

function validatePlaceholderParity(en, fr) {
  for (const key of Object.keys(en)) {
    const enPlaceholders = Object.keys(en[key].placeholders || {}).sort()
    const frPlaceholders = Object.keys(fr[key].placeholders || {}).sort()
    if (JSON.stringify(enPlaceholders) !== JSON.stringify(frPlaceholders)) {
      throw new Error(`Locale placeholder mismatch for ${key}. en=${enPlaceholders.join(',')} fr=${frPlaceholders.join(',')}`)
    }
  }
}

run().catch(error => {
  console.error(error?.stack || String(error))
  process.exit(1)
})
