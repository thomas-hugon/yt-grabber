const dot = document.getElementById('dot')
const label = document.getElementById('label')
const hint = document.getElementById('hint')
const versionNode = document.getElementById('version')
const tokenLine = document.getElementById('tokenLine')
const tokenValue = document.getElementById('tokenValue')
const copyTokenBtn = document.getElementById('copyTokenBtn')
const pairingInfo = document.getElementById('pairingInfo')
const releaseLink = document.getElementById('releaseLink')
const retryBtn = document.getElementById('retryBtn')
const tokenInput = document.getElementById('tokenInput')
const saveTokenBtn = document.getElementById('saveTokenBtn')
const tokenEditorMsg = document.getElementById('tokenEditorMsg')

let checking = false
const TOKEN_RE = /^[a-f0-9]{64}$/i

function setPending() {
  dot.classList.remove('err')
  label.textContent = 'Vérification du serveur...'
  hint.classList.remove('show')
  versionNode.classList.remove('show')
  versionNode.textContent = ''
  retryBtn.disabled = true
}

function setTokenLine(token) {
  const t = typeof token === 'string' ? token.trim() : ''
  tokenInput.value = t
  if (!t) {
    tokenLine.classList.remove('show')
    pairingInfo.classList.remove('show')
    tokenValue.textContent = ''
    return
  }
  tokenValue.textContent = t
  tokenLine.classList.add('show')
  pairingInfo.classList.add('show')
}

function setReleaseLink(version) {
  const v = typeof version === 'string' ? version.trim() : ''
  if (v.startsWith('v')) {
    releaseLink.href = `https://github.com/thomas-hugon/yt-grabber/releases/tag/${encodeURIComponent(v)}`
    return
  }
  releaseLink.href = 'https://github.com/thomas-hugon/yt-grabber/releases/latest'
}

function setTokenEditorMessage(text, mode = '') {
  tokenEditorMsg.textContent = text || ''
  tokenEditorMsg.classList.remove('err', 'ok')
  if (mode === 'err' || mode === 'ok') {
    tokenEditorMsg.classList.add(mode)
  }
}

function saveTokenFromInput() {
  const token = tokenInput.value.trim()
  if (!TOKEN_RE.test(token)) {
    setTokenEditorMessage('Le token doit contenir 64 caractères hexadécimaux.', 'err')
    return
  }

  saveTokenBtn.disabled = true
  chrome.runtime.sendMessage({ action: 'setApiToken', token }, response => {
    saveTokenBtn.disabled = false
    if (chrome.runtime.lastError || !response?.ok) {
      setTokenEditorMessage('Impossible d’enregistrer le token.', 'err')
      return
    }
    setTokenLine(response.token)
    setTokenEditorMessage('Token enregistré.', 'ok')
    checkStatus()
  })
}

function setVersionLine(version, commit) {
  const v = typeof version === 'string' ? version.trim() : ''
  const c = typeof commit === 'string' ? commit.trim() : ''
  if (!v && !c) {
    versionNode.classList.remove('show')
    versionNode.textContent = ''
    return
  }
  const shortCommit = c ? c.slice(0, 12) : 'unknown'
  versionNode.textContent = `Version: ${v || 'unknown'} (${shortCommit})`
  versionNode.classList.add('show')
}

function setState(result) {
  const ok = result?.ok === true
  checking = false
  retryBtn.disabled = false

  if (ok) {
    dot.classList.remove('err')
    label.textContent = 'Serveur actif - localhost:9875'
    hint.classList.remove('show')
    setVersionLine(result.version, result.commit)
    setReleaseLink(result.version)
    return
  }

  dot.classList.add('err')
  label.textContent = 'Serveur introuvable'
  hint.textContent = 'Windows: lancez YTGrabber-Server.exe. Linux: systemctl --user start ytgrabber.'
  hint.classList.add('show')
  setVersionLine('', '')
}

async function pingWithTimeout(timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch('http://localhost:9875/ping', { signal: controller.signal })
    if (!response.ok) return { ok: false }
    const payload = await response.json().catch(() => ({}))
    return {
      ok: true,
      version: typeof payload.version === 'string' ? payload.version : '',
      commit: typeof payload.commit === 'string' ? payload.commit : ''
    }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

async function checkStatus() {
  if (checking) return
  checking = true
  setPending()
  setTokenEditorMessage('')
  chrome.runtime.sendMessage({ action: 'getApiToken' }, response => {
    if (!chrome.runtime.lastError && response?.ok) {
      setTokenLine(response.token)
    }
  })
  const result = await pingWithTimeout(3000)
  setState(result)
  chrome.runtime.sendMessage({ action: 'refreshHealth' }, () => {
    void chrome.runtime.lastError
  })
}

retryBtn.addEventListener('click', checkStatus)
saveTokenBtn.addEventListener('click', saveTokenFromInput)
tokenInput.addEventListener('keydown', evt => {
  if (evt.key !== 'Enter') return
  evt.preventDefault()
  saveTokenFromInput()
})
copyTokenBtn.addEventListener('click', () => {
  const token = tokenValue.textContent.trim()
  if (!token) return
  navigator.clipboard.writeText(token).catch(() => {})
})
checkStatus()
