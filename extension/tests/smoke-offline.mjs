import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const extensionDir = path.resolve(__dirname, '..')
const userDataDir = path.resolve(__dirname, '.tmp-smoke-offline-profile')

async function resolveExtensionId(context) {
  let worker = context.serviceWorkers()[0]
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 15000 })
  }
  const match = worker.url().match(/^chrome-extension:\/\/([^/]+)\//)
  if (!match) {
    throw new Error(`Unable to resolve extension id from worker URL: ${worker.url()}`)
  }
  return match[1]
}

async function run() {
  await fs.rm(userDataDir, { recursive: true, force: true })

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`
    ]
  })

  try {
    const extensionId = await resolveExtensionId(context)
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 20000 })

    await page.waitForFunction(() => {
      const label = document.querySelector('#label')
      return label?.textContent?.includes('Serveur introuvable') === true
    }, { timeout: 12000 })

    const hint = await page.locator('#hint').innerText()
    if (!hint.includes('systemctl --user start ytgrabber')) {
      throw new Error(`Smoke offline failed: missing troubleshooting hint, got: ${hint}`)
    }

    console.log('Smoke offline OK')
  } finally {
    await context.close().catch(() => {})
  }
}

run().catch(err => {
  console.error(err?.stack || String(err))
  process.exit(1)
})
