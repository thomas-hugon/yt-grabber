import assert from 'node:assert/strict'
import { randomFillSync } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const extensionDir = path.resolve(__dirname, '..')
const TOKEN = 'a'.repeat(64)

async function readFixture(relativePath) {
  return fs.readFile(path.join(extensionDir, relativePath), 'utf8')
}

function jsonResponse({ ok, status, payload }) {
  return {
    ok,
    status,
    async json() {
      return payload
    }
  }
}

async function loadBackground(fetchImpl) {
  const source = await readFixture('background.js')
  const storageState = { apiToken: TOKEN }
  const messageListeners = []

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          messageListeners.push(listener)
        }
      }
    },
    storage: {
      local: {
        async get(key) {
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map(entry => [entry, storageState[entry]]))
          }
          if (typeof key === 'string') {
            return { [key]: storageState[key] }
          }
          return { ...storageState }
        },
        async set(values) {
          Object.assign(storageState, values)
        },
        async remove(key) {
          delete storageState[key]
        }
      }
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setTitle() {}
    },
    tabs: {
      query(_queryInfo, callback) {
        callback([])
      },
      get(_tabId, callback) {
        callback(null)
      },
      create(createInfo, callback) {
        callback({ id: 1, url: createInfo.url })
      },
      sendMessage() {},
      onUpdated: { addListener() {} },
      onActivated: { addListener() {} }
    },
    downloads: {
      download(_options, callback) {
        callback(1)
      },
      showDefaultFolder() {}
    },
    i18n: {
      getMessage(key) {
        return key
      }
    },
    alarms: {
      async get() {
        return null
      },
      create() {},
      onAlarm: { addListener() {} }
    }
  }

  const context = vm.createContext({
    console,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    crypto: {
      getRandomValues(buffer) {
        return randomFillSync(buffer)
      }
    },
    chrome
  })

  vm.runInContext(source, context, { filename: 'background.js' })
  const listener = messageListeners[0]
  assert.ok(listener, 'background message listener should be registered')

  async function send(action, payload = {}) {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for response to ${action}`)), 1000)
      const maybeAsync = listener({ action, ...payload }, { tab: { id: 1, url: payload.url || 'https://www.youtube.com/watch?v=jNQXAC9IVRw' } }, response => {
        clearTimeout(timer)
        resolve(response)
      })
      if (maybeAsync !== true) {
        clearTimeout(timer)
      }
    })
  }

  return { send }
}

async function testFormatsSuccess() {
  const fetchCalls = []
  const { send } = await loadBackground(async (url, options) => {
    const pathname = new URL(url).pathname
    fetchCalls.push({ pathname, options })

    if (pathname === '/ping') {
      return jsonResponse({ ok: true, status: 200, payload: { status: 'ok', version: 'dev', commit: 'abc123' } })
    }
    if (pathname === '/pairing') {
      return jsonResponse({ ok: true, status: 200, payload: { status: 'paired', version: 'dev', commit: 'abc123' } })
    }
    if (pathname === '/formats') {
      return jsonResponse({
        ok: true,
        status: 200,
        payload: { status: 'ok', title: 'Demo', quality_options: ['best', '720', '360'] }
      })
    }
    throw new Error(`Unexpected fetch path ${pathname}`)
  })

  const response = await send('getFormatOptions', { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' })
  assert.equal(response.ok, true)
  assert.equal(response.title, 'Demo')
  assert.equal(response.fallbackUsed, undefined)
  assert.deepEqual(Array.from(response.qualityOptions, option => option.value), ['best', '720', '360'])
  assert.equal(fetchCalls.at(-1)?.pathname, '/formats')
}

async function testFormatsFallback() {
  const { send } = await loadBackground(async url => {
    const pathname = new URL(url).pathname

    if (pathname === '/ping') {
      return jsonResponse({ ok: true, status: 200, payload: { status: 'ok', version: 'dev', commit: 'abc123' } })
    }
    if (pathname === '/pairing') {
      return jsonResponse({ ok: true, status: 200, payload: { status: 'paired', version: 'dev', commit: 'abc123' } })
    }
    if (pathname === '/formats') {
      return jsonResponse({
        ok: false,
        status: 502,
        payload: { code: 'format_probe_failed', message: 'failed to inspect formats' }
      })
    }
    throw new Error(`Unexpected fetch path ${pathname}`)
  })

  const response = await send('getFormatOptions', { url: 'https://www.youtube.com/watch?v=hPRpgnw1xa8' })
  assert.equal(response.ok, true)
  assert.equal(response.fallbackUsed, true)
  assert.deepEqual(Array.from(response.qualityOptions, option => option.value), ['best', '1080', '720', '480', '360'])
}

async function testFormatsAuthFailureDoesNotFallback() {
  const { send } = await loadBackground(async url => {
    const pathname = new URL(url).pathname

    if (pathname === '/ping') {
      return jsonResponse({ ok: true, status: 200, payload: { status: 'ok', version: 'dev', commit: 'abc123' } })
    }
    if (pathname === '/pairing') {
      return jsonResponse({ ok: true, status: 200, payload: { status: 'paired', version: 'dev', commit: 'abc123' } })
    }
    if (pathname === '/formats') {
      return jsonResponse({
        ok: false,
        status: 401,
        payload: { code: 'token_invalid', message: 'token invalid' }
      })
    }
    throw new Error(`Unexpected fetch path ${pathname}`)
  })

  const response = await send('getFormatOptions', { url: 'https://www.youtube.com/watch?v=hPRpgnw1xa8' })
  assert.equal(response.ok, false)
  assert.equal(response.errorCode, 'token_invalid')
}

await testFormatsSuccess()
await testFormatsFallback()
await testFormatsAuthFailureDoesNotFallback()

console.log('Background format options OK')
