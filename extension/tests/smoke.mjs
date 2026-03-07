import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const extensionDir = path.resolve(__dirname, '..')

function buildWatchPageHtml(title) {
  return `<!doctype html>
  <html>
    <body>
      <div id="above-the-fold">
        <h1><yt-formatted-string>${title}</yt-formatted-string></h1>
      </div>
      <div id="actions-inner">
        <div id="menu-container">
          <div id="menu"></div>
        </div>
      </div>
    </body>
  </html>`
}

function buildSearchPageHtml() {
  return `<!doctype html>
  <html>
    <body>
      <ytd-video-renderer id="search-card">
        <a id="thumbnail" href="/watch?v=search123">thumb</a>
        <div id="details">
          <a id="video-title" href="/watch?v=search123">Search Result Demo</a>
        </div>
        <div id="menu"></div>
      </ytd-video-renderer>
      <script>
        window.previewCounts = { pointerdown: 0, mousedown: 0, click: 0 }
        const card = document.getElementById('search-card')
        for (const type of Object.keys(window.previewCounts)) {
          card.addEventListener(type, () => {
            window.previewCounts[type] += 1
          })
        }
      </script>
    </body>
  </html>`
}

async function readFixture(relativePath) {
  return fs.readFile(path.join(extensionDir, relativePath), 'utf8')
}

async function installChromeMock(page, messages, scenario) {
  const script = `
    (() => {
      const localeMessages = ${JSON.stringify(messages)};
      const initialScenario = ${JSON.stringify(scenario)};
      const listeners = []
      const state = {
        token: initialScenario.initialToken,
        expectedToken: initialScenario.expectedToken,
        serverState: { ...initialScenario.serverState },
        formatResponse: initialScenario.formatResponse || { title: '', qualityOptions: ['best'] },
        formatFailure: initialScenario.formatFailure || null,
        jobSequence: Array.isArray(initialScenario.jobSequence) ? initialScenario.jobSequence : [],
        activeJobState: initialScenario.activeJobState || null,
        startDownloadBodies: [],
        openDownloadsCalls: 0,
        copiedText: ''
      }

      function normalizeSubstitutions(substitutions) {
        if (Array.isArray(substitutions)) return substitutions.map(value => String(value))
        if (substitutions === undefined || substitutions === null) return []
        return [String(substitutions)]
      }

      function getMessage(key, substitutions) {
        const entry = localeMessages[key]
        if (!entry?.message) return ''
        const values = normalizeSubstitutions(substitutions)
        let text = entry.message
        values.forEach((value, index) => {
          text = text.split('$' + String(index + 1) + '$').join(value)
        })
        return text
      }

      function broadcast(message) {
        listeners.forEach(listener => listener(message, {}, () => {}))
      }

      function makeActiveJob(message) {
        return {
          jobId: 'feedbeefcafecafe',
          jobToken: '0123456789abcdef0123456789abcdef',
          tabId: 1,
          pageUrl: location.href,
          videoUrl: message.url,
          title: message.title,
          status: 'queued',
          progress: 0,
          speed: '',
          eta: '',
          filename: '',
          error: '',
          errorCode: '',
          requestedFormat: message.requestedFormat,
          requestedQuality: message.requestedQuality,
          resolvedFormat: '',
          resolvedHeight: '',
          downloadState: 'pending',
          browserDownloadId: null,
          updatedAt: Date.now()
        }
      }

      function scheduleJobSequence() {
        state.jobSequence.forEach((step, index) => {
          setTimeout(() => {
            state.activeJobState = {
              ...state.activeJobState,
              ...step,
              downloadState: step.status === 'ready' ? 'accepted' : state.activeJobState.downloadState,
              updatedAt: Date.now()
            }
            broadcast({ type: 'ytg:activeJobStateChanged', activeJobState: state.activeJobState })
          }, 80 * (index + 1))
        })
      }

      async function handleMessage(message) {
        switch (message?.action) {
          case 'getServerState':
          case 'refreshServerState':
            return { ok: true, serverState: state.serverState }
          case 'getApiToken':
            return { ok: true, token: state.token }
          case 'setApiToken':
            state.token = message.token
            state.serverState = {
              ...(state.token === state.expectedToken
                ? { state: 'paired', reason: '', version: state.serverState.version, commit: state.serverState.commit }
                : { state: 'unpaired', reason: 'token_invalid', version: state.serverState.version, commit: state.serverState.commit })
            }
            broadcast({ type: 'ytg:serverStateChanged', serverState: state.serverState })
            return { ok: true, token: state.token, serverState: state.serverState }
          case 'getFormatOptions':
            if (state.formatFailure) {
              return { ok: false, errorCode: state.formatFailure.code }
            }
            return {
              ok: true,
              title: state.formatResponse.title,
              qualityOptions: state.formatResponse.qualityOptions.map(value => ({
                value,
                label: value === 'best' ? getMessage('qualityOptionBest') : getMessage('qualityOptionHeight', value)
              }))
            }
          case 'startDownloadJob':
            if (state.activeJobState) {
              return { ok: false, errorCode: 'job_requires_dismissal', activeJobState: state.activeJobState }
            }
            state.startDownloadBodies.push({
              url: message.url,
              title: message.title,
              format: message.requestedFormat,
              quality: message.requestedQuality
            })
            state.activeJobState = makeActiveJob(message)
            broadcast({ type: 'ytg:activeJobStateChanged', activeJobState: state.activeJobState })
            scheduleJobSequence()
            return { ok: true, activeJobState: state.activeJobState }
          case 'getActiveJobState':
            return { ok: true, activeJobState: state.activeJobState }
          case 'dismissActiveJob':
            state.activeJobState = null
            broadcast({ type: 'ytg:activeJobStateChanged', activeJobState: null })
            return { ok: true }
          case 'openDownloads':
            state.openDownloadsCalls += 1
            return { ok: true }
          default:
            return { ok: false, errorCode: 'unknown_action' }
        }
      }

      Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: {
          runtime: {
            sendMessage(message, callback) {
              handleMessage(message).then(response => {
                callback?.(response)
              })
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

      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            state.copiedText = text
            return Promise.resolve()
          }
        }
      })

      globalThis.__ytgTest = {
        state,
        getMessage
      }
    })();
  `

  await page.addScriptTag({ content: script })
}

async function waitForText(page, selector, expected, timeout = 12000) {
  await page.waitForFunction(
    ({ innerSelector, expectedText }) => {
      const node = document.querySelector(innerSelector)
      return node?.textContent?.includes(expectedText) === true
    },
    { innerSelector: selector, expectedText: expected },
    { timeout }
  )
}

async function runPopupScenario(browser, messages, popupHtml, popupScript) {
  const page = await browser.newPage()
  const scenario = {
    initialToken: '1'.repeat(64),
    expectedToken: 'e'.repeat(64),
    serverState: {
      state: 'unpaired',
      reason: 'token_invalid',
      version: 'v-smoke',
      commit: 'smoke00000000'
    }
  }

  await page.setContent(popupHtml, { waitUntil: 'domcontentloaded' })
  await installChromeMock(page, messages, scenario)
  await page.addScriptTag({ content: popupScript })

  await waitForText(page, '#label', 'Pairing required')
  await page.locator('#tokenInput').fill('e'.repeat(64))
  await page.locator('#saveTokenBtn').click()
  await waitForText(page, '#label', 'Server paired')

  const versionLine = await page.locator('#version').innerText()
  if (!versionLine.includes('v-smoke')) {
    throw new Error(`Popup paired state failed: missing version line (${versionLine})`)
  }

  const saveLabel = await page.locator('#saveTokenBtn').innerText()
  if (saveLabel !== 'Save token') {
    throw new Error(`Popup localization failed: expected "Save token", got "${saveLabel}"`)
  }
}

async function runWatchScenario(browser, messages, contentScript) {
  const page = await browser.newPage()
  const scenario = {
    initialToken: 'e'.repeat(64),
    expectedToken: 'e'.repeat(64),
    serverState: {
      state: 'paired',
      reason: '',
      version: 'v-smoke',
      commit: 'smoke00000000'
    },
    formatResponse: {
      title: 'Watch Flow Demo',
      qualityOptions: ['best', '720']
    },
    jobSequence: [
      {
        status: 'downloading',
        progress: 44.2,
        speed: '2.8MiB/s',
        eta: '00:07',
        title: 'Watch Flow Demo',
        filename: '',
        error: '',
        requestedFormat: 'mp4',
        requestedQuality: '720',
        resolvedFormat: '',
        resolvedHeight: ''
      },
      {
        status: 'processing',
        progress: 100,
        speed: '',
        eta: '',
        title: 'Watch Flow Demo',
        filename: '',
        error: '',
        requestedFormat: 'mp4',
        requestedQuality: '720',
        resolvedFormat: '',
        resolvedHeight: ''
      },
      {
        status: 'ready',
        progress: 100,
        speed: '',
        eta: '',
        title: 'Watch Flow Demo',
        filename: 'watch-flow.mp4',
        error: '',
        requestedFormat: 'mp4',
        requestedQuality: '720',
        resolvedFormat: 'mp4',
        resolvedHeight: '720'
      }
    ]
  }

  await page.route('https://www.youtube.com/**', async route => {
    await route.fulfill({ contentType: 'text/html', body: buildWatchPageHtml('Watch Flow Demo') })
  })
  await page.goto('https://www.youtube.com/watch?v=watch123', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await installChromeMock(page, messages, scenario)
  await page.addScriptTag({ content: contentScript })

  await page.waitForSelector('#ytg-trigger', { timeout: 12000 })
  await page.locator('#ytg-trigger').click()
  await waitForText(page, '#ytg-server-label', 'Server paired')
  await waitForText(page, '#ytg-quality-content', '720p')

  await page.locator('#ytg-quality-content button', { hasText: '720p' }).click()
  await page.locator('#ytg-download').click()
  await waitForText(page, '#ytg-status', 'Saved to Downloads')
  await page.waitForTimeout(1600)

  if (!(await page.locator('#ytg-panel').isVisible())) {
    throw new Error('Watch flow failed: success panel auto-dismissed')
  }

  const summary = await page.locator('#ytg-summary').innerText()
  if (!summary.includes('watch-flow.mp4') || !summary.includes('720p') || !summary.includes('MP4')) {
    throw new Error(`Watch flow failed: incomplete success summary ${summary}`)
  }

  const openDownloadsCalls = await page.evaluate(() => window.__ytgTest.state.openDownloadsCalls)
  if (openDownloadsCalls !== 0) {
    throw new Error(`Watch flow failed: open downloads called too early (${openDownloadsCalls})`)
  }

  await page.locator('#ytg-open-downloads').click()
  const updatedOpenDownloadsCalls = await page.evaluate(() => window.__ytgTest.state.openDownloadsCalls)
  if (updatedOpenDownloadsCalls !== 1) {
    throw new Error(`Watch flow failed: open downloads action did not reach background stub (${updatedOpenDownloadsCalls})`)
  }

  const lastDownloadBody = await page.evaluate(() => window.__ytgTest.state.startDownloadBodies.at(-1))
  if (lastDownloadBody?.format !== 'mp4' || lastDownloadBody?.quality !== '720') {
    throw new Error(`Watch flow failed: unexpected start body ${JSON.stringify(lastDownloadBody)}`)
  }

  await page.locator('#ytg-dismiss').click()
  await page.waitForFunction(() => !document.querySelector('#ytg-panel'), { timeout: 8000 })
}

async function runSearchScenario(browser, messages, contentScript) {
  const page = await browser.newPage()
  const scenario = {
    initialToken: 'e'.repeat(64),
    expectedToken: 'e'.repeat(64),
    serverState: {
      state: 'paired',
      reason: '',
      version: 'v-smoke',
      commit: 'smoke00000000'
    },
    formatFailure: { code: 'format_probe_failed' },
    jobSequence: [
      {
        status: 'downloading',
        progress: 61.4,
        speed: '1.3MiB/s',
        eta: '00:05',
        title: 'Search Result Demo',
        filename: '',
        error: '',
        requestedFormat: 'mp3',
        requestedQuality: 'best',
        resolvedFormat: '',
        resolvedHeight: ''
      },
      {
        status: 'ready',
        progress: 100,
        speed: '',
        eta: '',
        title: 'Search Result Demo',
        filename: 'search-flow.mp3',
        error: '',
        requestedFormat: 'mp3',
        requestedQuality: 'best',
        resolvedFormat: 'mp3',
        resolvedHeight: ''
      }
    ]
  }

  await page.route('https://www.youtube.com/**', async route => {
    await route.fulfill({ contentType: 'text/html', body: buildSearchPageHtml() })
  })
  await page.goto('https://www.youtube.com/results?search_query=demo', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await installChromeMock(page, messages, scenario)
  await page.addScriptTag({ content: contentScript })

  await page.waitForSelector('.ytg-lockup-btn', { timeout: 12000 })
  await page.locator('.ytg-lockup-btn').click()
  await waitForText(page, '#ytg-alert', 'could not inspect')

  const previewCounts = await page.evaluate(() => window.previewCounts)
  if (previewCounts.pointerdown !== 0 || previewCounts.mousedown !== 0 || previewCounts.click !== 0) {
    throw new Error(`Search card suppression failed: ${JSON.stringify(previewCounts)}`)
  }

  await page.locator('#ytg-format-options button', { hasText: 'MP3' }).click()
  await page.waitForFunction(() => {
    const row = document.querySelector('#ytg-quality-row')
    const action = document.querySelector('#ytg-download')
    return row?.hidden === true && action?.disabled === false
  }, { timeout: 8000 })

  await page.locator('#ytg-download').click()
  await waitForText(page, '#ytg-status', 'Saved to Downloads')

  const summary = await page.locator('#ytg-summary').innerText()
  if (!summary.includes('search-flow.mp3') || summary.includes('Output quality')) {
    throw new Error(`Search flow failed: unexpected MP3 summary ${summary}`)
  }

  const lastDownloadBody = await page.evaluate(() => window.__ytgTest.state.startDownloadBodies.at(-1))
  if (lastDownloadBody?.format !== 'mp3') {
    throw new Error(`Search flow failed: expected MP3 start body, got ${JSON.stringify(lastDownloadBody)}`)
  }
}

async function run() {
  const [messages, popupHtmlRaw, popupScript, contentScript] = await Promise.all([
    readFixture('_locales/en/messages.json').then(JSON.parse),
    readFixture('popup.html'),
    readFixture('popup.js'),
    readFixture('content.js')
  ])

  const popupHtml = popupHtmlRaw.replace(/\s*<script src="popup\.js"><\/script>\s*/u, '\n')
  const browser = await chromium.launch({ headless: true })

  try {
    await runPopupScenario(browser, messages, popupHtml, popupScript)
    await runWatchScenario(browser, messages, contentScript)
    await runSearchScenario(browser, messages, contentScript)

    console.log('Smoke OK')
  } finally {
    await browser.close().catch(() => {})
  }
}

run().catch(error => {
  console.error(error?.stack || String(error))
  process.exit(1)
})
