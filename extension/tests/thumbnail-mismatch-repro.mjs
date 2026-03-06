import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const extensionDir = path.resolve(__dirname, '..')
const userDataDir = path.resolve(__dirname, '.tmp-repro-profile')

async function waitForLocator(locator, timeout = 15000) {
  await locator.waitFor({ state: 'visible', timeout })
}

async function run() {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`
    ]
  })

  try {
    const page = context.pages()[0] || (await context.newPage())
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })

    await page.setContent(`
      <!doctype html>
      <html>
      <body>
        <ytd-video-renderer id="card">
          <div id="details">
            <a id="video-title" href="/watch?v=old111">Old Title</a>
          </div>
          <a id="thumbnail" href="/watch?v=old111">thumb</a>
          <div><div id="menu"></div></div>
        </ytd-video-renderer>
      </body>
      </html>
    `)

    await page.evaluate(() => {
      const token = 'a'.repeat(64)
      window.chrome = {
        runtime: {
          lastError: null,
          sendMessage(message, callback) {
            if (typeof callback !== 'function') return
            if (message?.action === 'getApiToken') {
              callback({ ok: true, token })
              return
            }
            if (message?.action === 'refreshHealth') {
              callback({ ok: true, isUp: true })
              return
            }
            callback({ ok: false })
          }
        }
      }
    })

    await page.addScriptTag({ path: path.join(extensionDir, 'content.js') })

    const btn = page.locator('.ytg-lockup-btn')
    await waitForLocator(btn)

    await page.evaluate(() => {
      const title = document.querySelector('#video-title')
      const thumb = document.querySelector('#thumbnail')
      if (!title || !thumb) {
        throw new Error('test card not found')
      }
      title.textContent = 'New Title'
      title.setAttribute('href', '/watch?v=new999')
      thumb.setAttribute('href', '/watch?v=new999')
    })

    await btn.click()

    const popupTitle = (await page.locator('#ytg-panel .ytg-title').innerText()).trim()
    const expectedTitle = (await page.locator('#video-title').innerText()).trim()

    if (popupTitle === expectedTitle) {
      console.log('PASS')
      console.log(`popupTitle=${JSON.stringify(popupTitle)}`)
      return
    }

    throw new Error(`Mismatch persists: popupTitle=${JSON.stringify(popupTitle)} cardTitle=${JSON.stringify(expectedTitle)}`)
  } finally {
    await context.close().catch(() => {})
  }
}

run().catch(err => {
  console.error(err?.stack || String(err))
  process.exit(1)
})
