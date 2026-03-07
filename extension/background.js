const SERVER_BASE_URL = 'http://localhost:9875'
const STATUS_ALARM = 'ytg-server-health'
const TOKEN_KEY = 'apiToken'
const ACTIVE_JOB_KEY = 'activeJobState'
const TOKEN_RE = /^[a-f0-9]{64}$/i
const JOB_ID_RE = /^[a-f0-9]{16}$/i
const JOB_TOKEN_RE = /^[a-f0-9]{32}$/i
const SERVER_STATE_TTL_MS = 15000
const SERVER_TIMEOUT_MS = 3500
const FORMAT_OPTIONS_TIMEOUT_MS = 25000
const JOB_POLL_INTERVAL_MS = 900
const FALLBACK_MP4_QUALITIES = Object.freeze(['best', '1080', '720', '480', '360'])

const DEFAULT_SERVER_STATE = Object.freeze({
  state: 'checking',
  reason: '',
  version: '',
  commit: '',
  checkedAt: 0
})

let serverState = { ...DEFAULT_SERVER_STATE }
let activeJobState = null
let activeJobLoaded = false
let jobPollTimer = null
let jobPollInFlight = false
const formatCache = new Map()

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key
}

function randomHex(bytes = 32) {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, value => value.toString(16).padStart(2, '0')).join('')
}

function clampProgress(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function sanitizeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeYouTubeUrl(href) {
  const raw = sanitizeString(href)
  if (!raw) return ''
  try {
    const url = new URL(raw, 'https://www.youtube.com')
    if (url.pathname !== '/watch') return ''
    const videoId = sanitizeString(url.searchParams.get('v'))
    if (!videoId) return ''
    return `${url.origin}/watch?v=${encodeURIComponent(videoId)}`
  } catch {
    return ''
  }
}

function normalizeRequestedQuality(requestedFormat, requestedQuality) {
  if (requestedFormat !== 'mp4') return 'best'
  const raw = sanitizeString(requestedQuality).toLowerCase()
  if (!raw || raw === 'best') return 'best'
  const normalized = raw.startsWith('p') ? raw.slice(1) : raw
  return /^\d+$/.test(normalized) ? String(Number(normalized)) : 'best'
}

function isTerminalStatus(status) {
  return status === 'ready' || status === 'error'
}

function normalizeQualityOptions(values) {
  const seen = new Set()
  const options = []
  const list = Array.isArray(values) ? values : []
  list.forEach(value => {
    const normalized = sanitizeString(value).toLowerCase()
    if (!normalized) return
    if (normalized !== 'best' && !/^\d+$/.test(normalized)) return
    if (seen.has(normalized)) return
    seen.add(normalized)
    options.push(normalized)
  })
  if (!seen.has('best')) {
    options.unshift('best')
  } else {
    options.sort((left, right) => {
      if (left === 'best') return -1
      if (right === 'best') return 1
      return Number(right) - Number(left)
    })
  }
  return options.map(value => ({
    value,
    label: value === 'best' ? t('qualityOptionBest') : t('qualityOptionHeight', value)
  }))
}

function fallbackQualityOptions() {
  return normalizeQualityOptions(FALLBACK_MP4_QUALITIES)
}

function sanitizeActiveJobState(raw) {
  if (!raw || typeof raw !== 'object') return null

  const jobId = sanitizeString(raw.jobId)
  const jobToken = sanitizeString(raw.jobToken)
  if (!JOB_ID_RE.test(jobId) || !JOB_TOKEN_RE.test(jobToken)) {
    return null
  }

  const status = ['queued', 'downloading', 'processing', 'ready', 'error'].includes(raw.status) ? raw.status : 'queued'
  const requestedFormat = raw.requestedFormat === 'mp3' ? 'mp3' : 'mp4'
  const next = {
    jobId,
    jobToken,
    tabId: Number.isInteger(raw.tabId) ? raw.tabId : null,
    pageUrl: sanitizeString(raw.pageUrl),
    videoUrl: normalizeYouTubeUrl(raw.videoUrl),
    title: sanitizeString(raw.title) || 'YouTube Download',
    status,
    progress: clampProgress(Number(raw.progress)),
    speed: sanitizeString(raw.speed),
    eta: sanitizeString(raw.eta),
    filename: sanitizeString(raw.filename),
    error: sanitizeString(raw.error),
    errorCode: sanitizeString(raw.errorCode),
    requestedFormat,
    requestedQuality: normalizeRequestedQuality(requestedFormat, raw.requestedQuality),
    resolvedFormat: sanitizeString(raw.resolvedFormat).toLowerCase(),
    resolvedHeight: /^\d+$/.test(sanitizeString(raw.resolvedHeight)) ? sanitizeString(raw.resolvedHeight) : '',
    downloadState: ['pending', 'accepted', 'rejected'].includes(raw.downloadState) ? raw.downloadState : 'pending',
    browserDownloadId: Number.isInteger(raw.browserDownloadId) ? raw.browserDownloadId : null,
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : Date.now()
  }

  return next
}

async function getStoredApiToken() {
  const stored = await chrome.storage.local.get(TOKEN_KEY)
  const token = sanitizeString(stored[TOKEN_KEY])
  return TOKEN_RE.test(token) ? token : ''
}

async function ensureApiToken() {
  const existing = await getStoredApiToken()
  if (existing) return existing
  const created = randomHex(32)
  await chrome.storage.local.set({ [TOKEN_KEY]: created })
  return created
}

async function saveApiToken(rawToken) {
  const token = sanitizeString(rawToken)
  if (!TOKEN_RE.test(token)) {
    throw new Error('invalid token format')
  }
  await chrome.storage.local.set({ [TOKEN_KEY]: token })
  formatCache.clear()
  return token
}

async function ensureActiveJobLoaded() {
  if (activeJobLoaded) return activeJobState
  const stored = await chrome.storage.local.get(ACTIVE_JOB_KEY)
  activeJobState = sanitizeActiveJobState(stored[ACTIVE_JOB_KEY])
  activeJobLoaded = true
  return activeJobState
}

async function persistActiveJobState() {
  if (!activeJobState) {
    await chrome.storage.local.remove(ACTIVE_JOB_KEY)
    return
  }
  await chrome.storage.local.set({ [ACTIVE_JOB_KEY]: activeJobState })
}

async function queryYouTubeTabs() {
  return new Promise(resolve => {
    chrome.tabs.query({ url: ['https://www.youtube.com/*'] }, tabs => {
      if (chrome.runtime.lastError) {
        resolve([])
        return
      }
      resolve(Array.isArray(tabs) ? tabs : [])
    })
  })
}

async function createTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url }, tab => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      resolve(tab)
    })
  })
}

async function getTab(tabId) {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) {
        resolve(null)
        return
      }
      resolve(tab || null)
    })
  })
}

async function startBrowserDownloadURL(url) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, conflictAction: 'uniquify' }, downloadId => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      if (!Number.isInteger(downloadId)) {
        reject(new Error('download rejected'))
        return
      }
      resolve(downloadId)
    })
  })
}

async function broadcastMessage(message) {
  const tabs = await queryYouTubeTabs()
  tabs.forEach(tab => {
    if (!Number.isInteger(tab.id)) return
    chrome.tabs.sendMessage(tab.id, message, () => {
      void chrome.runtime.lastError
    })
  })
}

function applyActionStatus(nextState) {
  let text = ''
  let title = t('actionTitleChecking')
  let color = '#80868f'

  if (nextState.state === 'paired') {
    text = 'OK'
    title = t('actionTitlePaired')
    color = '#2ca54e'
  } else if (nextState.state === 'unpaired') {
    text = 'PAIR'
    title = t('actionTitleUnpaired')
    color = '#d4941c'
  } else if (nextState.state === 'offline') {
    text = 'OFF'
    title = t('actionTitleOffline')
    color = '#c0392b'
  }

  chrome.action.setBadgeText({ text })
  chrome.action.setBadgeBackgroundColor({ color })
  chrome.action.setTitle({ title })
}

async function setServerState(nextState) {
  serverState = {
    ...DEFAULT_SERVER_STATE,
    ...nextState,
    checkedAt: Date.now()
  }
  applyActionStatus(serverState)
  await broadcastMessage({ type: 'ytg:serverStateChanged', serverState })
  return serverState
}

async function setActiveJobState(nextState) {
  activeJobState = sanitizeActiveJobState(nextState)
  await persistActiveJobState()
  await broadcastMessage({ type: 'ytg:activeJobStateChanged', activeJobState })
  return activeJobState
}

async function fetchJSON(path, options = {}) {
  const controller = new AbortController()
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : SERVER_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const headers = {}
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    if (options.token) {
      headers['X-YTG-Token'] = options.token
    }

    const response = await fetch(path.startsWith('http') ? path : `${SERVER_BASE_URL}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    })

    const payload = await response.json().catch(() => null)
    return {
      ok: response.ok,
      status: response.status,
      payload
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: null,
      error
    }
  } finally {
    clearTimeout(timer)
  }
}

function errorCodeFromServerState(nextState) {
  if (nextState.state === 'offline') return 'server_offline'
  if (nextState.state === 'unpaired') return nextState.reason || 'pairing_required'
  return ''
}

async function getServerState(force = false) {
  if (!force && serverState.checkedAt > 0 && Date.now() - serverState.checkedAt < SERVER_STATE_TTL_MS) {
    return serverState
  }

  const ping = await fetchJSON('/ping')
  if (!ping.ok) {
    return setServerState({
      state: 'offline',
      reason: 'server_offline'
    })
  }

  const version = sanitizeString(ping.payload?.version)
  const commit = sanitizeString(ping.payload?.commit)
  const token = await ensureApiToken()
  if (!token) {
    return setServerState({
      state: 'unpaired',
      reason: 'token_missing',
      version,
      commit
    })
  }

  const pairing = await fetchJSON('/pairing', { token })
  if (pairing.ok) {
    return setServerState({
      state: 'paired',
      reason: '',
      version: sanitizeString(pairing.payload?.version) || version,
      commit: sanitizeString(pairing.payload?.commit) || commit
    })
  }

  if (pairing.status === 0) {
    return setServerState({
      state: 'offline',
      reason: 'server_offline',
      version,
      commit
    })
  }

  return setServerState({
    state: 'unpaired',
    reason: sanitizeString(pairing.payload?.code) || 'pairing_required',
    version,
    commit
  })
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(STATUS_ALARM)
  if (!existing) {
    chrome.alarms.create(STATUS_ALARM, { periodInMinutes: 1 })
  }
}

function scheduleJobPoll(delayMs = JOB_POLL_INTERVAL_MS) {
  clearTimeout(jobPollTimer)
  if (!activeJobState || isTerminalStatus(activeJobState.status)) return
  jobPollTimer = setTimeout(() => {
    void pollActiveJob()
  }, delayMs)
}

async function failActiveJob(errorCode, errorMessage = '') {
  if (!activeJobState) return null
  clearTimeout(jobPollTimer)
  return setActiveJobState({
    ...activeJobState,
    status: 'error',
    errorCode,
    error: sanitizeString(errorMessage),
    progress: clampProgress(activeJobState.progress),
    updatedAt: Date.now()
  })
}

async function handleReadyJobDownload(job) {
  if (!job || job.downloadState === 'accepted') return

  const downloadUrl = `${SERVER_BASE_URL}/file/${job.jobId}?job_token=${encodeURIComponent(job.jobToken)}`
  try {
    const browserDownloadId = await startBrowserDownloadURL(downloadUrl)
    await setActiveJobState({
      ...job,
      downloadState: 'accepted',
      browserDownloadId,
      updatedAt: Date.now()
    })
  } catch (error) {
    await failActiveJob('browser_download_rejected', error?.message || '')
  }
}

async function pollActiveJob() {
  await ensureActiveJobLoaded()
  if (!activeJobState || isTerminalStatus(activeJobState.status) || jobPollInFlight) return

  jobPollInFlight = true
  try {
    const result = await fetchJSON(`/job/${activeJobState.jobId}?job_token=${encodeURIComponent(activeJobState.jobToken)}`)
    if (!result.ok) {
      if (result.status === 0) {
        await failActiveJob('polling_failed')
        return
      }
      await failActiveJob(sanitizeString(result.payload?.code) || 'polling_failed')
      return
    }

    const nextJobState = sanitizeActiveJobState({
      ...activeJobState,
      status: sanitizeString(result.payload?.status) || activeJobState.status,
      progress: Number(result.payload?.progress),
      speed: result.payload?.speed,
      eta: result.payload?.eta,
      title: result.payload?.title || activeJobState.title,
      filename: result.payload?.filename,
      error: result.payload?.error,
      requestedFormat: result.payload?.requested_format || activeJobState.requestedFormat,
      requestedQuality: result.payload?.requested_quality || activeJobState.requestedQuality,
      resolvedFormat: result.payload?.resolved_format,
      resolvedHeight: result.payload?.resolved_height,
      errorCode: sanitizeString(result.payload?.error) ? 'job_failed' : '',
      updatedAt: Date.now()
    })

    await setActiveJobState(nextJobState)

    if (nextJobState.status === 'ready') {
      await handleReadyJobDownload(nextJobState)
      return
    }
    if (nextJobState.status === 'error') {
      return
    }

    scheduleJobPoll()
  } finally {
    jobPollInFlight = false
  }
}

async function getFormatOptions(videoUrl) {
  const normalizedUrl = normalizeYouTubeUrl(videoUrl)
  if (!normalizedUrl) {
    return { ok: false, errorCode: 'invalid_url' }
  }

  const cached = formatCache.get(normalizedUrl)
  if (cached) {
    return { ok: true, ...cached }
  }

  const nextServerState = await getServerState(false)
  if (nextServerState.state !== 'paired') {
    return {
      ok: false,
      errorCode: errorCodeFromServerState(nextServerState),
      serverState: nextServerState
    }
  }

  const token = await getStoredApiToken()
  if (!token) {
    return { ok: false, errorCode: 'token_missing' }
  }

  const result = await fetchJSON('/formats', {
    method: 'POST',
    token,
    body: { url: normalizedUrl },
    timeoutMs: FORMAT_OPTIONS_TIMEOUT_MS
  })

  if (!result.ok) {
    if (result.status === 401 || result.status === 503) {
      await getServerState(true)
      return {
        ok: false,
        errorCode: sanitizeString(result.payload?.code) || 'format_probe_failed'
      }
    }

    const errorCode = sanitizeString(result.payload?.code) || 'format_probe_failed'
    if (errorCode === 'format_probe_failed' || result.status === 0 || result.status >= 500) {
      console.warn('YTG format probe failed; falling back to static quality options', {
        videoUrl: normalizedUrl,
        status: result.status,
        errorCode,
        error: result.error?.message || ''
      })
      return {
        ok: true,
        title: '',
        qualityOptions: fallbackQualityOptions(),
        fallbackUsed: true
      }
    }

    return {
      ok: false,
      errorCode
    }
  }

  const payload = {
    title: sanitizeString(result.payload?.title),
    qualityOptions: normalizeQualityOptions(result.payload?.quality_options)
  }
  formatCache.set(normalizedUrl, payload)
  return { ok: true, ...payload }
}

async function startDownloadJob(message, sender) {
  await ensureActiveJobLoaded()
  if (activeJobState) {
    return {
      ok: false,
      errorCode: isTerminalStatus(activeJobState.status) ? 'job_requires_dismissal' : 'job_already_active',
      activeJobState
    }
  }

  const videoUrl = normalizeYouTubeUrl(message.url)
  if (!videoUrl) {
    return { ok: false, errorCode: 'invalid_url' }
  }

  const requestedFormat = message.requestedFormat === 'mp3' ? 'mp3' : 'mp4'
  const requestedQuality = normalizeRequestedQuality(requestedFormat, message.requestedQuality)

  const nextServerState = await getServerState(true)
  if (nextServerState.state !== 'paired') {
    return {
      ok: false,
      errorCode: errorCodeFromServerState(nextServerState),
      serverState: nextServerState
    }
  }

  const token = await getStoredApiToken()
  if (!token) {
    return { ok: false, errorCode: 'token_missing' }
  }

  const response = await fetchJSON('/download', {
    method: 'POST',
    token,
    body: {
      url: videoUrl,
      title: sanitizeString(message.title) || 'YouTube Download',
      format: requestedFormat,
      quality: requestedQuality
    }
  })

  if (!response.ok) {
    if (response.status === 401 || response.status === 503) {
      await getServerState(true)
    }
    return {
      ok: false,
      errorCode: sanitizeString(response.payload?.code) || 'job_start_failed'
    }
  }

  const jobId = sanitizeString(response.payload?.job_id)
  const jobToken = sanitizeString(response.payload?.job_token)
  if (!JOB_ID_RE.test(jobId) || !JOB_TOKEN_RE.test(jobToken)) {
    return { ok: false, errorCode: 'job_start_failed' }
  }

  const nextJobState = sanitizeActiveJobState({
    jobId,
    jobToken,
    tabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : null,
    pageUrl: sanitizeString(sender?.tab?.url),
    videoUrl,
    title: sanitizeString(message.title) || 'YouTube Download',
    status: 'queued',
    progress: 0,
    speed: '',
    eta: '',
    filename: '',
    error: '',
    errorCode: '',
    requestedFormat,
    requestedQuality,
    resolvedFormat: '',
    resolvedHeight: '',
    downloadState: 'pending',
    browserDownloadId: null,
    updatedAt: Date.now()
  })

  await setActiveJobState(nextJobState)
  scheduleJobPoll(0)
  return { ok: true, activeJobState }
}

async function dismissActiveJob() {
  clearTimeout(jobPollTimer)
  await setActiveJobState(null)
  return { ok: true }
}

async function openDownloads() {
  try {
    await createTab('chrome://downloads/')
    return { ok: true }
  } catch {
    try {
      chrome.downloads.showDefaultFolder()
      return { ok: true }
    } catch (error) {
      return { ok: false, errorCode: 'open_downloads_failed', error: error?.message || '' }
    }
  }
}

async function initialize() {
  await ensureApiToken()
  await ensureAlarm()
  applyActionStatus(DEFAULT_SERVER_STATE)
  await ensureActiveJobLoaded()
  if (activeJobState && !isTerminalStatus(activeJobState.status)) {
    scheduleJobPoll(0)
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== STATUS_ALARM) return
  void getServerState(true)
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const candidateUrl = changeInfo.url || tab?.url || ''
  if (!candidateUrl.startsWith('https://www.youtube.com/')) return
  void getServerState(true)
})

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await getTab(tabId)
  if (!tab?.url?.startsWith('https://www.youtube.com/')) return
  void getServerState(true)
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.action) return undefined

  ;(async () => {
    if (message.action === 'getServerState') {
      await ensureAlarm()
      sendResponse({ ok: true, serverState: await getServerState(false) })
      return
    }

    if (message.action === 'refreshServerState') {
      await ensureAlarm()
      sendResponse({ ok: true, serverState: await getServerState(true) })
      return
    }

    if (message.action === 'getApiToken') {
      await ensureAlarm()
      sendResponse({ ok: true, token: await ensureApiToken() })
      return
    }

    if (message.action === 'setApiToken') {
      try {
        const token = await saveApiToken(message.token)
        sendResponse({
          ok: true,
          token,
          serverState: await getServerState(true)
        })
      } catch (error) {
        sendResponse({ ok: false, errorCode: 'invalid_token_format', error: error?.message || '' })
      }
      return
    }

    if (message.action === 'getFormatOptions') {
      sendResponse(await getFormatOptions(message.url))
      return
    }

    if (message.action === 'startDownloadJob') {
      sendResponse(await startDownloadJob(message, sender))
      return
    }

    if (message.action === 'getActiveJobState') {
      await ensureActiveJobLoaded()
      if (activeJobState && !isTerminalStatus(activeJobState.status)) {
        scheduleJobPoll(0)
      }
      sendResponse({ ok: true, activeJobState })
      return
    }

    if (message.action === 'dismissActiveJob') {
      sendResponse(await dismissActiveJob())
      return
    }

    if (message.action === 'openDownloads') {
      sendResponse(await openDownloads())
      return
    }

    sendResponse({ ok: false, errorCode: 'unknown_action' })
  })().catch(error => {
    sendResponse({ ok: false, errorCode: 'internal_error', error: error?.message || '' })
  })

  return true
})
