const SERVER_PING_URL = 'http://localhost:9875/ping'
const STATUS_ALARM = 'ytg-server-health'

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
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(STATUS_ALARM)
  if (!existing) {
    chrome.alarms.create(STATUS_ALARM, { periodInMinutes: 1 })
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await refreshActionStatus()
  await ensureAlarm()
})

chrome.runtime.onStartup.addListener(async () => {
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
    refreshActionStatus().then(() => sendResponse({ ok: true }))
    return true
  }

  if (message.action !== 'download' || !message.jobId) return

  chrome.downloads.download(
    {
      url: `http://localhost:9875/file/${message.jobId}`,
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
