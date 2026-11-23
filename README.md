# DeepSeek Harness for Umbrel

Multi-architecture (`linux/amd64` + `linux/arm64`) Docker packaging and Umbrel App Store package for [DeepSeek Harness (`@deepseek-ai/dsh`)](https://github.com/deepseek-ai/deepseek-harness).

## Features

- **Zero-prerequisite install**: bundles the official `@deepseek-ai/dsh` npm package in a non-root (`1000:1000`) Debian Bookworm + Node 24 container.
- **Seamless Umbrel `app_proxy` integration**: `docker/entrypoint.mjs` supervises `dsh web` on loopback (`127.0.0.1:3081`), preserves same-origin CSRF checks, proxies HTTP/SSE/WebSocket traffic, and transparently exchanges the per-launch token on unauthenticated `GET /` requests when running behind Umbrel's `app_proxy` authentication.
- **Browser-first onboarding**: configure your DeepSeek API key or any third-party/custom provider (OpenAI, Anthropic, Gemini, Ollama, OpenRouter) directly in the browser on first launch.
- **Full data persistence**: credentials, sessions, plugins, and workspaces persist under `${APP_DATA_DIR}/data/{dsh-home,workspace,home}`.

## Install via Community App Store

1. Open **App Store** on your Umbrel.
2. Click the menu icon (`...`) → **Community App Stores**.
3. Paste `https://github.com/nilsonpmjr/deepseek-harness-umbrel` and click **Add**.
4. Install **DeepSeek Harness**.

## Build & Test Locally

```sh
node --test docker/entrypoint.test.mjs
```
