import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createMockServer } from './mock-server.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const extensionDir = path.resolve(__dirname, '..')
const userDataDir = path.resolve(__dirname, '.tmp-smoke-profile')
const targetUrl = process.env.YTG_SMOKE_URL || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'

async function waitForAnyText(page, texts, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await page.evaluate(candidates => {
      const allText = document.body?.innerText || ''
      return candidates.find(text => allText.includes(text)) || ''
    }, texts)
    if (found) {
      return found
    }
    await page.waitForTimeout(150)
  }
  throw new Error(`Timed out waiting for one of: ${texts.join(', ')}`)
}

async function run() {
  const mock = createMockServer()
  await mock.start(9875)

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`
    ],
    acceptDownloads: true
  })

  try {
    const page = context.pages()[0] || (await context.newPage())
    await context.addCookies([{
      name: 'CONSENT',
      value: 'YES+cb.20210328-17-p0.en+FX+123',
      domain: '.youtube.com',
      path: '/',
      secure: true,
      sameSite: 'None'
    }])
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })

    const trigger = page.locator('#ytg-trigger')
    await trigger.waitFor({ timeout: 45000 })
    await trigger.click()

    const panel = page.locator('#ytg-panel')
    await panel.waitFor({ timeout: 15000 })

    const downloadButton = page.locator('#ytg-download')
    await downloadButton.waitFor({ timeout: 15000 })
    await downloadButton.click()

    await waitForAnyText(page, ['Fichier prêt, lancement...', 'Téléchargement navigateur refusé'], 30000)

    if (mock.state.downloadCalls < 1) {
      throw new Error('Smoke failed: /download was never called')
    }
    if (mock.state.progressCalls < 1) {
      throw new Error('Smoke failed: /progress was never called')
    }

    console.log('Smoke OK')
    console.log(`downloadCalls=${mock.state.downloadCalls}`)
    console.log(`progressCalls=${mock.state.progressCalls}`)
    console.log(`fileCalls=${mock.state.fileCalls}`)
    console.log(`downloadPayload=${JSON.stringify(mock.state.lastDownloadBody)}`)
  } finally {
    await context.close().catch(() => {})
    await mock.stop().catch(() => {})
  }
}

run().catch(err => {
  console.error(err?.stack || String(err))
  process.exit(1)
})
