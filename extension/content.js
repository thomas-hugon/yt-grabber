const state = {
  currentUrl: location.href,
  observer: null,
  injectTimer: null,
  panel: null,
  outsideHandler: null,
  replacedNativeButton: null,
  downloadContext: null,
  panelAnchorEl: null,
  lockupInjectQueued: false,
  pendingInjectRoots: [],
  serverState: null,
  activeJobState: null,
  formatSelection: 'mp4',
  selectedQuality: 'best',
  qualityStatus: 'idle',
  qualityOptions: [],
  qualityErrorCode: '',
  panelErrorCode: '',
  qualityRequestUrl: '',
  qualityRequestToken: 0
}

const selectors = [
  'h1.ytd-video-primary-info-renderer yt-formatted-string',
  'h1.style-scope.ytd-watch-metadata yt-formatted-string',
  '#above-the-fold h1 yt-formatted-string'
]

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function normalizeVideoURL(href) {
  const raw = typeof href === 'string' ? href.trim() : ''
  if (!raw) return ''
  try {
    const url = new URL(raw, location.origin)
    if (url.pathname !== '/watch') return ''
    const videoId = url.searchParams.get('v')
    if (!videoId) return ''
    return `${url.origin}/watch?v=${encodeURIComponent(videoId)}`
  } catch {
    return ''
  }
}

function getVideoTitle() {
  for (const selector of selectors) {
    const node = document.querySelector(selector)
    const text = node?.textContent?.trim()
    if (text) return text
  }
  return document.title.replace(' - YouTube', '').trim()
}

function clampProgress(value) {
  if (!Number.isFinite(Number(value))) return 0
  return Math.max(0, Math.min(100, Number(value)))
}

function sendBackground(action, payload = {}) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action, ...payload }, response => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          errorCode: 'runtime_unavailable',
          error: chrome.runtime.lastError.message
        })
        return
      }
      resolve(response || { ok: false, errorCode: 'empty_response' })
    })
  })
}

function getRelevantActiveJob() {
  if (!state.activeJobState || !state.downloadContext) return null
  const currentVideoUrl = normalizeVideoURL(state.downloadContext.url || location.href)
  if (!currentVideoUrl) return null
  return state.activeJobState.videoUrl === currentVideoUrl ? state.activeJobState : null
}

function getServerState() {
  return state.serverState || {
    state: 'checking',
    reason: '',
    version: '',
    commit: ''
  }
}

function getErrorMessage(code, fallback = '') {
  switch (code) {
    case 'server_offline':
      return t('errorServerOffline')
    case 'token_missing':
      return t('errorTokenMissing')
    case 'token_invalid':
    case 'pairing_required':
      return t('errorTokenInvalid')
    case 'token_not_configured':
      return t('errorServerTokenNotConfigured')
    case 'format_probe_failed':
      return t('errorFormatProbeFailed')
    case 'job_start_failed':
      return t('errorJobStartFailed')
    case 'polling_failed':
      return t('errorPollingFailed')
    case 'browser_download_rejected':
      return t('errorBrowserDownloadRejected')
    case 'job_already_active':
      return t('errorJobAlreadyActive')
    case 'job_requires_dismissal':
      return t('errorDismissCurrentResult')
    case 'invalid_url':
      return t('errorInvalidVideo')
    case 'job_failed':
      return fallback || t('errorJobFailed')
    default:
      return fallback || t('errorUnexpected')
  }
}

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
  mutations.forEach(mutation => {
    mutation.addedNodes?.forEach(node => {
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
  const unique = new Set()
  roots.forEach(root => {
    const base = root instanceof Document ? root.documentElement : root
    if (!(base instanceof Element)) return
    if (base.matches(selector)) unique.add(base)
    base.querySelectorAll(selector).forEach(node => unique.add(node))
  })
  return Array.from(unique)
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
    <span>${escapeHtml(t('downloadButton'))}</span>
  `
  btn.dataset.url = location.href
  btn.dataset.title = getVideoTitle()
  btn.addEventListener('click', onTriggerClick)

  wrap.appendChild(btn)

  if (target.mode === 'replace-native') {
    state.replacedNativeButton = target.node
    target.node.style.display = 'none'
    wrap.classList.add('ytg-native-slot')
    target.node.parentElement?.insertBefore(wrap, target.node)
    return
  }

  target.node.prepend(wrap)
}

function injectCardButtons(roots) {
  return injectLockupButtons(roots) + injectLegacyCardButtons(roots)
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

function createLockupButton(url, title) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'ytg-lockup-btn'
  btn.innerHTML = `
    <span class="ytg-lockup-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M11 3h2v9h3l-4 5-4-5h3V3zm-7 15h16v2H4z"/></svg>
    </span>
    <span class="ytg-lockup-label">${escapeHtml(t('downloadButtonCompact'))}</span>
  `
  btn.dataset.url = url
  btn.dataset.title = title

  const suppressEvent = evt => {
    if (evt.cancelable) evt.preventDefault()
    evt.stopPropagation()
    evt.stopImmediatePropagation?.()
  }

  ;['pointerdown', 'mousedown', 'mouseup', 'auxclick', 'dblclick'].forEach(type => {
    btn.addEventListener(type, suppressEvent)
  })

  btn.addEventListener('click', evt => {
    suppressEvent(evt)
    onTriggerClick(evt)
  })

  btn.addEventListener('keydown', evt => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return
    suppressEvent(evt)
  })

  btn.addEventListener('keyup', evt => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return
    suppressEvent(evt)
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
  document.getElementById('ytg-btn')?.remove()
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

  state.downloadContext = {
    url: trigger?.dataset?.url || location.href,
    title: sanitizeText(trigger?.dataset?.title) || getVideoTitle()
  }

  if (state.panel) {
    removePanel()
    return
  }

  void buildPanel()
}

function sanitizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

async function buildPanel() {
  const trigger = state.panelAnchorEl || document.getElementById('ytg-trigger')
  if (!trigger) return

  state.formatSelection = 'mp4'
  state.selectedQuality = 'best'
  state.qualityStatus = 'idle'
  state.qualityOptions = []
  state.qualityErrorCode = ''
  state.panelErrorCode = ''
  state.qualityRequestUrl = ''

  const panel = document.createElement('div')
  panel.id = 'ytg-panel'
  panel.innerHTML = `
    <div class="ytg-head">
      <div class="ytg-logo" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M11 2h2v9h3l-4 5-4-5h3V2zm-6 17h14v2H5z"/></svg>
      </div>
      <div class="ytg-title" id="ytg-title"></div>
      <button class="ytg-close" id="ytg-close" type="button" aria-label="${escapeHtml(t('panelDismiss'))}">×</button>
    </div>

    <div id="ytg-server-state" class="ytg-server-state pending" role="status" aria-live="polite">
      <span class="dot" aria-hidden="true"></span>
      <span id="ytg-server-label"></span>
      <button id="ytg-server-retry" type="button">${escapeHtml(t('panelRetry'))}</button>
    </div>

    <div class="ytg-section" id="ytg-format-section">
      <div class="ytg-label">${escapeHtml(t('panelFormatLabel'))}</div>
      <div class="ytg-segment" id="ytg-format-options"></div>
    </div>

    <div class="ytg-section" id="ytg-quality-row">
      <div class="ytg-label">${escapeHtml(t('panelQualityLabel'))}</div>
      <div id="ytg-quality-content"></div>
    </div>

    <div id="ytg-alert" class="ytg-warning" hidden></div>

    <button id="ytg-download" type="button">${escapeHtml(t('downloadAction'))}</button>

    <div id="ytg-progress" class="ytg-progress" hidden>
      <div class="ytg-progress-bar"><div id="ytg-progress-fill"></div></div>
      <div id="ytg-status"></div>
      <div id="ytg-meta"></div>
      <div id="ytg-summary" class="ytg-summary"></div>
      <div id="ytg-progress-actions" class="ytg-progress-actions" hidden>
        <button id="ytg-open-downloads" class="ytg-secondary" type="button">${escapeHtml(t('openDownloadsAction'))}</button>
        <button id="ytg-dismiss" class="ytg-secondary" type="button">${escapeHtml(t('panelDismiss'))}</button>
      </div>
    </div>
  `

  document.body.appendChild(panel)
  state.panel = panel

  placePanel(trigger, panel)
  renderFormatButtons()
  updatePanelTitle()
  renderPanel()

  panel.querySelector('#ytg-close').addEventListener('click', () => {
    void dismissOrClosePanel()
  })

  panel.querySelector('#ytg-download').addEventListener('click', () => {
    void startDownloadFromPanel()
  })

  panel.querySelector('#ytg-server-retry').addEventListener('click', () => {
    void refreshPanelState(true)
  })

  panel.querySelector('#ytg-open-downloads').addEventListener('click', async () => {
    const response = await sendBackground('openDownloads')
    if (!response.ok) {
      state.qualityErrorCode = response.errorCode || 'open_downloads_failed'
      renderPanel()
    }
  })

  panel.querySelector('#ytg-dismiss').addEventListener('click', () => {
    void dismissActiveJobAndClose()
  })

  setTimeout(() => {
    state.outsideHandler = evt => {
      const target = evt.target
      const path = typeof evt.composedPath === 'function' ? evt.composedPath() : []
      const clickedTrigger = path.some(node => node instanceof Element && node.closest?.('#ytg-trigger, .ytg-lockup-btn'))
      if (clickedTrigger) return
      if (path.includes(state.panel)) return
      if (!(target instanceof Element)) return
      if (getRelevantActiveJob() && isTerminalRenderState()) return
      removePanel()
    }
    document.addEventListener('click', state.outsideHandler)
  }, 0)

  await refreshPanelState(false)
}

function placePanel(trigger, panel) {
  const rect = trigger.getBoundingClientRect()
  panel.style.top = `${window.scrollY + rect.bottom + 8}px`
  panel.style.left = `${Math.max(12, window.scrollX + rect.right - 320)}px`
}

function updatePanelTitle() {
  state.panel?.querySelector('#ytg-title')?.replaceChildren(document.createTextNode(state.downloadContext?.title || getVideoTitle()))
}

function renderFormatButtons() {
  if (!state.panel) return
  const root = state.panel.querySelector('#ytg-format-options')
  root.textContent = ''

  const options = [
    { value: 'mp4', label: t('formatMp4') },
    { value: 'mp3', label: t('formatMp3') }
  ]

  options.forEach(option => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.dataset.value = option.value
    btn.textContent = option.label
    if (option.value === state.formatSelection) {
      btn.classList.add('active')
    }
    btn.addEventListener('click', () => {
      if (getRelevantActiveJob()) return
      state.formatSelection = option.value
      renderFormatButtons()
      if (state.formatSelection === 'mp4') {
        if (state.qualityStatus === 'idle' || state.qualityRequestUrl !== normalizeVideoURL(state.downloadContext?.url || location.href)) {
          void ensureQualityOptions()
        } else {
          renderPanel()
        }
      } else {
        renderPanel()
      }
    })
    root.appendChild(btn)
  })
}

function isTerminalRenderState() {
  const job = getRelevantActiveJob()
  if (!job) return false
  return job.status === 'ready' || job.status === 'error'
}

function serverStateClass(nextState) {
  if (nextState.state === 'paired') return 'online'
  if (nextState.state === 'unpaired') return 'unpaired'
  if (nextState.state === 'offline') return 'offline'
  return 'pending'
}

function serverStateLabel(nextState) {
  if (nextState.state === 'paired') return t('serverStatePaired')
  if (nextState.state === 'unpaired') return t('serverStateUnpaired')
  if (nextState.state === 'offline') return t('serverStateOffline')
  return t('serverStateChecking')
}

function panelAlert() {
  const job = getRelevantActiveJob()
  if (job) return ''

  const nextServerState = getServerState()
  if (nextServerState.state !== 'paired') {
    return getErrorMessage(errorCodeFromServerState(nextServerState))
  }
  if (state.panelErrorCode) {
    return getErrorMessage(state.panelErrorCode)
  }
  if (state.formatSelection === 'mp4' && state.qualityStatus === 'error') {
    return getErrorMessage(state.qualityErrorCode || 'format_probe_failed')
  }
  return ''
}

function errorCodeFromServerState(nextState) {
  if (nextState.state === 'offline') return 'server_offline'
  if (nextState.state === 'unpaired') return nextState.reason || 'pairing_required'
  return ''
}

function renderQualityOptions() {
  if (!state.panel) return
  const row = state.panel.querySelector('#ytg-quality-row')
  const root = state.panel.querySelector('#ytg-quality-content')
  if (!row || !root) return

  if (getRelevantActiveJob() || state.formatSelection === 'mp3') {
    row.hidden = true
    root.textContent = ''
    return
  }

  row.hidden = false
  root.textContent = ''

  if (state.qualityStatus === 'loading') {
    const loading = document.createElement('div')
    loading.className = 'ytg-inline-state loading'
    loading.textContent = t('qualityLoading')
    root.appendChild(loading)
    return
  }

  if (state.qualityStatus === 'error') {
    const errorWrap = document.createElement('div')
    errorWrap.className = 'ytg-inline-state error'

    const text = document.createElement('span')
    text.textContent = getErrorMessage(state.qualityErrorCode || 'format_probe_failed')
    errorWrap.appendChild(text)

    const retryBtn = document.createElement('button')
    retryBtn.type = 'button'
    retryBtn.className = 'ytg-inline-action'
    retryBtn.textContent = t('panelRetry')
    retryBtn.addEventListener('click', () => {
      void ensureQualityOptions(true)
    })
    errorWrap.appendChild(retryBtn)
    root.appendChild(errorWrap)
    return
  }

  const segment = document.createElement('div')
  segment.className = 'ytg-segment'
  state.qualityOptions.forEach(option => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.dataset.value = option.value
    btn.textContent = option.label
    if (option.value === state.selectedQuality) {
      btn.classList.add('active')
    }
    btn.addEventListener('click', () => {
      state.selectedQuality = option.value
      renderQualityOptions()
      renderPanel()
    })
    segment.appendChild(btn)
  })
  root.appendChild(segment)
}

function canStartDownload() {
  if (getRelevantActiveJob()) return false
  const nextServerState = getServerState()
  if (nextServerState.state !== 'paired') return false
  if (state.formatSelection === 'mp4') {
    return state.qualityStatus === 'ready' && state.qualityOptions.length > 0
  }
  return true
}

function renderProgress(job) {
  if (!state.panel) return

  const progress = state.panel.querySelector('#ytg-progress')
  const fill = state.panel.querySelector('#ytg-progress-fill')
  const status = state.panel.querySelector('#ytg-status')
  const meta = state.panel.querySelector('#ytg-meta')
  const summary = state.panel.querySelector('#ytg-summary')
  const actions = state.panel.querySelector('#ytg-progress-actions')
  const openDownloads = state.panel.querySelector('#ytg-open-downloads')

  if (!job) {
    progress.hidden = true
    fill.style.width = '0%'
    fill.classList.remove('done', 'error')
    status.textContent = ''
    meta.textContent = ''
    summary.textContent = ''
    actions.hidden = true
    openDownloads.hidden = true
    return
  }

  progress.hidden = false
  const progressValue = clampProgress(job.progress)
  fill.style.width = `${progressValue}%`
  fill.classList.toggle('done', job.status === 'ready' && job.downloadState === 'accepted')
  fill.classList.toggle('error', job.status === 'error')

  if (job.status === 'queued') {
    status.textContent = t('progressQueued')
    meta.textContent = ''
    summary.textContent = ''
    actions.hidden = true
    return
  }

  if (job.status === 'downloading') {
    status.textContent = t('progressDownloading', progressValue.toFixed(1))
    meta.textContent = [job.speed, job.eta ? t('progressEta', job.eta) : ''].filter(Boolean).join(' • ')
    summary.textContent = ''
    actions.hidden = true
    return
  }

  if (job.status === 'processing') {
    status.textContent = t('progressProcessing')
    meta.textContent = ''
    summary.textContent = ''
    actions.hidden = true
    return
  }

  if (job.status === 'ready' && job.downloadState !== 'accepted') {
    status.textContent = t('progressPreparingBrowserDownload')
    meta.textContent = ''
    summary.textContent = ''
    actions.hidden = true
    return
  }

  if (job.status === 'ready') {
    status.textContent = t('successStatus')
    meta.textContent = ''
    summary.innerHTML = buildSummaryHTML(job, true)
    actions.hidden = false
    openDownloads.hidden = false
    return
  }

  status.textContent = getErrorMessage(job.errorCode || 'job_failed', job.error)
  meta.textContent = job.error || ''
  summary.innerHTML = buildSummaryHTML(job, false)
  actions.hidden = false
  openDownloads.hidden = true
}

function buildSummaryHTML(job, includeSavedHint) {
  const lines = []
  if (job.filename) {
    lines.push(`
      <div class="ytg-summary-row">
        <span class="ytg-summary-label">${escapeHtml(t('summaryFilenameLabel'))}</span>
        <span class="ytg-summary-value">${escapeHtml(job.filename)}</span>
      </div>
    `)
  }

  if (includeSavedHint) {
    lines.push(`
      <div class="ytg-summary-row">
        <span class="ytg-summary-label">${escapeHtml(t('summaryDownloadsLabel'))}</span>
        <span class="ytg-summary-value">${escapeHtml(t('successSavedHint'))}</span>
      </div>
    `)
  }

  if (job.requestedFormat === 'mp4' && job.resolvedHeight) {
    lines.push(`
      <div class="ytg-summary-row">
        <span class="ytg-summary-label">${escapeHtml(t('summaryOutputQualityLabel'))}</span>
        <span class="ytg-summary-value">${escapeHtml(t('qualityOptionHeight', job.resolvedHeight))}</span>
      </div>
    `)
  }

  if (job.resolvedFormat) {
    lines.push(`
      <div class="ytg-summary-row">
        <span class="ytg-summary-label">${escapeHtml(t('summaryOutputFormatLabel'))}</span>
        <span class="ytg-summary-value">${escapeHtml(job.resolvedFormat.toUpperCase())}</span>
      </div>
    `)
  }

  return lines.join('')
}

function renderPanel() {
  if (!state.panel) return

  const nextServerState = getServerState()
  const relevantJob = getRelevantActiveJob()
  const alertText = panelAlert()

  const serverState = state.panel.querySelector('#ytg-server-state')
  serverState.classList.remove('pending', 'online', 'offline', 'unpaired')
  serverState.classList.add(serverStateClass(nextServerState))
  state.panel.querySelector('#ytg-server-label').textContent = serverStateLabel(nextServerState)

  state.panel.querySelector('#ytg-format-section').hidden = Boolean(relevantJob)
  const actionButton = state.panel.querySelector('#ytg-download')
  actionButton.hidden = Boolean(relevantJob)
  actionButton.disabled = !canStartDownload()

  if (!relevantJob && nextServerState.state === 'checking') {
    actionButton.textContent = t('downloadActionChecking')
  } else if (!relevantJob && state.formatSelection === 'mp4' && state.qualityStatus === 'loading') {
    actionButton.textContent = t('downloadActionLoadingQualities')
  } else {
    actionButton.textContent = t('downloadAction')
  }

  const alert = state.panel.querySelector('#ytg-alert')
  if (alertText && !relevantJob) {
    alert.hidden = false
    alert.textContent = alertText
  } else {
    alert.hidden = true
    alert.textContent = ''
  }

  renderQualityOptions()
  renderProgress(relevantJob)
}

async function refreshPanelState(forceServerRefresh) {
  const [serverResponse, jobResponse] = await Promise.all([
    sendBackground(forceServerRefresh ? 'refreshServerState' : 'getServerState'),
    sendBackground('getActiveJobState')
  ])

  if (serverResponse.ok) {
    state.serverState = serverResponse.serverState
  }
  if (jobResponse.ok) {
    state.activeJobState = jobResponse.activeJobState || null
  }
  state.panelErrorCode = ''
  renderPanel()

  if (!getRelevantActiveJob() && state.formatSelection === 'mp4' && getServerState().state === 'paired') {
    await ensureQualityOptions()
  }
}

async function ensureQualityOptions(forceRefresh = false) {
  if (state.formatSelection !== 'mp4') return
  const videoUrl = normalizeVideoURL(state.downloadContext?.url || location.href)
  if (!videoUrl) {
    state.qualityStatus = 'error'
    state.qualityErrorCode = 'invalid_url'
    renderPanel()
    return
  }
  if (!forceRefresh && state.qualityStatus === 'ready' && state.qualityRequestUrl === videoUrl) {
    renderPanel()
    return
  }
  if (!forceRefresh && state.qualityStatus === 'loading' && state.qualityRequestUrl === videoUrl) {
    return
  }

  state.qualityStatus = 'loading'
  state.qualityErrorCode = ''
  state.panelErrorCode = ''
  state.qualityRequestUrl = videoUrl
  const requestToken = Date.now()
  state.qualityRequestToken = requestToken
  renderPanel()

  const response = await sendBackground('getFormatOptions', { url: videoUrl })
  if (state.qualityRequestToken !== requestToken) return

  if (!response.ok) {
    state.qualityStatus = 'error'
    state.qualityErrorCode = response.errorCode || 'format_probe_failed'
    renderPanel()
    return
  }

  if (sanitizeText(response.title)) {
    state.downloadContext.title = sanitizeText(response.title)
    updatePanelTitle()
  }

  state.qualityOptions = Array.isArray(response.qualityOptions) ? response.qualityOptions : []
  if (!state.qualityOptions.some(option => option.value === state.selectedQuality)) {
    state.selectedQuality = state.qualityOptions[0]?.value || 'best'
  }
  state.qualityStatus = 'ready'
  renderPanel()
}

async function startDownloadFromPanel() {
  if (!canStartDownload()) return

  const response = await sendBackground('startDownloadJob', {
    url: state.downloadContext?.url || location.href,
    title: state.downloadContext?.title || getVideoTitle(),
    requestedFormat: state.formatSelection,
    requestedQuality: state.selectedQuality
  })

  if (!response.ok) {
    if (response.serverState) {
      state.serverState = response.serverState
    }
    if (response.activeJobState) {
      state.activeJobState = response.activeJobState
      state.panelErrorCode = response.errorCode || ''
    } else {
      state.panelErrorCode = response.errorCode || 'job_start_failed'
    }
    renderPanel()
    return
  }

  state.panelErrorCode = ''
  state.activeJobState = response.activeJobState || null
  renderPanel()
}

async function dismissActiveJobAndClose() {
  await sendBackground('dismissActiveJob')
  removePanel()
}

async function dismissOrClosePanel() {
  if (getRelevantActiveJob() && isTerminalRenderState()) {
    await dismissActiveJobAndClose()
    return
  }
  removePanel()
}

function removePanel() {
  if (state.outsideHandler) {
    document.removeEventListener('click', state.outsideHandler)
    state.outsideHandler = null
  }

  state.panel?.remove()
  state.panel = null
  state.panelAnchorEl = null
  state.downloadContext = null
  state.qualityStatus = 'idle'
  state.qualityOptions = []
  state.qualityErrorCode = ''
  state.panelErrorCode = ''
  state.qualityRequestUrl = ''
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'ytg:serverStateChanged') {
    state.serverState = message.serverState
    renderPanel()
    if (state.panel && !getRelevantActiveJob() && state.formatSelection === 'mp4' && getServerState().state === 'paired' && state.qualityStatus !== 'ready') {
      void ensureQualityOptions()
    }
    return
  }

  if (message?.type === 'ytg:activeJobStateChanged') {
    state.activeJobState = message.activeJobState || null
    renderPanel()
  }
})

scheduleInject()
watchPage()
