const dot = document.getElementById('dot')
const label = document.getElementById('label')
const hint = document.getElementById('hint')
const versionNode = document.getElementById('version')
const tokenLine = document.getElementById('tokenLine')
const tokenLineLabel = document.getElementById('tokenLineLabel')
const tokenValue = document.getElementById('tokenValue')
const copyTokenBtn = document.getElementById('copyTokenBtn')
const pairingInfo = document.getElementById('pairingInfo')
const pairingInstaller = document.getElementById('pairingInstaller')
const pairingSurfaces = document.getElementById('pairingSurfaces')
const releaseLink = document.getElementById('releaseLink')
const retryBtn = document.getElementById('retryBtn')
const tokenInput = document.getElementById('tokenInput')
const saveTokenBtn = document.getElementById('saveTokenBtn')
const tokenEditorMsg = document.getElementById('tokenEditorMsg')
const tokenEditorLabel = document.getElementById('tokenEditorLabel')
const popupTitle = document.getElementById('popupTitle')

const TOKEN_RE = /^[a-f0-9]{64}$/i
let checking = false

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key
}

function sendBackground(action, payload = {}) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action, ...payload }, response => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, errorCode: 'runtime_unavailable', error: chrome.runtime.lastError.message })
        return
      }
      resolve(response || { ok: false, errorCode: 'empty_response' })
    })
  })
}

function applyStaticCopy() {
  document.title = t('popupDocumentTitle')
  popupTitle.textContent = t('popupTitle')
  tokenLineLabel.textContent = `${t('popupTokenLineLabel')} `
  copyTokenBtn.textContent = t('popupCopyToken')
  tokenEditorLabel.textContent = t('popupTokenEditorLabel')
  saveTokenBtn.textContent = t('popupSaveToken')
  retryBtn.textContent = t('popupRetry')
  pairingInstaller.textContent = t('popupInstallerHint')
  pairingSurfaces.textContent = t('popupSupportedSurfaces')
  releaseLink.textContent = t('popupReleaseLink')
}

function setTokenEditorMessage(text, mode = '') {
  tokenEditorMsg.textContent = text || ''
  tokenEditorMsg.classList.remove('err', 'ok')
  if (mode === 'err' || mode === 'ok') {
    tokenEditorMsg.classList.add(mode)
  }
}

function setTokenLine(token) {
  const value = typeof token === 'string' ? token.trim() : ''
  tokenInput.value = value
  if (!value) {
    tokenLine.classList.remove('show')
    pairingInfo.classList.remove('show')
    tokenValue.textContent = ''
    return
  }
  tokenValue.textContent = value
  tokenLine.classList.add('show')
  pairingInfo.classList.add('show')
}

function setReleaseLink(version) {
  const value = typeof version === 'string' ? version.trim() : ''
  if (value.startsWith('v')) {
    releaseLink.href = `https://github.com/thomas-hugon/yt-grabber/releases/tag/${encodeURIComponent(value)}`
    return
  }
  releaseLink.href = 'https://github.com/thomas-hugon/yt-grabber/releases/latest'
}

function setVersionLine(version, commit) {
  const value = typeof version === 'string' ? version.trim() : ''
  const sha = typeof commit === 'string' ? commit.trim() : ''
  if (!value && !sha) {
    versionNode.classList.remove('show')
    versionNode.textContent = ''
    return
  }
  versionNode.textContent = t('popupVersionLine', [value || 'unknown', (sha || 'unknown').slice(0, 12)])
  versionNode.classList.add('show')
  setReleaseLink(value)
}

function setPending() {
  dot.classList.remove('warn', 'err')
  label.textContent = t('popupStatusChecking')
  hint.classList.remove('show')
  hint.textContent = ''
  retryBtn.disabled = true
  setVersionLine('', '')
}

function renderServerState(serverState) {
  checking = false
  retryBtn.disabled = false
  dot.classList.remove('warn', 'err')

  if (!serverState || serverState.state === 'checking') {
    setPending()
    return
  }

  if (serverState.state === 'paired') {
    label.textContent = t('popupStatusPaired')
    hint.textContent = t('popupHintPaired')
    hint.classList.add('show')
    setVersionLine(serverState.version, serverState.commit)
    return
  }

  if (serverState.state === 'unpaired') {
    dot.classList.add('warn')
    label.textContent = t('popupStatusUnpaired')
    hint.textContent = unpairedHint(serverState.reason)
    hint.classList.add('show')
    setVersionLine(serverState.version, serverState.commit)
    return
  }

  dot.classList.add('err')
  label.textContent = t('popupStatusOffline')
  hint.textContent = t('popupHintOffline')
  hint.classList.add('show')
  setVersionLine('', '')
}

function unpairedHint(reason) {
  switch (reason) {
    case 'token_missing':
      return t('popupHintTokenMissing')
    case 'token_not_configured':
      return t('popupHintServerTokenMissing')
    default:
      return t('popupHintTokenInvalid')
  }
}

async function checkStatus(forceRefresh = false) {
  if (checking) return
  checking = true
  setPending()
  setTokenEditorMessage('')

  const tokenResponse = await sendBackground('getApiToken')
  if (tokenResponse.ok) {
    setTokenLine(tokenResponse.token)
  }

  const stateResponse = await sendBackground(forceRefresh ? 'refreshServerState' : 'getServerState')
  if (stateResponse.ok) {
    renderServerState(stateResponse.serverState)
    return
  }
  renderServerState({ state: 'offline' })
}

async function saveTokenFromInput() {
  const token = tokenInput.value.trim()
  if (!TOKEN_RE.test(token)) {
    setTokenEditorMessage(t('popupTokenInvalidFormat'), 'err')
    return
  }

  saveTokenBtn.disabled = true
  const response = await sendBackground('setApiToken', { token })
  saveTokenBtn.disabled = false

  if (!response.ok) {
    setTokenEditorMessage(t('popupTokenSaveError'), 'err')
    return
  }

  setTokenLine(response.token)
  setTokenEditorMessage(t('popupTokenSaved'), 'ok')
  if (response.serverState) {
    renderServerState(response.serverState)
  } else {
    await checkStatus(true)
  }
}

retryBtn.addEventListener('click', () => {
  void checkStatus(true)
})

saveTokenBtn.addEventListener('click', () => {
  void saveTokenFromInput()
})

tokenInput.addEventListener('keydown', evt => {
  if (evt.key !== 'Enter') return
  evt.preventDefault()
  void saveTokenFromInput()
})

copyTokenBtn.addEventListener('click', () => {
  const token = tokenValue.textContent.trim()
  if (!token) return
  navigator.clipboard.writeText(token).then(() => {
    setTokenEditorMessage(t('popupTokenCopied'), 'ok')
  }).catch(() => {})
})

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'ytg:serverStateChanged') {
    renderServerState(message.serverState)
  }
})

applyStaticCopy()
void checkStatus(false)
