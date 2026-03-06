import http from 'node:http'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://www.youtube.com',
  'Access-Control-Allow-Headers': 'Content-Type, X-YTG-Token',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
}

function writeJSON(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...CORS_HEADERS
  })
  res.end(JSON.stringify(payload))
}

export function createMockServer() {
  const state = {
    downloadCalls: 0,
    progressCalls: 0,
    fileCalls: 0,
    lastDownloadBody: null
  }

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      writeJSON(res, 400, { code: 'bad_request', message: 'missing url' })
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    if (req.url === '/ping' && req.method === 'GET') {
      writeJSON(res, 200, {
        status: 'ok',
        version: 'v-smoke',
        commit: 'smoke00000000'
      })
      return
    }

    if (req.url === '/download' && req.method === 'POST') {
      state.downloadCalls += 1
      const chunks = []
      for await (const chunk of req) {
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        state.lastDownloadBody = JSON.parse(raw)
      } catch {
        state.lastDownloadBody = raw
      }
      writeJSON(res, 202, {
        job_id: 'feedbeefcafecafe',
        job_token: '0123456789abcdef0123456789abcdef'
      })
      return
    }

    if (req.url.startsWith('/progress/feedbeefcafecafe') && req.method === 'GET') {
      state.progressCalls += 1
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...CORS_HEADERS
      })

      const events = [
        { status: 'downloading', progress: 37.2, speed: '3.1MiB/s', eta: '00:09', title: '', filename: '', error: '' },
        { status: 'processing', progress: 100, speed: '', eta: '', title: '', filename: '', error: '' },
        { status: 'ready', progress: 100, speed: '', eta: '', title: '', filename: 'demo.mp4', error: '' }
      ]

      let idx = 0
      const timer = setInterval(() => {
        if (idx >= events.length) {
          clearInterval(timer)
          res.end()
          return
        }
        res.write(`data: ${JSON.stringify(events[idx])}\n\n`)
        idx += 1
      }, 150)
      req.on('close', () => clearInterval(timer))
      return
    }

    if (req.url.startsWith('/file/feedbeefcafecafe') && req.method === 'GET') {
      state.fileCalls += 1
      const body = Buffer.from('smoke-test-file\n', 'utf8')
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
        'content-disposition': "attachment; filename*=UTF-8''demo.mp4",
        ...CORS_HEADERS
      })
      res.end(body)
      return
    }

    writeJSON(res, 404, { code: 'not_found', message: 'not found' })
  })

  return {
    state,
    async start(port = 9875, host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => resolve())
      })
    },
    async stop() {
      await new Promise(resolve => server.close(() => resolve()))
    }
  }
}
