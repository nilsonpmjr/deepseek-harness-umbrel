#!/usr/bin/env node
/**
 * Container supervisor and HTTP/SSE/WebSocket reverse proxy for DeepSeek Harness on Umbrel.
 *
 * Responsibilities:
 *  - Spawn and supervise `dsh web` on loopback (`127.0.0.1:<DSH_BACKEND_PORT>`).
 *  - Capture its per-launch auth token from stdout without writing it to manifests.
 *  - Expose an HTTP + WebSocket proxy on `0.0.0.0:<DSH_PROXY_PORT>` for Umbrel's `app_proxy`.
 *  - Enforce same-origin CSRF checks before rewriting Host/Origin to the loopback backend.
 *  - When `DSH_UMBREL_APP_PROXY_AUTH=1` (protected by Umbrel app_proxy auth), transparently
 *    exchange the launch token on unauthenticated `GET /` requests so any browser works
 *    immediately without manual token copying.
 *  - Enable DeepSeek Account OAuth sign-in from non-loopback Umbrel browsers (umbrel.local,
 *    LAN IP, Tailscale, HTTPS) by rewriting non-loopback `callbackOrigin` in
 *    `POST /api/account/startSignIn` to the container's loopback origin and providing a
 *    same-origin callback relay (`POST /__umbrel/oauth-complete`) paired with an injected
 *    browser helper (`/ __umbrel/oauth-helper.js`).
 *  - Serve a clean auto-refreshing loading page while `dsh web` is booting.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TOKEN_PATTERN = /\?token=([A-Za-z0-9_-]+)/u
const AUTH_COOKIE_PATTERN = /(?:^|;\s*)dsh-auth-[^=;\s]+=/u
const LOOPBACK_ORIGIN_PATTERN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([1-9][0-9]*)\/?$/i
const MAX_CONTROL_BODY_BYTES = 65_536
const PENDING_SIGNIN_TTL_MS = 10 * 60 * 1000
const HELPER_SCRIPT_TAG = '<script src="/__umbrel/oauth-helper.js" defer></script>'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const OAUTH_HELPER_JS = readFileSync(join(MODULE_DIR, 'oauth-helper.js'), 'utf8')

const LOADING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="2" />
  <title>Starting DeepSeek Harness...</title>
  <style>
    :root { color-scheme: dark light; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
    }
    .card {
      text-align: center;
      padding: 2rem 2.5rem;
      border-radius: 16px;
      background: rgba(30, 41, 59, 0.85);
      border: 1px solid rgba(148, 163, 184, 0.2);
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
      max-width: 360px;
    }
    .spinner {
      width: 36px;
      height: 36px;
      margin: 0 auto 1rem;
      border: 3px solid rgba(77, 107, 254, 0.25);
      border-top-color: #4d6bfe;
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 0.4rem; }
    p { font-size: 0.9rem; color: #94a3b8; margin: 0; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner" aria-hidden="true"></div>
    <h1>Starting DeepSeek Harness</h1>
    <p>Preparing your workspace. This page refreshes automatically.</p>
  </div>
</body>
</html>
`

/**
 * Normalize an HTTP Host header or URL host for case-insensitive comparison,
 * stripping explicit default ports (:80 for http:, :443 for https:).
 */
function normalizeHost(hostHeader, protocol = 'http:') {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return null
  try {
    const parsed = new URL(`${protocol}//${hostHeader.trim()}`)
    return parsed.host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Enforce the same browser CSRF invariants as dsh web before rewriting Host/Origin
 * to the internal loopback backend.
 */
export function isTrustedSameOriginRequest(headers) {
  const secFetchSite = headers['sec-fetch-site']
  if (typeof secFetchSite === 'string' && secFetchSite.toLowerCase() === 'cross-site') {
    return false
  }

  const originHeader = headers.origin
  if (typeof originHeader !== 'string' || originHeader === '') {
    return true
  }

  if (originHeader === 'null') {
    return false
  }

  let originUrl
  try {
    originUrl = new URL(originHeader)
  } catch {
    return false
  }

  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
    return false
  }

  const normalizedHost = normalizeHost(headers.host, originUrl.protocol)
  if (normalizedHost === null) {
    return false
  }

  return originUrl.host.toLowerCase() === normalizedHost
}

/**
 * Check whether an origin already satisfies DeepSeek's loopback HTTP OAuth redirect_uri requirement.
 */
export function isLoopbackOrigin(value) {
  return typeof value === 'string' && LOOPBACK_ORIGIN_PATTERN.test(value.trim())
}

/**
 * Rewrite non-loopback `callbackOrigin` in `POST /api/account/startSignIn` RPC payloads
 * so DeepSeek's platform OAuth server (`auth_init`) accepts the request from remote Umbrel hosts.
 */
export function rewriteStartSignInBody(rawBody, loopbackOrigin) {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'))
    const args = parsed?.payload?.args
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      if (typeof args.callbackOrigin === 'string' && !isLoopbackOrigin(args.callbackOrigin)) {
        args.callbackOrigin = loopbackOrigin
        return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), rewritten: true }
      }
    } else if (Array.isArray(args) && typeof args[1] === 'string' && !isLoopbackOrigin(args[1])) {
      args[1] = loopbackOrigin
      return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), rewritten: true }
    }
  } catch {
    // Forward malformed JSON untouched so dsh web produces its standard RPC error.
  }
  return { body: rawBody, rewritten: false }
}

/**
 * Parse a user-pasted OAuth callback URL (full URL, path+query, or raw query) and return a
 * canonical `/oauth/callback?code=...&state=...` path safe to forward to loopback `dsh web`.
 */
export function parseOAuthCallbackInput(rawInput) {
  if (typeof rawInput !== 'string') {
    return { ok: false, error: 'missing_params' }
  }
  const trimmed = rawInput.trim()
  if (!trimmed || /[\r\n]/u.test(trimmed)) {
    return { ok: false, error: 'missing_params' }
  }

  let parsed
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      parsed = new URL(trimmed)
      if (parsed.pathname !== '/oauth/callback') {
        return { ok: false, error: 'missing_params' }
      }
    } else if (trimmed.startsWith('/')) {
      parsed = new URL(trimmed, 'http://127.0.0.1')
      if (parsed.pathname !== '/oauth/callback') {
        return { ok: false, error: 'missing_params' }
      }
    } else if (trimmed.startsWith('?')) {
      parsed = new URL(`/oauth/callback${trimmed}`, 'http://127.0.0.1')
    } else {
      parsed = new URL(`/oauth/callback?${trimmed}`, 'http://127.0.0.1')
    }
  } catch {
    return { ok: false, error: 'missing_params' }
  }

  const codes = parsed.searchParams.getAll('code')
  const states = parsed.searchParams.getAll('state')
  const code = codes.length === 1 ? codes[0].trim() : ''
  const state = states.length === 1 ? states[0].trim() : ''
  if (!code || !state) {
    return { ok: false, error: 'missing_params' }
  }

  return {
    ok: true,
    code,
    state,
    path: `/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  }
}

/**
 * Splice the Umbrel remote OAuth helper script into the served SPA index.html.
 */
export function injectOAuthHelperScript(html) {
  if (html.includes('/__umbrel/oauth-helper.js')) return html
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${HELPER_SCRIPT_TAG}</body>`)
  }
  return `${html}${HELPER_SCRIPT_TAG}`
}

function getPathname(rawUrl) {
  try {
    return new URL(rawUrl ?? '/', 'http://proxy.invalid').pathname
  } catch {
    return ''
  }
}

/**
 * Check whether an incoming request targets the clean root document without a query token.
 */
function isCleanRootGet(req) {
  if (req.method !== 'GET') return false
  try {
    const url = new URL(req.url ?? '/', 'http://proxy.invalid')
    return url.pathname === '/' && !url.searchParams.has('token')
  } catch {
    return false
  }
}

function isIndexDocumentGet(req) {
  if (req.method !== 'GET') return false
  const pathname = getPathname(req.url)
  return pathname === '/' || pathname === '/index.html'
}

function hasAuthCookie(headers) {
  return typeof headers.cookie === 'string' && AUTH_COOKIE_PATTERN.test(headers.cookie)
}

/**
 * Build headers for the loopback backend while rewriting Host/Origin/Referer so
 * dsh web accepts requests forwarded from any Umbrel hostname, IP, HTTPS, or Tor route.
 */
function buildUpstreamHeaders(incomingHeaders, backendAuthority) {
  const headers = { ...incomingHeaders }
  const backendOrigin = `http://${backendAuthority}`

  headers.host = backendAuthority
  if (typeof headers.origin === 'string' && headers.origin !== '') {
    headers.origin = backendOrigin
  }
  if (typeof headers.referer === 'string' && headers.referer !== '') {
    try {
      const ref = new URL(headers.referer)
      headers.referer = `${backendOrigin}${ref.pathname}${ref.search}`
    } catch {
      delete headers.referer
    }
  }
  // Remove proxy headers that dsh does not trust or need on loopback.
  delete headers['x-forwarded-host']
  delete headers['x-forwarded-proto']
  delete headers['x-forwarded-for']

  return headers
}

/**
 * Determine whether a request requires same-origin CSRF validation.
 * Top-level GET/HEAD document navigations (e.g. clicking the app icon from the
 * Umbrel dashboard across http/https or returning from /app-auth) are allowed,
 * matching dsh web's own /api trust fence.
 */
function requiresSameOriginCheck(req) {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return true
  const pathname = getPathname(req.url)
  if (!pathname) return true
  return (
    pathname === '/api'
    || pathname.startsWith('/api/')
    || pathname === '/__umbrel'
    || pathname.startsWith('/__umbrel/')
  )
}

function readRequestBody(req, maxBytes = MAX_CONTROL_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        const err = new Error('Payload too large')
        err.code = 'PAYLOAD_TOO_LARGE'
        reject(err)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

/**
 * Create the HTTP + WebSocket reverse proxy server.
 */
export function createProxyServer({
  backendHost = '127.0.0.1',
  backendPort = 3081,
  autoAuth = true,
  getLaunchToken,
}) {
  const backendAuthority = `${backendHost}:${backendPort}`
  const backendOrigin = `http://${backendAuthority}`

  let pendingRemoteSignInUntil = 0
  const isRemoteSignInPending = () => Date.now() < pendingRemoteSignInUntil
  const markRemoteSignInPending = () => {
    pendingRemoteSignInUntil = Date.now() + PENDING_SIGNIN_TTL_MS
  }
  const clearRemoteSignInPending = () => {
    pendingRemoteSignInUntil = 0
  }

  function forwardHttp(clientReq, clientRes, targetPath, { retryWithToken = false, injectHelper = false, bodyBuffer = null, onUpstreamResponse = null } = {}) {
    const upstreamHeaders = buildUpstreamHeaders(clientReq.headers, backendAuthority)
    if (injectHelper) {
      // Request uncompressed index.html so the helper script can be spliced cleanly.
      upstreamHeaders['accept-encoding'] = 'identity'
    }
    if (bodyBuffer !== null) {
      upstreamHeaders['content-length'] = String(bodyBuffer.length)
      delete upstreamHeaders['transfer-encoding']
    }

    const upstreamReq = http.request(
      {
        hostname: backendHost,
        port: backendPort,
        method: clientReq.method,
        path: targetPath,
        headers: upstreamHeaders,
      },
      (upstreamRes) => {
        const token = getLaunchToken()
        if (retryWithToken && upstreamRes.statusCode === 401 && token) {
          upstreamRes.resume()
          const authedPath = `/?token=${encodeURIComponent(token)}`
          forwardHttp(clientReq, clientRes, authedPath, { retryWithToken: false, injectHelper: false })
          return
        }

        if (onUpstreamResponse) {
          onUpstreamResponse(upstreamRes.statusCode ?? 502)
        }

        const contentType = String(upstreamRes.headers['content-type'] ?? '').toLowerCase()
        const contentEncoding = String(upstreamRes.headers['content-encoding'] ?? '').toLowerCase()
        if (injectHelper && upstreamRes.statusCode === 200 && contentType.includes('text/html') && !contentEncoding) {
          const chunks = []
          upstreamRes.on('data', (chunk) => chunks.push(chunk))
          upstreamRes.on('end', () => {
            const rawHtml = Buffer.concat(chunks).toString('utf8')
            const injected = injectOAuthHelperScript(rawHtml)
            const outBytes = Buffer.from(injected, 'utf8')
            const outHeaders = { ...upstreamRes.headers }
            outHeaders['content-length'] = String(outBytes.length)
            delete outHeaders['transfer-encoding']
            clientRes.writeHead(200, outHeaders)
            clientRes.end(outBytes)
          })
          return
        }

        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(clientRes)
      },
    )

    upstreamReq.on('error', (error) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        })
        clientRes.end(`DeepSeek Harness backend unavailable: ${error.message}\n`)
      } else {
        clientRes.destroy(error)
      }
    })

    clientReq.on('aborted', () => {
      upstreamReq.destroy()
    })

    if (bodyBuffer !== null) {
      upstreamReq.end(bodyBuffer)
    } else if (clientReq.method === 'GET' || clientReq.method === 'HEAD') {
      upstreamReq.end()
    } else {
      clientReq.pipe(upstreamReq)
    }
  }

  function handleOAuthComplete(req, res) {
    readRequestBody(req)
      .then((raw) => {
        let parsedBody
        try {
          parsedBody = JSON.parse(raw.toString('utf8'))
        } catch {
          sendJson(res, 400, { ok: false, error: 'missing_params' })
          return
        }

        const callback = parseOAuthCallbackInput(parsedBody?.callbackUrl)
        if (!callback.ok) {
          sendJson(res, 400, { ok: false, error: callback.error })
          return
        }

        const upstreamHeaders = {
          host: backendAuthority,
          accept: 'text/html, */*;q=0.8',
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie !== '') {
          upstreamHeaders.cookie = req.headers.cookie
        }

        const upstreamReq = http.request(
          {
            hostname: backendHost,
            port: backendPort,
            method: 'GET',
            path: callback.path,
            headers: upstreamHeaders,
            agent: false,
          },
          (upstreamRes) => {
            // Drain response body completely before answering so dsh web finishes commit cleanly.
            upstreamRes.resume()
            upstreamRes.on('end', () => {
              const status = upstreamRes.statusCode ?? 502
              if (status === 302) {
                clearRemoteSignInPending()
                sendJson(res, 200, { ok: true })
              } else if (status === 400) {
                sendJson(res, 400, { ok: false, error: 'invalid_callback' })
              } else if (status === 410) {
                clearRemoteSignInPending()
                sendJson(res, 410, { ok: false, error: 'expired' })
              } else if (status === 200 || status === 204) {
                clearRemoteSignInPending()
                sendJson(res, 502, { ok: false, error: 'exchange_failed' })
              } else {
                sendJson(res, 502, { ok: false, error: 'upstream_error', status })
              }
            })
          },
        )
        upstreamReq.on('error', () => {
          sendJson(res, 502, { ok: false, error: 'upstream_error' })
        })
        upstreamReq.end()
      })
      .catch((error) => {
        const status = error?.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400
        sendJson(res, status, { ok: false, error: 'invalid_request' })
      })
  }

  const server = http.createServer((req, res) => {
    // Allow long-lived SSE connections (e.g. /plugins/events) without idle timeout.
    req.setTimeout(0)
    res.setTimeout(0)

    const token = getLaunchToken()
    const pathname = getPathname(req.url)

    if (pathname === '/__health') {
      if (token) {
        sendJson(res, 200, { status: 'ready' })
      } else {
        sendJson(res, 503, { status: 'starting' })
      }
      return
    }

    if (requiresSameOriginCheck(req) && !isTrustedSameOriginRequest(req.headers)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('Forbidden\n')
      return
    }

    if (req.method === 'GET' && pathname === '/__umbrel/oauth-helper.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(Buffer.byteLength(OAUTH_HELPER_JS)),
      })
      res.end(OAUTH_HELPER_JS)
      return
    }

    if (req.method === 'GET' && pathname === '/__umbrel/oauth-status') {
      sendJson(res, 200, {
        pending: isRemoteSignInPending(),
        callbackOrigin: backendOrigin,
      })
      return
    }

    if (!token) {
      if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(LOADING_HTML)
      } else {
        res.writeHead(503, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'retry-after': '2',
        })
        res.end('DeepSeek Harness is starting...\n')
      }
      return
    }

    if (req.method === 'POST' && pathname === '/__umbrel/oauth-complete') {
      handleOAuthComplete(req, res)
      return
    }

    if (req.method === 'POST' && pathname === '/api/account/startSignIn') {
      readRequestBody(req)
        .then((rawBody) => {
          const { body, rewritten } = rewriteStartSignInBody(rawBody, backendOrigin)
          forwardHttp(req, res, req.url ?? '/api/account/startSignIn', {
            bodyBuffer: body,
            onUpstreamResponse: (status) => {
              if (rewritten && status === 200) {
                markRemoteSignInPending()
              }
            },
          })
        })
        .catch((error) => {
          const status = error?.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400
          res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('Invalid request\n')
        })
      return
    }

    if (req.method === 'POST' && (pathname === '/api/account/cancelSignIn' || pathname === '/api/account/signOut')) {
      clearRemoteSignInPending()
      forwardHttp(req, res, req.url ?? pathname)
      return
    }

    const rootGet = isCleanRootGet(req)
    const indexGet = isIndexDocumentGet(req)
    if (autoAuth && rootGet && !hasAuthCookie(req.headers)) {
      forwardHttp(req, res, `/?token=${encodeURIComponent(token)}`, { retryWithToken: false, injectHelper: false })
      return
    }

    forwardHttp(req, res, req.url ?? '/', { retryWithToken: autoAuth && rootGet, injectHelper: indexGet })
  })

  server.on('upgrade', (req, clientSocket, head) => {
    const token = getLaunchToken()
    if (!token) {
      clientSocket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      clientSocket.destroy()
      return
    }

    if (!isTrustedSameOriginRequest(req.headers)) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      clientSocket.destroy()
      return
    }

    const upstreamSocket = net.connect(backendPort, backendHost, () => {
      const headers = buildUpstreamHeaders(req.headers, backendAuthority)
      const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${key}: ${item}`)
        } else {
          lines.push(`${key}: ${value}`)
        }
      }
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)
    })

    const cleanup = () => {
      if (!clientSocket.destroyed) clientSocket.destroy()
      if (!upstreamSocket.destroyed) upstreamSocket.destroy()
    }
    upstreamSocket.on('error', cleanup)
    clientSocket.on('error', cleanup)
    upstreamSocket.on('end', cleanup)
    clientSocket.on('end', cleanup)
    upstreamSocket.on('close', cleanup)
    clientSocket.on('close', cleanup)
  })

  return server
}

function startSupervisor() {
  const proxyHost = process.env.DSH_PROXY_HOST || '0.0.0.0'
  const proxyPort = Number(process.env.DSH_PROXY_PORT || '3080')
  const backendHost = '127.0.0.1'
  const backendPort = Number(process.env.DSH_BACKEND_PORT || '3081')
  const autoAuth = process.env.DSH_UMBREL_APP_PROXY_AUTH !== '0'
  const dshBin = process.env.DSH_BIN || 'dsh'

  const dshHome = process.env.DSH_HOME || '/data/dsh-home'
  const workspaceDir = process.env.DSH_WORKSPACE || '/data/workspace'
  const userHome = process.env.HOME || '/data/home'

  for (const dir of [dshHome, workspaceDir, userHome]) {
    mkdirSync(dir, { recursive: true })
  }

  let launchToken = null
  let child = null
  let shuttingDown = false
  let restartTimer = null

  function spawnBackend() {
    if (shuttingDown) return
    launchToken = null

    const args = ['--profile', 'web', '--host', backendHost, '--port', String(backendPort), '--no-open']
    console.log(`[dsh-umbrel] starting backend: ${dshBin} ${args.join(' ')}`)

    const proc = spawn(dshBin, args, {
      cwd: workspaceDir,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        HOME: userHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child = proc

    let stdoutBuffer = ''
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stdoutBuffer += text
      const lines = stdoutBuffer.split(/\r?\n/u)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const match = TOKEN_PATTERN.exec(line)
        if (match && match[1]) {
          launchToken = match[1]
          console.log('[dsh-umbrel] backend ready (launch token captured)')
        } else if (line.length > 0) {
          console.log(line)
        }
      }
    })

    proc.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
    })

    proc.on('exit', (code, signal) => {
      if (child === proc) {
        child = null
        launchToken = null
      }
      if (shuttingDown) {
        process.exit(code ?? 0)
      }
      console.error(`[dsh-umbrel] backend exited (code=${code}, signal=${signal}); restarting in 2s`)
      restartTimer = setTimeout(spawnBackend, 2000)
    })
  }

  const server = createProxyServer({
    backendHost,
    backendPort,
    autoAuth,
    getLaunchToken: () => launchToken,
  })

  server.listen(proxyPort, proxyHost, () => {
    console.log(`[dsh-umbrel] proxy listening on http://${proxyHost}:${proxyPort} (autoAuth=${autoAuth})`)
    spawnBackend()
  })

  function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[dsh-umbrel] received ${signal}, shutting down...`)
    if (restartTimer) clearTimeout(restartTimer)
    server.close()
    server.closeAllConnections()
    if (child && !child.killed) {
      child.kill(signal)
      setTimeout(() => {
        if (child && !child.killed) child.kill('SIGKILL')
        process.exit(0)
      }, 10_000).unref()
    } else {
      process.exit(0)
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  startSupervisor()
}
