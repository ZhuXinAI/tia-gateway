# Next Step Plan: Quick Web App + Tokenized HTTP Access

## Goal

When an `http` channel is configured, optionally generate a lightweight web chat UI that is reachable on the same configured port and protected by a generated auth token.

Target outcome:

- Visit `http://<host>:<port>/`
- Enter or automatically use a generated token
- Chat against the gateway over the existing `POST /chat` and resumable SSE routes
- Use `assistant-ui` for the fastest production-looking chat shell

## Scope

### 1. Token generation and persistence

- Add `token` generation for `http` channels when no token is configured.
- Persist the token in config or a local runtime file under `~/.tia-gateway/channels/<channel-id>/http-token.json`.
- Print the access URL and token once on startup.
- Accept the token through:
  - `Authorization: Bearer <token>`
  - `?token=<token>` for simple browser access flows

### 2. Serve a built-in web app from the HTTP channel

- Extend the HTTP channel server to serve:
  - `GET /` -> the chat page
  - `GET /app.js` -> client bundle
  - `GET /app.css` -> minimal styling
- Keep `/chat`, `/chat/:id/stream`, and `/sse/:id` as the API transport routes.
- Prefer the same port so operators only expose one endpoint.

### 3. Bootstrap with assistant-ui

- Use `assistant-ui` for the chat layout and message list.
- Use the AI SDK client transport pointed at the gateway HTTP channel:
  - `api: '/chat'`
  - `resume: true`
- Inject the token into fetch headers or append it to resume URLs.
- Start with a text-first UI, then optionally surface:
  - reasoning
  - `data-acp-event` tool activity
  - reconnect state

### 4. Minimal asset pipeline

- Avoid introducing a heavy framework build into the gateway package first.
- Start with one of:
  - prebuilt static assets committed under `src/web/`
  - a tiny Vite build step that outputs static files into `dist/web/`
- Keep the first version dependency-light and easy to ship via `npx`.

### 5. Config and UX

- Extend `http` channel config with optional flags such as:
  - `serveWebApp`
  - `autoGenerateToken`
  - `title`
- If `serveWebApp` is enabled, log a startup line like:
  - `Web UI: http://127.0.0.1:4311/`
- If `autoGenerateToken` is enabled, print the token only when created, not on every restart.

## Recommended implementation order

1. Add token generation and persistence for the HTTP channel.
2. Serve a tiny static HTML page from `/` on the existing HTTP server.
3. Replace the static page with an `assistant-ui` shell using AI SDK transport.
4. Surface `reasoning-delta` and `data-acp-event` in the UI.
5. Add onboarding and config example updates for the web mode.

## Risks and notes

- `useChat` resumability and manual abort are incompatible, so the quick web app should prefer resume support over stop support.
- If the UI is served cross-origin later, token and CORS handling should be revisited together.
- The current HTTP channel is already AI SDK-compatible on the streaming side, so this next step is mostly auth + static UI packaging rather than another protocol redesign.
