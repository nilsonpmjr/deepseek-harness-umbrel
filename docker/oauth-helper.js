(() => {
  'use strict'

  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
  if (LOOPBACK_HOSTS.has(window.location.hostname.toLowerCase())) {
    return
  }

  const COPY = {
    pt: {
      title: 'Concluir login da conta DeepSeek no Umbrel',
      desc: 'O login do DeepSeek redireciona apenas para 127.0.0.1. Após autorizar na aba do DeepSeek, copie a URL da barra de endereço (http://127.0.0.1:3081/oauth/callback?...) e cole abaixo:',
      placeholder: 'Cole a URL de retorno (http://127.0.0.1:3081/oauth/callback?code=...)',
      submit: 'Concluir login',
      submitting: 'Concluindo...',
      success: 'Conta DeepSeek conectada!',
      closeLabel: 'Fechar aviso',
      errMissingParams: 'Cole a URL completa que contém ?code=...&state=...',
      errInvalidCallback: 'Este link não corresponde à tentativa atual. Clique em Tentar novamente e cole o novo link.',
      errExpired: 'A tentativa de login expirou ou já foi finalizada. Clique em Tentar novamente.',
      errExchangeFailed: 'O DeepSeek recusou a troca do código. Tente fazer login novamente.',
      errNetwork: 'Não foi possível comunicar com o DeepSeek Harness. Tente novamente.',
    },
    zh: {
      title: '在 Umbrel 上完成 DeepSeek 账号登录',
      desc: 'DeepSeek 登录仅允许回调到 127.0.0.1。在打开的 DeepSeek 页面授权后，复制地址栏中的完整 URL（http://127.0.0.1:3081/oauth/callback?...）并粘贴到下方：',
      placeholder: '粘贴回调 URL (http://127.0.0.1:3081/oauth/callback?code=...)',
      submit: '完成登录',
      submitting: '正在验证...',
      success: 'DeepSeek 账号已连接！',
      closeLabel: '关闭提示',
      errMissingParams: '请粘贴包含 ?code=...&state=... 的完整回调 URL。',
      errInvalidCallback: '该回调链接与当前登录会话不匹配，请重新发起登录。',
      errExpired: '当前登录会话已过期或已结束，请重新点击登录。',
      errExchangeFailed: 'DeepSeek 拒绝了授权码兑换，请重新登录。',
      errNetwork: '无法连接到 DeepSeek Harness，请重试。',
    },
    en: {
      title: 'Finish DeepSeek Account sign-in on Umbrel',
      desc: 'DeepSeek only redirects to 127.0.0.1. After approving in the DeepSeek tab, copy the address bar URL (http://127.0.0.1:3081/oauth/callback?...) and paste it below:',
      placeholder: 'Paste callback URL (http://127.0.0.1:3081/oauth/callback?code=...)',
      submit: 'Complete sign-in',
      submitting: 'Completing...',
      success: 'DeepSeek Account connected!',
      closeLabel: 'Dismiss helper',
      errMissingParams: 'Paste the full callback URL containing ?code=...&state=...',
      errInvalidCallback: 'That callback link does not match the active sign-in attempt. Start sign-in again and paste the new link.',
      errExpired: 'This sign-in attempt expired or already finished. Click Retry to start a new one.',
      errExchangeFailed: 'DeepSeek rejected the authorization code exchange. Please try signing in again.',
      errNetwork: 'Could not reach DeepSeek Harness. Please try again.',
    },
  }

  function pickCopy() {
    const raw = (document.documentElement.lang || navigator.language || 'en').toLowerCase()
    if (raw.startsWith('pt')) return COPY.pt
    if (raw.startsWith('zh')) return COPY.zh
    return COPY.en
  }

  function looksLikeCallback(value) {
    const trimmed = String(value || '').trim()
    return trimmed.includes('code=') && trimmed.includes('state=')
  }

  let hostEl = null
  let shadow = null
  let inputEl = null
  let submitBtn = null
  let statusEl = null
  let submitting = false
  let hideTimer = null

  function ensureMounted() {
    if (hostEl && hostEl.isConnected) return
    const copy = pickCopy()

    hostEl = document.createElement('div')
    hostEl.id = 'dsh-umbrel-oauth-helper'
    hostEl.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:20px',
      'transform:translateX(-50%)',
      'z-index:2147483000',
      'width:min(540px, calc(100vw - 24px))',
      'pointer-events:auto',
    ].join(';')

    // Prevent DeepSeek Harness modal focus/Escape listeners from intercepting typing/paste.
    hostEl.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.stopPropagation()
      }
    })

    shadow = hostEl.attachShadow({ mode: 'open' })
    shadow.innerHTML = `
      <style>
        :host {
          color-scheme: light dark;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        .card {
          background: #161b26;
          color: #e5e7eb;
          border: 1px solid rgba(77, 107, 254, 0.45);
          border-radius: 14px;
          padding: 14px 16px;
          box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42);
        }
        @media (prefers-color-scheme: light) {
          .card {
            background: #ffffff;
            color: #111827;
            border-color: rgba(77, 107, 254, 0.35);
            box-shadow: 0 14px 36px rgba(15, 23, 42, 0.18);
          }
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 6px;
        }
        .title {
          font-size: 13.5px;
          font-weight: 600;
          margin: 0;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: #4d6bfe;
          flex: none;
        }
        .close {
          background: transparent;
          border: none;
          color: inherit;
          opacity: 0.65;
          cursor: pointer;
          font-size: 18px;
          line-height: 1;
          padding: 2px 6px;
          border-radius: 6px;
        }
        .close:hover { opacity: 1; background: rgba(148, 163, 184, 0.16); }
        .desc {
          margin: 0 0 10px;
          font-size: 12.5px;
          line-height: 1.45;
          opacity: 0.84;
        }
        .row {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        input {
          flex: 1;
          min-width: 0;
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.38);
          background: rgba(15, 23, 42, 0.35);
          color: inherit;
          font-size: 12.5px;
          outline: none;
        }
        @media (prefers-color-scheme: light) {
          input { background: #f8fafc; }
        }
        input:focus {
          border-color: #4d6bfe;
          box-shadow: 0 0 0 2px rgba(77, 107, 254, 0.25);
        }
        button.submit {
          flex: none;
          padding: 8px 14px;
          border-radius: 8px;
          border: none;
          background: #4d6bfe;
          color: #ffffff;
          font-size: 12.5px;
          font-weight: 600;
          cursor: pointer;
        }
        button.submit:hover:not(:disabled) { background: #3b57e8; }
        button.submit:disabled { opacity: 0.6; cursor: default; }
        .status {
          margin-top: 8px;
          font-size: 12px;
          line-height: 1.35;
          min-height: 0;
        }
        .status:empty { display: none; }
        .status.error { color: #f87171; }
        .status.success { color: #34d399; font-weight: 600; }
        @media (prefers-color-scheme: light) {
          .status.error { color: #dc2626; }
          .status.success { color: #059669; }
        }
      </style>
      <div class="card" role="region">
        <div class="header">
          <h3 class="title"><span class="dot" aria-hidden="true"></span><span class="title-text"></span></h3>
          <button type="button" class="close">&times;</button>
        </div>
        <p class="desc"></p>
        <form class="row">
          <input type="text" autocomplete="off" spellcheck="false" />
          <button type="submit" class="submit"></button>
        </form>
        <div class="status" role="status" aria-live="polite"></div>
      </div>
    `

    shadow.querySelector('.title-text').textContent = copy.title
    shadow.querySelector('.desc').textContent = copy.desc
    const closeBtn = shadow.querySelector('.close')
    closeBtn.setAttribute('aria-label', copy.closeLabel)
    closeBtn.addEventListener('click', hideHelper)

    inputEl = shadow.querySelector('input')
    inputEl.placeholder = copy.placeholder
    submitBtn = shadow.querySelector('button.submit')
    submitBtn.textContent = copy.submit
    statusEl = shadow.querySelector('.status')

    const form = shadow.querySelector('form')
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void submitCallback(inputEl.value)
    })

    // Auto-submit immediately when the user pastes a full callback URL with code & state.
    inputEl.addEventListener('paste', (event) => {
      const pasted = event.clipboardData?.getData('text') ?? ''
      if (looksLikeCallback(pasted)) {
        setTimeout(() => {
          void submitCallback(inputEl.value || pasted)
        }, 0)
      }
    })

    document.body.appendChild(hostEl)
  }

  function showHelper() {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    ensureMounted()
    if (statusEl) {
      statusEl.textContent = ''
      statusEl.className = 'status'
    }
    if (inputEl) {
      inputEl.value = ''
      inputEl.disabled = false
    }
    if (submitBtn) {
      submitBtn.disabled = false
      submitBtn.textContent = pickCopy().submit
    }
    hostEl.style.display = 'block'
  }

  function hideHelper() {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    if (hostEl) {
      hostEl.remove()
      hostEl = null
      shadow = null
      inputEl = null
      submitBtn = null
      statusEl = null
    }
  }

  function setStatus(kind, message) {
    if (!statusEl) return
    statusEl.className = `status ${kind}`
    statusEl.textContent = message
  }

  const nativeFetch = window.fetch.bind(window)

  async function submitCallback(rawValue) {
    if (submitting) return
    const copy = pickCopy()
    const callbackUrl = String(rawValue || '').trim()
    if (!looksLikeCallback(callbackUrl)) {
      setStatus('error', copy.errMissingParams)
      return
    }
    submitting = true
    if (submitBtn) {
      submitBtn.disabled = true
      submitBtn.textContent = copy.submitting
    }
    if (inputEl) inputEl.disabled = true
    setStatus('', '')

    try {
      const response = await nativeFetch('/__umbrel/oauth-complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callbackUrl }),
      })
      const payload = await response.json().catch(() => null)
      if (response.ok && payload?.ok) {
        setStatus('success', copy.success)
        hideTimer = setTimeout(hideHelper, 1800)
        return
      }
      const code = payload?.error
      if (code === 'invalid_callback') setStatus('error', copy.errInvalidCallback)
      else if (code === 'expired') setStatus('error', copy.errExpired)
      else if (code === 'exchange_failed') setStatus('error', copy.errExchangeFailed)
      else if (code === 'missing_params') setStatus('error', copy.errMissingParams)
      else setStatus('error', copy.errNetwork)
    } catch {
      setStatus('error', copy.errNetwork)
    } finally {
      submitting = false
      if (submitBtn) {
        submitBtn.disabled = false
        submitBtn.textContent = copy.submit
      }
      if (inputEl) {
        inputEl.disabled = false
        inputEl.focus()
      }
    }
  }

  // Observe DeepSeek Account sign-in start/cancel RPC calls without modifying app code.
  window.fetch = async function patchedFetch(input, init) {
    let pathname = ''
    try {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
      if (rawUrl) pathname = new URL(rawUrl, document.baseURI).pathname
    } catch {
      pathname = ''
    }

    const response = await nativeFetch(input, init)

    if (pathname === '/api/account/startSignIn' && response.ok) {
      response.clone().json().then((body) => {
        if (body?.result?.ok === true) {
          showHelper()
        }
      }).catch(() => {})
    } else if (pathname === '/api/account/cancelSignIn' || pathname === '/api/account/signOut') {
      hideHelper()
    }

    return response
  }

  // When returning from the DeepSeek authorization tab, focus the input so Ctrl+V works right away.
  window.addEventListener('focus', () => {
    if (hostEl && hostEl.isConnected && inputEl && !inputEl.disabled) {
      inputEl.focus()
    }
  })

  // Restore helper if the page reloads while a remote sign-in attempt is still active.
  nativeFetch('/__umbrel/oauth-status')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data?.pending) showHelper()
    })
    .catch(() => {})
})()
