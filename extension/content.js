const state = {
  currentUrl: location.href,
  observer: null,
  injectTimer: null,
  panel: null,
  source: null,
  outsideHandler: null,
  progressResetTimer: null,
  downloadLock: false,
  serverStatusTimer: null,
  serverStatus: null
}

const selectors = [
  'h1.ytd-video-primary-info-renderer yt-formatted-string',
  'h1.style-scope.ytd-watch-metadata yt-formatted-string',
  '#above-the-fold h1 yt-formatted-string'
]

const qualityOptions = [
  { label: 'Max', value: 'best' },
  { label: '1080p', value: '1080' },
  { label: '720p', value: '720' },
  { label: '480p', value: '480' }
]

const formatOptions = [
  { label: 'MP4', value: 'mp4' },
  { label: 'MP3', value: 'mp3' }
]

function watchPage() {
  if (state.observer) return

  state.observer = new MutationObserver(() => {
    if (location.href === state.currentUrl) return
    state.currentUrl = location.href

    if (location.pathname === '/watch') {
      scheduleInject()
      return
    }

    removePanel()
    removeButton()
  })

  state.observer.observe(document.body, { childList: true, subtree: true })
}

function scheduleInject() {
  clearInterval(state.injectTimer)
  let tries = 0
  state.injectTimer = setInterval(() => {
    tries += 1
    const actions = document.querySelector('#actions-inner #menu-container, #actions #menu')
    if (!actions || document.getElementById('ytg-btn')) {
      if (tries >= 40) clearInterval(state.injectTimer)
      return
    }

    injectButton(actions)
    clearInterval(state.injectTimer)
  }, 300)
}

function injectButton(anchor) {
  const wrap = document.createElement('div')
  wrap.id = 'ytg-btn'

  const btn = document.createElement('button')
  btn.id = 'ytg-trigger'
  btn.type = 'button'
  btn.innerHTML = `
    <span class="ytg-trigger-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M11 3h2v9h3l-4 5-4-5h3V3zm-7 15h16v2H4z"/></svg>
    </span>
    <span>Télécharger</span>
  `

  btn.addEventListener('click', onTriggerClick)
  wrap.appendChild(btn)

  const host = anchor.parentElement
  if (!host) return
  host.insertBefore(wrap, anchor)
}

function removeButton() {
  const wrap = document.getElementById('ytg-btn')
  if (wrap) wrap.remove()
}

function onTriggerClick() {
  if (state.panel) {
    removePanel()
    return
  }
  buildPanel()
}

function buildPanel() {
  const trigger = document.getElementById('ytg-trigger')
  if (!trigger) return

  const panel = document.createElement('div')
  panel.id = 'ytg-panel'
  panel.innerHTML = `
    <div class="ytg-head">
      <div class="ytg-logo" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M11 2h2v9h3l-4 5-4-5h3V2zm-6 17h14v2H5z"/></svg>
      </div>
      <div class="ytg-title" title="${escapeHtml(getVideoTitle())}">${escapeHtml(getVideoTitle())}</div>
      <button class="ytg-close" type="button" aria-label="Fermer">×</button>
    </div>

    <div id="ytg-server-state" class="ytg-server-state pending" role="status" aria-live="polite">
      <span class="dot" id="ytg-server-dot" aria-hidden="true"></span>
      <span id="ytg-server-label">Vérification du serveur local...</span>
      <button id="ytg-server-retry" type="button">Re-tester</button>
    </div>

    <div class="ytg-section">
      <div class="ytg-label">Format</div>
      <div class="ytg-segment" data-group="format"></div>
    </div>

    <div class="ytg-section" id="ytg-quality-row">
      <div class="ytg-label">Qualité</div>
      <div class="ytg-segment" data-group="quality"></div>
    </div>

    <button id="ytg-download" type="button">Télécharger</button>

    <div id="ytg-server-warning" class="ytg-warning" hidden>
      Serveur local introuvable. Lancez YTGrabber-Server puis réessayez.
    </div>

    <div id="ytg-progress" class="ytg-progress" hidden>
      <div class="ytg-progress-bar"><div id="ytg-progress-fill"></div></div>
      <div id="ytg-status">Préparation…</div>
      <div id="ytg-meta"></div>
    </div>
  `

  document.body.appendChild(panel)
  state.panel = panel

  placePanel(trigger, panel)
  populateSegments(panel)

  panel.querySelector('.ytg-close').addEventListener('click', removePanel)
  panel.querySelector('#ytg-download').addEventListener('click', onDownloadClick)
  panel.querySelector('#ytg-server-retry').addEventListener('click', () => {
    refreshServerStatusUI(true)
  })

  setTimeout(() => {
    state.outsideHandler = evt => {
      const isTrigger = evt.target.closest('#ytg-trigger')
      if (isTrigger) return
      if (!panel.contains(evt.target)) removePanel()
    }
    document.addEventListener('click', state.outsideHandler)
  }, 100)

  refreshServerStatusUI()
  state.serverStatusTimer = setInterval(() => refreshServerStatusUI(), 15000)
}

function placePanel(trigger, panel) {
  const rect = trigger.getBoundingClientRect()
  panel.style.top = `${window.scrollY + rect.bottom + 8}px`
  panel.style.left = `${Math.max(12, window.scrollX + rect.right - 290)}px`
}

function populateSegments(panel) {
  const formatRoot = panel.querySelector('[data-group="format"]')
  const qualityRoot = panel.querySelector('[data-group="quality"]')

  mountSegment(formatRoot, formatOptions, 'mp4', value => {
    const row = panel.querySelector('#ytg-quality-row')
    row.hidden = value === 'mp3'
  })
  mountSegment(qualityRoot, qualityOptions, 'best')
}

function mountSegment(root, options, activeValue, onChange) {
  options.forEach(opt => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.dataset.value = opt.value
    btn.textContent = opt.label
    if (opt.value === activeValue) btn.classList.add('active')
    btn.addEventListener('click', () => {
      root.querySelectorAll('button').forEach(n => n.classList.remove('active'))
      btn.classList.add('active')
      if (onChange) onChange(opt.value)
    })
    root.appendChild(btn)
  })
}

async function pingServer() {
  try {
    const pong = await fetch('http://localhost:9875/ping', { signal: AbortSignal.timeout(3000) })
    return pong.ok
  } catch {
    return false
  }
}

function applyServerState(isUp) {
  if (!state.panel) return

  const stateRoot = state.panel.querySelector('#ytg-server-state')
  const label = state.panel.querySelector('#ytg-server-label')
  const warning = state.panel.querySelector('#ytg-server-warning')
  const actionBtn = state.panel.querySelector('#ytg-download')
  if (!stateRoot || !label || !warning || !actionBtn) return

  stateRoot.classList.remove('pending', 'online', 'offline')

  if (isUp) {
    stateRoot.classList.add('online')
    label.textContent = 'Serveur actif (localhost:9875)'
    warning.hidden = true
    actionBtn.disabled = false
    state.serverStatus = true
    return
  }

  stateRoot.classList.add('offline')
  label.textContent = 'Serveur indisponible (localhost:9875)'
  warning.hidden = false
  actionBtn.disabled = true
  state.serverStatus = false
}

async function refreshServerStatusUI(forceRefresh = false) {
  if (!state.panel) return false
  if (!forceRefresh && state.downloadLock) return state.serverStatus === true

  const stateRoot = state.panel.querySelector('#ytg-server-state')
  const label = state.panel.querySelector('#ytg-server-label')
  if (stateRoot && label) {
    stateRoot.classList.remove('online', 'offline')
    stateRoot.classList.add('pending')
    label.textContent = 'Vérification du serveur local...'
  }

  const isUp = await pingServer()
  applyServerState(isUp)

  chrome.runtime.sendMessage({ action: 'refreshHealth' }, () => {
    void chrome.runtime.lastError
  })

  return isUp
}

async function onDownloadClick() {
  if (!state.panel || state.downloadLock) return
  state.downloadLock = true

  const warning = state.panel.querySelector('#ytg-server-warning')
  const progress = state.panel.querySelector('#ytg-progress')
  const status = state.panel.querySelector('#ytg-status')
  const meta = state.panel.querySelector('#ytg-meta')
  const fill = state.panel.querySelector('#ytg-progress-fill')
  const actionBtn = state.panel.querySelector('#ytg-download')

  actionBtn.disabled = true
  warning.hidden = true
  progress.hidden = false
  status.textContent = 'Vérification du serveur...'
  meta.textContent = ''
  fill.style.width = '0%'
  fill.classList.remove('done', 'error')

  const isUp = await refreshServerStatusUI(true)
  if (!isUp) {
    status.textContent = 'Serveur indisponible'
    fill.classList.add('error')
    actionBtn.disabled = true
    state.downloadLock = false
    return
  }

  const format = state.panel.querySelector('[data-group="format"] button.active')?.dataset.value || 'mp4'
  const quality = state.panel.querySelector('[data-group="quality"] button.active')?.dataset.value || 'best'

  let payload
  try {
    const resp = await fetch('http://localhost:9875/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: location.href,
        title: getVideoTitle(),
        format,
        quality
      })
    })

    if (!resp.ok) throw new Error(`download request failed: ${resp.status}`)
    payload = await resp.json()
  } catch (err) {
    status.textContent = 'Impossible de démarrer le téléchargement'
    fill.classList.add('error')
    actionBtn.disabled = false
    state.downloadLock = false
    return
  }

  status.textContent = 'Téléchargement en cours...'
  const source = new EventSource(`http://localhost:9875/progress/${payload.job_id}`)
  state.source = source

  source.onmessage = event => {
    let job
    try {
      job = JSON.parse(event.data)
    } catch {
      return
    }

    const progressVal = Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : 0
    fill.style.width = `${progressVal}%`

    if (job.status === 'downloading') {
      status.textContent = `Téléchargement ${progressVal.toFixed(1)}%`
      meta.textContent = [job.speed, job.eta ? `ETA ${job.eta}` : ''].filter(Boolean).join(' • ')
      return
    }

    if (job.status === 'processing') {
      status.textContent = 'Finalisation en cours...'
      meta.textContent = ''
      return
    }

    if (job.status === 'ready') {
      status.textContent = 'Fichier prêt, lancement...'
      meta.textContent = ''
      fill.style.width = '100%'
      fill.classList.add('done')
      source.close()
      state.source = null
      chrome.runtime.sendMessage({ action: 'download', jobId: payload.job_id })
      state.progressResetTimer = setTimeout(() => resetPanel(), 4000)
      state.downloadLock = false
      return
    }

    if (job.status === 'error') {
      status.textContent = job.error || 'Échec du téléchargement'
      meta.textContent = ''
      fill.classList.add('error')
      source.close()
      state.source = null
      state.downloadLock = false
      setTimeout(() => {
        actionBtn.disabled = false
      }, 3000)
    }
  }

  source.onerror = () => {
    source.close()
    state.source = null
    status.textContent = 'Connexion perdue avec le serveur'
    fill.classList.add('error')
    state.downloadLock = false
    actionBtn.disabled = false
    refreshServerStatusUI(true)
  }
}

function resetPanel() {
  if (!state.panel) return
  const actionBtn = state.panel.querySelector('#ytg-download')
  const fill = state.panel.querySelector('#ytg-progress-fill')
  state.panel.querySelector('#ytg-status').textContent = 'Prêt'
  state.panel.querySelector('#ytg-meta').textContent = ''
  fill.style.width = '0%'
  fill.classList.remove('done', 'error')
  state.panel.querySelector('#ytg-progress').hidden = true

  if (state.serverStatus === false) {
    actionBtn.disabled = true
  } else {
    actionBtn.disabled = false
  }
}

function removePanel() {
  if (state.source) {
    state.source.close()
    state.source = null
  }
  clearTimeout(state.progressResetTimer)
  clearInterval(state.serverStatusTimer)
  state.serverStatusTimer = null

  if (state.outsideHandler) {
    document.removeEventListener('click', state.outsideHandler)
    state.outsideHandler = null
  }

  if (state.panel) {
    state.panel.remove()
    state.panel = null
  }

  state.downloadLock = false
  state.serverStatus = null
}

function getVideoTitle() {
  for (const selector of selectors) {
    const node = document.querySelector(selector)
    const text = node?.textContent?.trim()
    if (text) return text
  }
  return document.title.replace(' - YouTube', '').trim()
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

if (location.pathname === '/watch') scheduleInject()
watchPage()
