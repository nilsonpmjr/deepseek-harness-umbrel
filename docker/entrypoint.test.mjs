import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { describe, it } from 'node:test'
import {
  createProxyServer,
  injectOAuthHelperScript,
  isLoopbackOrigin,
  isTrustedSameOriginRequest,
  parseOAuthCallbackInput,
  rewriteStartSignInBody,
} from './entrypoint.mjs'

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

describe('remote OAuth helpers', () => {
  it('distinguishes loopback origins from remote Umbrel origins', () => {
    assert.equal(isLoopbackOrigin('http://127.0.0.1:3081'), true)
    assert.equal(isLoopbackOrigin('http://localhost:3083'), true)
    assert.equal(isLoopbackOrigin('http://[::1]:3083'), true)
    assert.equal(isLoopbackOrigin('http://umbrel.local:3083'), false)
    assert.equal(isLoopbackOrigin('https://umbrel.local:3083'), false)
    assert.equal(isLoopbackOrigin('http://192.168.15.14:3083'), false)
    assert.equal(isLoopbackOrigin('https://my-umbrel.tail12345.ts.net'), false)
  })

  it('rewrites non-loopback callbackOrigin in startSignIn payloads and leaves loopback untouched', () => {
    const remotePayload = Buffer.from(JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'account/startSignIn',
      payload: {
        args: {
          client: { version: '0.2.2-rc.5', locale: 'pt-BR', timezoneOffsetSeconds: -10800 },
          callbackOrigin: 'http://umbrel.local:3083',
          loginSource: 'web',
        },
      },
    }))
    const rewritten = rewriteStartSignInBody(remotePayload, 'http://127.0.0.1:3081')
    assert.equal(rewritten.rewritten, true)
    assert.equal(JSON.parse(rewritten.body.toString('utf8')).payload.args.callbackOrigin, 'http://127.0.0.1:3081')

    const localPayload = Buffer.from(JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc-2',
      method: 'account/startSignIn',
      payload: { args: { callbackOrigin: 'http://localhost:3083', loginSource: 'web' } },
    }))
    const unchanged = rewriteStartSignInBody(localPayload, 'http://127.0.0.1:3081')
    assert.equal(unchanged.rewritten, false)
    assert.equal(unchanged.body, localPayload)
  })

  it('parses full URLs, path+query, and raw query OAuth callbacks while rejecting invalid inputs', () => {
    const full = parseOAuthCallbackInput('http://127.0.0.1:3081/oauth/callback?code=abc_123&state=xyz_456')
    assert.deepEqual(full, {
      ok: true,
      code: 'abc_123',
      state: 'xyz_456',
      path: '/oauth/callback?code=abc_123&state=xyz_456',
    })

    const queryOnly = parseOAuthCallbackInput('?code=a+b&state=s%3D1')
    assert.equal(queryOnly.ok, true)
    assert.equal(queryOnly.code, 'a b')
    assert.equal(queryOnly.state, 's=1')

    assert.equal(parseOAuthCallbackInput('http://127.0.0.1:3081/other?code=a&state=b').ok, false)
    assert.equal(parseOAuthCallbackInput('http://127.0.0.1:3081/oauth/callback?code=a').ok, false)
    assert.equal(parseOAuthCallbackInput('http://127.0.0.1:3081/oauth/callback?code=a&state=b\r\nX: y').ok, false)
  })

  it('injects the helper script once before </body>', () => {
    const html = '<html><body><div id="root"></div></body></html>'
    const once = injectOAuthHelperScript(html)
    assert.match(once, /<script src="\/__umbrel\/oauth-helper\.js" defer><\/script><\/body>/)
    assert.equal(injectOAuthHelperScript(once), once)
  })
})

describe('createProxyServer', () => {
  it('serves health=503 and loading splash before backend is ready, then auto-authenticates GET / and relays OAuth', async () => {
    const validToken = 'test-launch-token-123'
    const validCookie = 'dsh-auth-mock=valid-session'
    let capturedHeaders = null
    let lastStartSignInArgs = null
    let activeOAuthState = null

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

      if (req.method === 'POST' && url.pathname === '/api/account/startSignIn') {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          lastStartSignInArgs = body.payload.args
          activeOAuthState = 'valid-state-999'
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            type: 'server-response',
            rpcId: body.rpcId,
            result: { ok: true, value: { status: 'signed-out', attempt: { id: 'a1', phase: 'initializing' } } },
          }))
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/account/cancelSignIn') {
        activeOAuthState = null
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (req.method === 'GET' && url.pathname === '/oauth/callback') {
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        if (!activeOAuthState) {
          res.writeHead(410)
          res.end()
          return
        }
        if (state !== activeOAuthState || !code) {
          res.writeHead(400)
          res.end()
          return
        }
        activeOAuthState = null
        res.writeHead(302, { location: 'https://platform.deepseek.com/dsh/authorized?login_source=web' })
        res.end()
        return
      }

      if (req.headers.cookie?.includes(validCookie)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><body>DeepSeek Harness Ready</body></html>')
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

      // 5. Valid cookie serves app HTML with injected Umbrel OAuth helper script
      const authedOpen = await request(proxyPort, '/', {
        headers: {
          host: 'umbrel.local:3080',
          origin: 'https://umbrel.local:3080',
          cookie: validCookie,
          'accept-encoding': 'gzip, deflate',
        },
      })
      assert.equal(authedOpen.statusCode, 200)
      assert.match(authedOpen.body, /DeepSeek Harness Ready/)
      assert.match(authedOpen.body, /\/__umbrel\/oauth-helper\.js/)
      assert.equal(capturedHeaders.origin, `http://127.0.0.1:${backendPort}`)
      assert.equal(capturedHeaders['accept-encoding'], 'identity')

      // 6. Helper script is served cleanly
      const helperScript = await request(proxyPort, '/__umbrel/oauth-helper.js', {
        headers: { host: 'umbrel.local:3080', 'sec-fetch-site': 'same-origin' },
      })
      assert.equal(helperScript.statusCode, 200)
      assert.match(String(helperScript.headers['content-type']), /javascript/)
      assert.match(helperScript.body, /__umbrel\/oauth-complete/)

      // 7. Remote startSignIn rewrites callbackOrigin to loopback and marks pending status
      const startRes = await request(proxyPort, '/api/account/startSignIn', {
        method: 'POST',
        headers: {
          host: 'umbrel.local:3083',
          origin: 'http://umbrel.local:3083',
          'content-type': 'application/json',
          cookie: validCookie,
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-oauth-1',
          method: 'account/startSignIn',
          payload: {
            args: {
              client: { version: '0.2.2-rc.5', locale: 'pt-BR', timezoneOffsetSeconds: -10800 },
              callbackOrigin: 'http://umbrel.local:3083',
              loginSource: 'web',
            },
          },
        }),
      })
      assert.equal(startRes.statusCode, 200)
      assert.equal(lastStartSignInArgs.callbackOrigin, `http://127.0.0.1:${backendPort}`)

      const statusPending = await request(proxyPort, '/__umbrel/oauth-status', {
        headers: { host: 'umbrel.local:3083', 'sec-fetch-site': 'same-origin' },
      })
      assert.equal(statusPending.statusCode, 200)
      assert.equal(JSON.parse(statusPending.body).pending, true)

      // 8. Mismatched state returns 400 invalid_callback; valid callback returns 200 and clears pending
      const badComplete = await request(proxyPort, '/__umbrel/oauth-complete', {
        method: 'POST',
        headers: {
          host: 'umbrel.local:3083',
          origin: 'http://umbrel.local:3083',
          'content-type': 'application/json',
          cookie: validCookie,
        },
        body: JSON.stringify({
          callbackUrl: `http://127.0.0.1:${backendPort}/oauth/callback?code=c1&state=wrong`,
        }),
      })
      assert.equal(badComplete.statusCode, 400)
      assert.equal(JSON.parse(badComplete.body).error, 'invalid_callback')

      const okComplete = await request(proxyPort, '/__umbrel/oauth-complete', {
        method: 'POST',
        headers: {
          host: 'umbrel.local:3083',
          origin: 'http://umbrel.local:3083',
          'content-type': 'application/json',
          cookie: validCookie,
        },
        body: JSON.stringify({
          callbackUrl: `http://127.0.0.1:${backendPort}/oauth/callback?code=c1&state=valid-state-999`,
        }),
      })
      assert.equal(okComplete.statusCode, 200)
      assert.equal(JSON.parse(okComplete.body).ok, true)

      const statusDone = await request(proxyPort, '/__umbrel/oauth-status', {
        headers: { host: 'umbrel.local:3083', 'sec-fetch-site': 'same-origin' },
      })
      assert.equal(JSON.parse(statusDone.body).pending, false)

      // 9. Cross-origin /api and /__umbrel requests are rejected with 403, while top-level GET / succeeds
      const csrfApi = await request(proxyPort, '/api/test', {
        headers: { host: 'umbrel.local:3080', origin: 'https://attacker.invalid' },
      })
      assert.equal(csrfApi.statusCode, 403)

      const csrfComplete = await request(proxyPort, '/__umbrel/oauth-complete', {
        method: 'POST',
        headers: { host: 'umbrel.local:3080', origin: 'https://attacker.invalid' },
        body: '{}',
      })
      assert.equal(csrfComplete.statusCode, 403)

      const topLevelNav = await request(proxyPort, '/', {
        headers: { host: 'umbrel.local:3080', 'sec-fetch-site': 'cross-site' },
      })
      assert.equal(topLevelNav.statusCode, 303)

      // 10. WebSocket upgrade tunnels cleanly and rewrites Host/Origin
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
