const SERVER_PING_URL = 'http://localhost:9875/ping'
const STATUS_ALARM = 'ytg-server-health'
const TOKEN_KEY = 'apiToken'
const JOB_ID_RE = /^[a-f0-9]{16}$/i

function randomHex(bytes = 32) {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('')
}

async function getOrCreateApiToken() {
  const stored = await chrome.storage.local.get(TOKEN_KEY)
  const existing = typeof stored[TOKEN_KEY] === 'string' ? stored[TOKEN_KEY].trim() : ''
  if (existing) return existing

  const created = randomHex(32)
  await chrome.storage.local.set({ [TOKEN_KEY]: created })
  return created
}

async function checkServerHealth() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(SERVER_PING_URL, { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function applyActionStatus(isUp) {
  const text = isUp ? 'ON' : 'OFF'
  const title = isUp ? 'YT Grabber: serveur local actif (localhost:9875)' : 'YT Grabber: serveur local indisponible (localhost:9875)'

  chrome.action.setBadgeText({ text })
  chrome.action.setBadgeBackgroundColor({ color: isUp ? '#2ca54e' : '#c0392b' })
  chrome.action.setTitle({ title })
}

async function refreshActionStatus() {
  const isUp = await checkServerHealth()
  applyActionStatus(isUp)
  return isUp
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(STATUS_ALARM)
  if (!existing) {
    chrome.alarms.create(STATUS_ALARM, { periodInMinutes: 1 })
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await getOrCreateApiToken()
  await refreshActionStatus()
  await ensureAlarm()
})

chrome.runtime.onStartup.addListener(async () => {
  await getOrCreateApiToken()
  await refreshActionStatus()
  await ensureAlarm()
})

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== STATUS_ALARM) return
  await refreshActionStatus()
})

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const candidateUrl = changeInfo.url || tab.url || ''
  if (!candidateUrl.startsWith('https://www.youtube.com/')) return
  await refreshActionStatus()
})

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId)
  if (!tab?.url?.startsWith('https://www.youtube.com/')) return
  await refreshActionStatus()
})

refreshActionStatus()
ensureAlarm()

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return

  if (message.action === 'refreshHealth') {
    refreshActionStatus().then(isUp => sendResponse({ ok: true, isUp }))
    return true
  }

  if (message.action === 'getApiToken') {
    getOrCreateApiToken().then(token => sendResponse({ ok: true, token }))
    return true
  }

  if (message.action !== 'download' || !message.jobId) return
  if (!sender?.tab?.url?.startsWith('https://www.youtube.com/watch')) {
    sendResponse({ ok: false, error: 'unauthorized sender context' })
    return
  }
  if (!JOB_ID_RE.test(message.jobId)) {
    sendResponse({ ok: false, error: 'invalid job id' })
    return
  }

  const token = typeof message.token === 'string' ? message.token.trim() : ''
  if (!token) {
    sendResponse({ ok: false, error: 'missing api token' })
    return
  }

  chrome.downloads.download(
    {
      url: `http://localhost:9875/file/${message.jobId}?token=${encodeURIComponent(token)}`,
      conflictAction: 'uniquify'
    },
    () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message })
      } else {
        sendResponse({ ok: true })
      }
    }
  )

  return true
})
