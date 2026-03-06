chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.action !== 'download' || !message.jobId) return

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
