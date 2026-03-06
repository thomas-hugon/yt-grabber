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
  serverStatus: null,
  apiToken: null,
  replacedNativeButton: null,
  downloadContext: null,
  lockupInjectQueued: false,
  panelAnchorEl: null,
  pendingInjectRoots: []
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

const SERVER_DOWN_WARNING = 'Serveur local introuvable. Lancez YTGrabber-Server puis réessayez.'
const CLIENT_BLOCK_WARNING = 'Connexion locale bloquée par le navigateur (Shields/AdBlock). Autorisez youtube.com -> localhost:9875 puis réessayez.'

function watchPage() {
  if (state.observer) return

  state.observer = new MutationObserver(mutations => {
    if (location.href !== state.currentUrl) {
      state.currentUrl = location.href
      removePanel()
      removeButton()
      scheduleInject()
      return
    }

    queueCardInject(collectInjectRoots(mutations))
  })

  state.observer.observe(document.body, { childList: true, subtree: true })
}

function collectInjectRoots(mutations) {
  const roots = []
  mutations.forEach(m => {
    m.addedNodes?.forEach(node => {
      if (!(node instanceof Element)) return
      roots.push(node)
    })
  })
  return roots
}

function queueCardInject(roots = []) {
  if (roots.length > 0) {
    state.pendingInjectRoots.push(...roots)
  }
  if (state.lockupInjectQueued) return
  state.lockupInjectQueued = true
  setTimeout(() => {
    state.lockupInjectQueued = false
    const rootsToScan = state.pendingInjectRoots.length > 0 ? state.pendingInjectRoots.splice(0) : [document]
    injectCardButtons(rootsToScan)
  }, 250)
}

function scheduleInject() {
  clearInterval(state.injectTimer)
  let tries = 0
  state.injectTimer = setInterval(() => {
    tries += 1
    const actions = document.querySelector('#actions-inner #menu-container, #actions #menu')
    if (actions && !document.getElementById('ytg-btn')) {
      const target = resolveInjectionTarget(actions)
      if (target) injectButton(target)
    }
    injectCardButtons([document])
    if (tries >= 40) clearInterval(state.injectTimer)
  }, 300)
}

function collectNodes(roots, selector) {
  const uniq = new Set()
  roots.forEach(root => {
    const base = root instanceof Document ? root.documentElement : root
    if (!(base instanceof Element)) return
    if (base.matches(selector)) uniq.add(base)
    base.querySelectorAll(selector).forEach(node => uniq.add(node))
  })
  return Array.from(uniq)
}

function resolveInjectionTarget(anchor) {
  const nativeButton = resolveNativeDownloadButton(anchor)
  if (nativeButton) {
    return { mode: 'replace-native', node: nativeButton }
  }

  const menuHost = resolveMenuHost(anchor)
  if (menuHost) {
    return { mode: 'menu', node: menuHost }
  }

  return null
}

function resolveNativeDownloadButton(anchor) {
  const root = anchor.closest('#actions-inner, #actions') || document
  return root.querySelector('ytd-download-button-renderer.style-scope.ytd-menu-renderer')
}

function resolveMenuHost(anchor) {
  if (anchor.id === 'menu') return anchor
  return anchor.closest('#actions-inner, #actions')?.querySelector('#menu') || null
}

function injectButton(target) {
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
  btn.dataset.url = location.href
  btn.dataset.title = getVideoTitle()

  if (target.mode === 'replace-native') {
    state.replacedNativeButton = target.node
    target.node.style.display = 'none'
    wrap.classList.add('ytg-native-slot')
    target.node.parentElement?.insertBefore(wrap, target.node)
    return
  }

  target.node.prepend(wrap)
}

function normalizeVideoURL(href) {
  const raw = typeof href === 'string' ? href.trim() : ''
  if (!raw) return ''
  try {
    const u = new URL(raw, location.origin)
    if (u.pathname !== '/watch') return ''
    const v = u.searchParams.get('v')
    if (!v) return ''
    return `${u.origin}/watch?v=${encodeURIComponent(v)}`
  } catch {
    return ''
  }
}

function injectLockupButtons(roots) {
  const lockups = collectNodes(roots, 'yt-lockup-view-model')
  let injected = 0

  lockups.forEach(lockup => {
    const root = lockup.querySelector('.yt-lockup-view-model') || lockup
    if (!root) return

    const link = root.querySelector('a.yt-lockup-view-model__content-image[href], a.yt-lockup-metadata-view-model__title[href], a[href*="watch?v="]')
    const url = normalizeVideoURL(link?.getAttribute('href') || '')
    const titleNode = root.querySelector('.yt-lockup-metadata-view-model__title, a.yt-lockup-metadata-view-model__title')
    const title = (titleNode?.textContent || '').trim() || 'YouTube Download'

    const existing = root.querySelector('.ytg-lockup-btn')
    if (!url) {
      if (existing) existing.remove()
      return
    }

    if (existing) {
      existing.dataset.url = url
      existing.dataset.title = title
      return
    }

    const btn = createLockupButton(url, title)

    const menuButton = root.querySelector('.yt-lockup-metadata-view-model__menu-button')
    if (menuButton?.parentElement) {
      menuButton.parentElement.insertBefore(btn, menuButton)
    } else {
      const textContainer = root.querySelector('.yt-lockup-metadata-view-model__text-container') || root
      textContainer.appendChild(btn)
    }
    injected += 1
  })

  return injected
}

function injectLegacyCardButtons(roots) {
  const cards = collectNodes(roots, 'ytd-compact-video-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-grid-media')
  let injected = 0

  cards.forEach(card => {
    const link = card.querySelector('a#thumbnail[href], a#video-title[href], a[href*="watch?v="]')
    const url = normalizeVideoURL(link?.getAttribute('href') || '')
    const titleNode = card.querySelector('#video-title, a#video-title, #video-title-link')
    const title = (titleNode?.textContent || '').trim() || 'YouTube Download'

    const existing = card.querySelector('.ytg-lockup-btn')
    if (!url) {
      if (existing) existing.remove()
      return
    }

    if (existing) {
      existing.dataset.url = url
      existing.dataset.title = title
      return
    }

    const btn = createLockupButton(url, title)

    const menu = card.querySelector('#menu, #menu-container, ytd-menu-renderer')
    if (menu?.parentElement) {
      menu.parentElement.insertBefore(btn, menu)
    } else {
      const details = card.querySelector('#details') || card
      details.appendChild(btn)
    }
    injected += 1
  })

  return injected
}

function injectCardButtons(roots) {
  return injectLockupButtons(roots) + injectLegacyCardButtons(roots)
}

function createLockupButton(url, title) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'ytg-lockup-btn'
  btn.textContent = 'Télécharger'
  btn.dataset.url = url
  btn.dataset.title = title
  btn.addEventListener('click', evt => {
    evt.preventDefault()
    evt.stopPropagation()
    onTriggerClick(evt)
  })
  return btn
}

function refreshCardButtonContext(btn) {
  const lockup = btn.closest('yt-lockup-view-model')
  if (lockup) {
    const root = lockup.querySelector('.yt-lockup-view-model') || lockup
    const link = root.querySelector('a.yt-lockup-view-model__content-image[href], a.yt-lockup-metadata-view-model__title[href], a[href*="watch?v="]')
    const url = normalizeVideoURL(link?.getAttribute('href') || '')
    const titleNode = root.querySelector('.yt-lockup-metadata-view-model__title, a.yt-lockup-metadata-view-model__title')
    const title = (titleNode?.textContent || '').trim() || 'YouTube Download'
    if (url) btn.dataset.url = url
    btn.dataset.title = title
    return
  }

  const card = btn.closest('ytd-compact-video-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-grid-media')
  if (!card) return
  const link = card.querySelector('a#thumbnail[href], a#video-title[href], a[href*="watch?v="]')
  const url = normalizeVideoURL(link?.getAttribute('href') || '')
  const titleNode = card.querySelector('#video-title, a#video-title, #video-title-link')
  const title = (titleNode?.textContent || '').trim() || 'YouTube Download'
  if (url) btn.dataset.url = url
  btn.dataset.title = title
}

function removeButton() {
  const wrap = document.getElementById('ytg-btn')
  if (wrap) wrap.remove()
  document.querySelectorAll('.ytg-lockup-btn').forEach(btn => btn.remove())

  if (state.replacedNativeButton) {
    state.replacedNativeButton.style.display = ''
    state.replacedNativeButton = null
  }
}

function onTriggerClick(evt) {
  const trigger = evt?.currentTarget
  if (trigger instanceof Element) {
    if (trigger.classList.contains('ytg-lockup-btn')) {
      refreshCardButtonContext(trigger)
    }
    state.panelAnchorEl = trigger
  }
  const forcedURL = trigger?.dataset?.url || location.href
  const forcedTitle = (trigger?.dataset?.title || '').trim()
  state.downloadContext = {
    url: forcedURL,
    title: forcedTitle || getVideoTitle()
  }

  if (state.panel) {
    removePanel()
    return
  }
  buildPanel()
}

function buildPanel() {
  const trigger = state.panelAnchorEl || document.getElementById('ytg-trigger')
  if (!trigger) return

  const panel = document.createElement('div')
  panel.id = 'ytg-panel'
  panel.innerHTML = `
    <div class="ytg-head">
      <div class="ytg-logo" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M11 2h2v9h3l-4 5-4-5h3V2zm-6 17h14v2H5z"/></svg>
      </div>
      <div class="ytg-title" title="${escapeHtml(state.downloadContext?.title || getVideoTitle())}">${escapeHtml(state.downloadContext?.title || getVideoTitle())}</div>
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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const pong = await fetch('http://localhost:9875/ping', { signal: controller.signal })
    return pong.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function getApiToken() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'getApiToken' }, response => {
      if (chrome.runtime.lastError || !response || response.ok !== true || !response.token) {
        resolve('')
        return
      }
      state.apiToken = response.token.trim()
      resolve(state.apiToken)
    })
  })
}

function pingServerViaBackground() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'refreshHealth' }, response => {
      if (chrome.runtime.lastError || !response || response.ok !== true) {
        resolve(false)
        return
      }
      resolve(response.isUp === true)
    })
  })
}

async function checkServerHealth() {
  const direct = await pingServer()
  if (direct) return true
  return pingServerViaBackground()
}

function isLikelyClientBlockError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('err_blocked_by_client') ||
    msg.includes('blocked by client')
  )
}

function serverErrorMessage(statusCode) {
  if (statusCode === 401) return 'Token API manquant ou invalide. Rechargez l’extension puis réessayez.'
  if (statusCode === 403) return 'Requête refusée par le serveur (origin/token).'
  if (statusCode === 503) return 'Serveur démarré mais token non configuré côté serveur.'
  return `Erreur serveur (${statusCode}).`
}

async function markIfClientBlocked(statusNode, warningNode, err) {
  if (!isLikelyClientBlockError(err)) return false

  const backgroundCanReachServer = await pingServerViaBackground()
  if (!backgroundCanReachServer) return false

  if (statusNode) statusNode.textContent = 'Connexion locale bloquée par le navigateur'
  if (warningNode) {
    warningNode.textContent = CLIENT_BLOCK_WARNING
    warningNode.hidden = false
  }
  return true
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
  warning.textContent = SERVER_DOWN_WARNING
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

  const isUp = await checkServerHealth()
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
  const apiToken = await getApiToken()
  if (!apiToken) {
    status.textContent = 'Token API introuvable'
    warning.textContent = 'Le token de sécurité est manquant. Rechargez l’extension YT Grabber.'
    warning.hidden = false
    fill.classList.add('error')
    actionBtn.disabled = false
    state.downloadLock = false
    return
  }

  let resp
  try {
    resp = await fetch('http://localhost:9875/download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-YTG-Token': apiToken
      },
      body: JSON.stringify({
        url: state.downloadContext?.url || location.href,
        title: state.downloadContext?.title || getVideoTitle(),
        format,
        quality
      })
    })
  } catch (err) {
    const isBlocked = await markIfClientBlocked(status, warning, err)
    if (!isBlocked) {
      warning.textContent = SERVER_DOWN_WARNING
      warning.hidden = false
      status.textContent = 'Impossible de joindre le serveur local'
    }
    fill.classList.add('error')
    actionBtn.disabled = false
    state.downloadLock = false
    return
  }

  if (!resp.ok) {
    status.textContent = 'Impossible de démarrer le téléchargement'
    warning.textContent = serverErrorMessage(resp.status)
    warning.hidden = false
    fill.classList.add('error')
    actionBtn.disabled = false
    state.downloadLock = false
    return
  }

  let payload
  try {
    payload = await resp.json()
  } catch {
    status.textContent = 'Réponse serveur invalide'
    warning.textContent = 'Le serveur a répondu avec un format inattendu.'
    warning.hidden = false
    fill.classList.add('error')
    actionBtn.disabled = false
    state.downloadLock = false
    return
  }

  status.textContent = 'Téléchargement en cours...'
  const jobToken = typeof payload.job_token === 'string' ? payload.job_token.trim() : ''
  if (!jobToken) {
    status.textContent = 'Réponse serveur invalide'
    warning.textContent = 'Token de job manquant dans la réponse serveur.'
    warning.hidden = false
    fill.classList.add('error')
    actionBtn.disabled = false
    state.downloadLock = false
    return
  }

  const source = new EventSource(`http://localhost:9875/progress/${payload.job_id}?job_token=${encodeURIComponent(jobToken)}`)
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
      chrome.runtime.sendMessage({ action: 'download', jobId: payload.job_id, jobToken }, response => {
        if (chrome.runtime.lastError || !response || response.ok !== true) {
          status.textContent = 'Téléchargement navigateur refusé'
          warning.textContent = response?.error || chrome.runtime.lastError?.message || 'Le navigateur a refusé le téléchargement.'
          warning.hidden = false
          fill.classList.remove('done')
          fill.classList.add('error')
          actionBtn.disabled = false
          state.downloadLock = false
          return
        }
        state.progressResetTimer = setTimeout(() => removePanel(), 1200)
        state.downloadLock = false
      })
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

  source.onerror = async () => {
    source.close()
    state.source = null
    const isBlocked = await markIfClientBlocked(status, warning, null)
    if (!isBlocked) {
      warning.textContent = SERVER_DOWN_WARNING
      warning.hidden = false
      status.textContent = 'Connexion perdue avec le serveur'
    }
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
  state.downloadContext = null
  state.panelAnchorEl = null
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

scheduleInject()
watchPage()
