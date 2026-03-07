import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const extensionDir = path.resolve(__dirname, '..')

async function readFixture(relativePath) {
  return fs.readFile(path.join(extensionDir, relativePath), 'utf8')
}

async function installChromeMock(page, messages) {
  const script = `
    (() => {
      const localeMessages = ${JSON.stringify(messages)};
      const listeners = []
      const state = {
        token: '1'.repeat(64),
      serverState: {
        state: 'offline',
        reason: 'server_offline',
        version: '',
        commit: ''
      }
    }

    function getMessage(key, substitutions) {
      const entry = localeMessages[key]
      if (!entry?.message) return ''
      const values = Array.isArray(substitutions) ? substitutions : substitutions === undefined ? [] : [String(substitutions)]
      let text = entry.message
      values.forEach((value, index) => {
        text = text.split('$' + String(index + 1) + '$').join(String(value))
      })
      return text
    }

    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          sendMessage(message, callback) {
            if (message.action === 'getApiToken') {
              callback?.({ ok: true, token: state.token })
              return
            }
            if (message.action === 'getServerState' || message.action === 'refreshServerState') {
              callback?.({ ok: true, serverState: state.serverState })
              return
            }
            callback?.({ ok: false, errorCode: 'unknown_action' })
          },
          onMessage: {
            addListener(listener) {
              listeners.push(listener)
            }
          }
        },
        i18n: {
          getMessage
        }
      }
    })
    })();
  `

  await page.addScriptTag({ content: script })
}

async function run() {
  const [messages, popupHtmlRaw, popupScript] = await Promise.all([
    readFixture('_locales/en/messages.json').then(JSON.parse),
    readFixture('popup.html'),
    readFixture('popup.js')
  ])

  const popupHtml = popupHtmlRaw.replace(/\s*<script src="popup\.js"><\/script>\s*/u, '\n')
  const browser = await chromium.launch({ headless: true })

  try {
    const page = await browser.newPage()
    await page.setContent(popupHtml, { waitUntil: 'domcontentloaded' })
    await installChromeMock(page, messages)
    await page.addScriptTag({ content: popupScript })

    await page.waitForFunction(() => {
      const label = document.querySelector('#label')
      return label?.textContent?.includes('Local server offline') === true
    }, { timeout: 12000 })

    const hint = await page.locator('#hint').innerText()
    if (!hint.includes('systemctl --user start ytgrabber')) {
      throw new Error(`Smoke offline failed: missing troubleshooting hint, got: ${hint}`)
    }

    console.log('Smoke offline OK')
  } finally {
    await browser.close().catch(() => {})
  }
}

run().catch(error => {
  console.error(error?.stack || String(error))
  process.exit(1)
})
