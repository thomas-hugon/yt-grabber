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

function makeStoredJob(overrides = {}) {
  return {
    jobId: 'feedbeefcafecafe',
    jobToken: '0123456789abcdef0123456789abcdef',
    tabId: 1,
    pageUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    videoUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    title: 'Existing Download',
    status: 'queued',
    progress: 0,
    speed: '',
    eta: '',
    filename: '',
    error: '',
    errorCode: '',
    requestedFormat: 'mp4',
    requestedQuality: '720',
    resolvedFormat: '',
    resolvedHeight: '',
    downloadState: 'pending',
    browserDownloadId: null,
    updatedAt: Date.now(),
    ...overrides
  }
}

async function loadBackground(fetchImpl, initialStorage = {}) {
  const source = await readFixture('background.js')
  const storageState = {
    apiToken: TOKEN,
    ...initialStorage
  }
  const messageListeners = []
  let nextTimerId = 1
  const timers = new Map()

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
    fetch: fetchImpl,
    setTimeout(fn) {
      const id = nextTimerId++
      timers.set(id, fn)
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
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
      const timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for response to ${action}`)), 1000)
      const maybeAsync = listener(
        { action, ...payload },
        { tab: { id: 1, url: payload.url || 'https://www.youtube.com/watch?v=jNQXAC9IVRw' } },
        response => {
          clearTimeout(timeoutId)
          resolve(response)
        }
      )
      if (maybeAsync !== true) {
        clearTimeout(timeoutId)
      }
    })
  }

  return { send, storageState, timers }
}

async function testStartDownloadClearsTerminalJob() {
  const fetchCalls = []
  const { send, storageState } = await loadBackground(
    async (url, options) => {
      const parsed = new URL(url)
      fetchCalls.push({ pathname: parsed.pathname, options })

      if (parsed.pathname === '/ping') {
        return jsonResponse({ ok: true, status: 200, payload: { status: 'ok', version: 'dev', commit: 'abc123' } })
      }
      if (parsed.pathname === '/pairing') {
        return jsonResponse({ ok: true, status: 200, payload: { status: 'paired', version: 'dev', commit: 'abc123' } })
      }
      if (parsed.pathname === '/download') {
        return jsonResponse({
          ok: true,
          status: 202,
          payload: { job_id: 'deadbeefcafebabe', job_token: 'fedcba9876543210fedcba9876543210' }
        })
      }
      throw new Error(`Unexpected fetch path ${parsed.pathname}`)
    },
    { activeJobState: makeStoredJob({ status: 'ready', filename: 'done.mp4', downloadState: 'accepted' }) }
  )

  const response = await send('startDownloadJob', {
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    title: 'Fresh Download',
    requestedFormat: 'mp4',
    requestedQuality: '720'
  })

  assert.equal(response.ok, true)
  assert.equal(response.activeJobState.jobId, 'deadbeefcafebabe')
  assert.deepEqual(fetchCalls.map(call => call.pathname), ['/ping', '/pairing', '/download'])
  assert.equal(storageState.activeJobState.jobId, 'deadbeefcafebabe')
}

async function testStartDownloadClearsMissingQueuedJob() {
  const fetchCalls = []
  const { send, storageState } = await loadBackground(
    async url => {
      const parsed = new URL(url)
      fetchCalls.push(parsed.pathname)

      if (parsed.pathname === '/job/feedbeefcafecafe') {
        return jsonResponse({
          ok: false,
          status: 404,
          payload: { code: 'job_not_found', message: 'job not found' }
        })
      }
      if (parsed.pathname === '/ping') {
        return jsonResponse({ ok: true, status: 200, payload: { status: 'ok', version: 'dev', commit: 'abc123' } })
      }
      if (parsed.pathname === '/pairing') {
        return jsonResponse({ ok: true, status: 200, payload: { status: 'paired', version: 'dev', commit: 'abc123' } })
      }
      if (parsed.pathname === '/download') {
        return jsonResponse({
          ok: true,
          status: 202,
          payload: { job_id: 'deadbeefcafebabe', job_token: 'fedcba9876543210fedcba9876543210' }
        })
      }
      throw new Error(`Unexpected fetch path ${parsed.pathname}`)
    },
    { activeJobState: makeStoredJob({ status: 'queued' }) }
  )

  const response = await send('startDownloadJob', {
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    title: 'Recovered Download',
    requestedFormat: 'mp4',
    requestedQuality: '720'
  })

  assert.equal(response.ok, true)
  assert.deepEqual(fetchCalls, ['/job/feedbeefcafecafe', '/ping', '/pairing', '/download'])
  assert.equal(storageState.activeJobState.jobId, 'deadbeefcafebabe')
}

async function testStartDownloadKeepsLiveActiveJob() {
  const { send } = await loadBackground(
    async url => {
      const parsed = new URL(url)
      if (parsed.pathname === '/job/feedbeefcafecafe') {
        return jsonResponse({
          ok: true,
          status: 200,
          payload: {
            status: 'downloading',
            progress: 48.2,
            speed: '2.4MiB/s',
            eta: '00:09',
            title: 'Existing Download',
            filename: '',
            error: '',
            requested_format: 'mp4',
            requested_quality: '720',
            resolved_format: '',
            resolved_height: ''
          }
        })
      }
      throw new Error(`Unexpected fetch path ${parsed.pathname}`)
    },
    { activeJobState: makeStoredJob({ status: 'queued' }) }
  )

  const response = await send('startDownloadJob', {
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    title: 'Blocked Download',
    requestedFormat: 'mp4',
    requestedQuality: '720'
  })

  assert.equal(response.ok, false)
  assert.equal(response.errorCode, 'job_already_active')
  assert.equal(response.activeJobState.status, 'downloading')
  assert.equal(response.activeJobState.progress, 48.2)
}

async function testGetActiveJobStateClearsMissingQueuedJob() {
  const { send, storageState } = await loadBackground(
    async url => {
      const parsed = new URL(url)
      if (parsed.pathname === '/job/feedbeefcafecafe') {
        return jsonResponse({
          ok: false,
          status: 404,
          payload: { code: 'job_not_found', message: 'job not found' }
        })
      }
      throw new Error(`Unexpected fetch path ${parsed.pathname}`)
    },
    { activeJobState: makeStoredJob({ status: 'processing', progress: 99 }) }
  )

  const response = await send('getActiveJobState')
  assert.equal(response.ok, true)
  assert.equal(response.activeJobState, null)
  assert.equal(storageState.activeJobState, undefined)
}

async function testGetActiveJobStatePreservesTerminalResult() {
  const { send } = await loadBackground(
    async url => {
      throw new Error(`Unexpected fetch path ${new URL(url).pathname}`)
    },
    { activeJobState: makeStoredJob({ status: 'ready', filename: 'done.mp4', downloadState: 'accepted' }) }
  )

  const response = await send('getActiveJobState')
  assert.equal(response.ok, true)
  assert.equal(response.activeJobState.status, 'ready')
  assert.equal(response.activeJobState.filename, 'done.mp4')
}

await testStartDownloadClearsTerminalJob()
await testStartDownloadClearsMissingQueuedJob()
await testStartDownloadKeepsLiveActiveJob()
await testGetActiveJobStateClearsMissingQueuedJob()
await testGetActiveJobStatePreservesTerminalResult()

console.log('Background active job reconciliation OK')
