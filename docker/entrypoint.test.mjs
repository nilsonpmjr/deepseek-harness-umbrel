import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { describe, it } from 'node:test'
import { createProxyServer, isTrustedSameOriginRequest } from './entrypoint.mjs'

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(addr.port)
    })
  })
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        agent: false,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

describe('isTrustedSameOriginRequest', () => {
  it('allows requests without Origin and non-cross-site Sec-Fetch-Site', () => {
    assert.equal(isTrustedSameOriginRequest({ host: 'umbrel.local:3080' }), true)
    assert.equal(
      isTrustedSameOriginRequest({ host: 'umbrel.local:3080', 'sec-fetch-site': 'same-origin' }),
      true,
    )
  })

  it('allows matching Origin and Host across HTTP, HTTPS, LAN IP, and Tailscale', () => {
    assert.equal(
      isTrustedSameOriginRequest({ host: 'umbrel.local:3080', origin: 'https://umbrel.local:3080' }),
      true,
    )
    assert.equal(
      isTrustedSameOriginRequest({ host: '192.168.15.14:3080', origin: 'http://192.168.15.14:3080' }),
      true,
    )
    assert.equal(
      isTrustedSameOriginRequest({ host: 'example.com:443', origin: 'https://example.com' }),
      true,
    )
  })

  it('rejects cross-site Sec-Fetch-Site and mismatched or null Origin', () => {
    assert.equal(
      isTrustedSameOriginRequest({ host: 'umbrel.local:3080', 'sec-fetch-site': 'cross-site' }),
      false,
    )
    assert.equal(
      isTrustedSameOriginRequest({ host: 'umbrel.local:3080', origin: 'https://evil.example' }),
      false,
    )
    assert.equal(
      isTrustedSameOriginRequest({ host: 'umbrel.local:3080', origin: 'null' }),
      false,
    )
  })
})

describe('createProxyServer', () => {
  it('serves health=503 and loading splash before backend is ready, then auto-authenticates GET /', async () => {
    const validToken = 'test-launch-token-123'
    const validCookie = 'dsh-auth-mock=valid-session'
    let capturedHeaders = null

    const backend = http.createServer((req, res) => {
      capturedHeaders = req.headers
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/' && url.searchParams.get('token') === validToken) {
        res.writeHead(303, {
          location: './',
          'set-cookie': `${validCookie}; Path=/; HttpOnly; SameSite=Strict`,
        })
        res.end()
        return
      }
      if (req.headers.cookie?.includes(validCookie)) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html>DeepSeek Harness Ready</html>')
        return
      }
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('Unauthorized')
    })

    backend.on('upgrade', (req, socket) => {
      const okHost = req.headers.host === `127.0.0.1:${backendPort}`
      const okOrigin = req.headers.origin === `http://127.0.0.1:${backendPort}`
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Host-Ok: ${okHost}\r\nX-Origin-Ok: ${okOrigin}\r\n\r\n`,
      )
      socket.on('data', (chunk) => socket.write(chunk))
      socket.on('end', () => socket.end())
    })

    const backendPort = await listen(backend)
    let token = null
    const proxy = createProxyServer({
      backendHost: '127.0.0.1',
      backendPort,
      autoAuth: true,
      getLaunchToken: () => token,
    })
    const proxyPort = await listen(proxy)

    try {
      // 1. Before token is ready
      const healthBefore = await request(proxyPort, '/__health')
      assert.equal(healthBefore.statusCode, 503)

      const splash = await request(proxyPort, '/', { headers: { host: 'umbrel.local:3080' } })
      assert.equal(splash.statusCode, 200)
      assert.match(splash.body, /Starting DeepSeek Harness/)

      // 2. Backend becomes ready
      token = validToken
      const healthAfter = await request(proxyPort, '/__health')
      assert.equal(healthAfter.statusCode, 200)

      // 3. Unauthenticated GET / gets auto-exchanged for session cookie
      const firstOpen = await request(proxyPort, '/', {
        headers: { host: 'umbrel.local:3080' },
      })
      assert.equal(firstOpen.statusCode, 303)
      assert.equal(firstOpen.headers.location, './')
      assert.match(String(firstOpen.headers['set-cookie']), /dsh-auth-mock=valid-session/)
      assert.equal(capturedHeaders.host, `127.0.0.1:${backendPort}`)

      // 4. Stale/invalid cookie on GET / auto-heals via token exchange
      const staleOpen = await request(proxyPort, '/', {
        headers: { host: 'umbrel.local:3080', cookie: 'dsh-auth-old=expired' },
      })
      assert.equal(staleOpen.statusCode, 303)
      assert.match(String(staleOpen.headers['set-cookie']), /dsh-auth-mock=valid-session/)

      // 5. Valid cookie serves app HTML directly
      const authedOpen = await request(proxyPort, '/', {
        headers: {
          host: 'umbrel.local:3080',
          origin: 'https://umbrel.local:3080',
          cookie: validCookie,
        },
      })
      assert.equal(authedOpen.statusCode, 200)
      assert.match(authedOpen.body, /DeepSeek Harness Ready/)
      assert.equal(capturedHeaders.origin, `http://127.0.0.1:${backendPort}`)

      // 6. Cross-origin request is rejected with 403
      const csrf = await request(proxyPort, '/api/test', {
        headers: { host: 'umbrel.local:3080', origin: 'https://attacker.invalid' },
      })
      assert.equal(csrf.statusCode, 403)

      // 7. WebSocket upgrade tunnels cleanly and rewrites Host/Origin
      const wsResult = await new Promise((resolve, reject) => {
        const client = net.connect(proxyPort, '127.0.0.1', () => {
          client.write(
            'GET /api/remote.mux HTTP/1.1\r\n'
              + 'Host: umbrel.local:3080\r\n'
              + 'Origin: https://umbrel.local:3080\r\n'
              + `Cookie: ${validCookie}\r\n`
              + 'Upgrade: websocket\r\n'
              + 'Connection: Upgrade\r\n\r\n',
          )
        })
        let response = ''
        client.on('data', (chunk) => {
          response += chunk.toString('utf8')
          if (response.includes('\r\n\r\n') && !response.includes('ping-ok')) {
            client.write('ping-ok')
          } else if (response.includes('ping-ok')) {
            client.destroy()
            resolve(response)
          }
        })
        client.on('error', reject)
      })
      assert.match(wsResult, /101 Switching Protocols/)
      assert.match(wsResult, /X-Host-Ok: true/)
      assert.match(wsResult, /X-Origin-Ok: true/)
      assert.match(wsResult, /ping-ok/)
    } finally {
      await close(proxy)
      await close(backend)
    }
  })
})
