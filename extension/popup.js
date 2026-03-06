const dot = document.getElementById('dot')
const label = document.getElementById('label')
const hint = document.getElementById('hint')
const retryBtn = document.getElementById('retryBtn')

let checking = false

function setPending() {
  dot.classList.remove('err')
  label.textContent = 'Vérification du serveur...'
  hint.classList.remove('show')
  retryBtn.disabled = true
}

function setState(ok) {
  checking = false
  retryBtn.disabled = false

  if (ok) {
    dot.classList.remove('err')
    label.textContent = 'Serveur actif - localhost:9875'
    hint.classList.remove('show')
    return
  }

  dot.classList.add('err')
  label.textContent = 'Serveur introuvable'
  hint.textContent = 'Windows: lancez YTGrabber-Server.exe. Linux: systemctl --user start ytgrabber.'
  hint.classList.add('show')
}

async function pingWithTimeout(timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch('http://localhost:9875/ping', { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function checkStatus() {
  if (checking) return
  checking = true
  setPending()
  const ok = await pingWithTimeout(3000)
  setState(ok)
  chrome.runtime.sendMessage({ action: 'refreshHealth' }, () => {
    void chrome.runtime.lastError
  })
}

retryBtn.addEventListener('click', checkStatus)
checkStatus()
