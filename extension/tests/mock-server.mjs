import http from 'node:http'

function writeJSON(req, res, status, payload) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '*'
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': origin,
    vary: 'Origin',
    'access-control-allow-headers': 'Content-Type, X-YTG-Token, X-YTG-Job-Token',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  })
  res.end(JSON.stringify(payload))
}

function writeError(req, res, status, code, message) {
  writeJSON(req, res, status, { code, message })
}

function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

export function createMockServer() {
  const state = {
    expectedToken: 'a'.repeat(64),
    serverTokenConfigured: true,
    activeJobId: 'feedbeefcafecafe',
    activeJobToken: '0123456789abcdef0123456789abcdef',
    version: 'v-smoke',
    commit: 'smoke00000000',
    formatResponse: {
      title: 'Mock video',
      qualityOptions: ['best', '1080', '720']
    },
    formatFailure: null,
    downloadFailure: null,
    downloadCalls: 0,
    formatCalls: 0,
    jobCalls: 0,
    fileCalls: 0,
    lastDownloadBody: null,
    lastFormatsBody: null,
    jobIndex: 0,
    jobSequence: [
      {
        status: 'downloading',
        progress: 38.4,
        speed: '3.1MiB/s',
        eta: '00:09',
        title: 'Mock video',
        filename: '',
        error: '',
        requested_format: 'mp4',
        requested_quality: '720',
        resolved_format: '',
        resolved_height: ''
      },
      {
        status: 'processing',
        progress: 100,
        speed: '',
        eta: '',
        title: 'Mock video',
        filename: '',
        error: '',
        requested_format: 'mp4',
        requested_quality: '720',
        resolved_format: '',
        resolved_height: ''
      },
      {
        status: 'ready',
        progress: 100,
        speed: '',
        eta: '',
        title: 'Mock video',
        filename: 'mock-video.mp4',
        error: '',
        requested_format: 'mp4',
        requested_quality: '720',
        resolved_format: 'mp4',
        resolved_height: '720'
      }
    ]
  }

  function requireAuth(req, res) {
    if (!state.serverTokenConfigured) {
      writeError(req, res, 503, 'token_not_configured', 'server token not configured')
      return false
    }
    const token = typeof req.headers['x-ytg-token'] === 'string' ? req.headers['x-ytg-token'].trim() : ''
    if (!token) {
      writeError(req, res, 401, 'token_missing', 'missing token')
      return false
    }
    if (token !== state.expectedToken) {
      writeError(req, res, 401, 'token_invalid', 'invalid token')
      return false
    }
    return true
  }

  function requireJobAccess(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    const jobToken = (url.searchParams.get('job_token') || '').trim()
    if (jobToken) {
      if (jobToken !== state.activeJobToken) {
        writeError(req, res, 401, 'job_token_invalid', 'invalid job token')
        return false
      }
      return true
    }
    return requireAuth(req, res)
  }

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      writeError(req, res, 400, 'bad_request', 'missing url')
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': typeof req.headers.origin === 'string' ? req.headers.origin : '*',
        vary: 'Origin',
        'access-control-allow-headers': 'Content-Type, X-YTG-Token, X-YTG-Job-Token',
        'access-control-allow-methods': 'GET,POST,OPTIONS'
      })
      res.end()
      return
    }

    const parsedURL = new URL(req.url, 'http://localhost')

    if (parsedURL.pathname === '/ping' && req.method === 'GET') {
      writeJSON(req, res, 200, {
        status: 'ok',
        version: state.version,
        commit: state.commit
      })
      return
    }

    if (parsedURL.pathname === '/pairing' && req.method === 'GET') {
      if (!requireAuth(req, res)) return
      writeJSON(req, res, 200, {
        status: 'paired',
        version: state.version,
        commit: state.commit
      })
      return
    }

    if (parsedURL.pathname === '/formats' && req.method === 'POST') {
      if (!requireAuth(req, res)) return
      state.formatCalls += 1
      try {
        state.lastFormatsBody = await parseJSONBody(req)
      } catch {
        writeError(req, res, 400, 'invalid_json', 'invalid json body')
        return
      }

      if (state.formatFailure) {
        writeError(req, res, state.formatFailure.status, state.formatFailure.code, state.formatFailure.message)
        return
      }

      writeJSON(req, res, 200, {
        status: 'ok',
        title: state.formatResponse.title,
        quality_options: state.formatResponse.qualityOptions
      })
      return
    }

    if (parsedURL.pathname === '/download' && req.method === 'POST') {
      if (!requireAuth(req, res)) return
      state.downloadCalls += 1
      try {
        state.lastDownloadBody = await parseJSONBody(req)
      } catch {
        writeError(req, res, 400, 'invalid_json', 'invalid json body')
        return
      }

      if (state.downloadFailure) {
        writeError(req, res, state.downloadFailure.status, state.downloadFailure.code, state.downloadFailure.message)
        return
      }

      state.jobIndex = 0
      writeJSON(req, res, 202, {
        job_id: state.activeJobId,
        job_token: state.activeJobToken
      })
      return
    }

    if (parsedURL.pathname === `/job/${state.activeJobId}` && req.method === 'GET') {
      if (!requireJobAccess(req, res)) return
      state.jobCalls += 1
      const snapshot = state.jobSequence[Math.min(state.jobIndex, state.jobSequence.length - 1)]
      if (state.jobIndex < state.jobSequence.length - 1) {
        state.jobIndex += 1
      }
      writeJSON(req, res, 200, snapshot)
      return
    }

    if (parsedURL.pathname === `/file/${state.activeJobId}` && req.method === 'GET') {
      if (!requireJobAccess(req, res)) return
      state.fileCalls += 1
      const lastSnapshot = state.jobSequence[state.jobSequence.length - 1] || {}
      const filename = typeof lastSnapshot.filename === 'string' && lastSnapshot.filename ? lastSnapshot.filename : 'mock-output.bin'
      const body = Buffer.from('mock-file\n', 'utf8')
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'access-control-allow-origin': typeof req.headers.origin === 'string' ? req.headers.origin : '*',
        vary: 'Origin'
      })
      res.end(body)
      return
    }

    writeError(req, res, 404, 'not_found', 'not found')
  })

  return {
    state,
    setExpectedToken(token) {
      state.expectedToken = token
    },
    setServerTokenConfigured(configured) {
      state.serverTokenConfigured = Boolean(configured)
    },
    setFormatResponse(response) {
      state.formatResponse = {
        title: response?.title || 'Mock video',
        qualityOptions: Array.isArray(response?.qualityOptions) ? response.qualityOptions : ['best']
      }
      state.formatFailure = null
    },
    setFormatFailure(status, code, message) {
      state.formatFailure = { status, code, message }
    },
    clearFormatFailure() {
      state.formatFailure = null
    },
    setDownloadFailure(status, code, message) {
      state.downloadFailure = { status, code, message }
    },
    clearDownloadFailure() {
      state.downloadFailure = null
    },
    setJobSequence(sequence) {
      state.jobSequence = Array.isArray(sequence) && sequence.length > 0 ? sequence : state.jobSequence
      state.jobIndex = 0
    },
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
