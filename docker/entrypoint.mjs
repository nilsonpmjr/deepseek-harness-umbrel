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
 *  - Serve a clean auto-refreshing loading page while `dsh web` is booting.
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { pathToFileURL } from 'node:url'

const TOKEN_PATTERN = /\?token=([A-Za-z0-9_-]+)/u
const AUTH_COOKIE_PATTERN = /(?:^|;\s*)dsh-auth-[^=;\s]+=/u

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
 * Create the HTTP + WebSocket reverse proxy server.
 */
export function createProxyServer({
  backendHost = '127.0.0.1',
  backendPort = 3081,
  autoAuth = true,
  getLaunchToken,
}) {
  const backendAuthority = `${backendHost}:${backendPort}`

  function forwardHttp(clientReq, clientRes, targetPath, retryWithToken) {
    const upstreamHeaders = buildUpstreamHeaders(clientReq.headers, backendAuthority)
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
          forwardHttp(clientReq, clientRes, authedPath, false)
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

    if (clientReq.method === 'GET' || clientReq.method === 'HEAD') {
      upstreamReq.end()
    } else {
      clientReq.pipe(upstreamReq)
    }
  }

  const server = http.createServer((req, res) => {
    // Allow long-lived SSE connections (e.g. /plugins/events) without idle timeout.
    req.setTimeout(0)
    res.setTimeout(0)

    const token = getLaunchToken()

    if (req.url === '/__health') {
      if (token) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end('{"status":"ready"}\n')
      } else {
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end('{"status":"starting"}\n')
      }
      return
    }

    if (!isTrustedSameOriginRequest(req.headers)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('Forbidden\n')
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

    const rootGet = isCleanRootGet(req)
    if (autoAuth && rootGet && !hasAuthCookie(req.headers)) {
      forwardHttp(req, res, `/?token=${encodeURIComponent(token)}`, false)
      return
    }

    forwardHttp(req, res, req.url ?? '/', autoAuth && rootGet)
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

    const args = ['web', '--host', backendHost, '--port', String(backendPort), '--no-open']
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
