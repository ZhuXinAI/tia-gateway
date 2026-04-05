# tia-gateway

Connect IM channels with agent protocols through a unified gateway.

`tia-gateway` is designed as a gateway runtime rather than an ACP-only bridge:

- Channel side: WeChat, Lark, Telegram, and WhatsApp
- Protocol side: pluggable architecture, with ACP implemented first
- Agent side: built-in ACP presets for common coding-agent CLIs plus raw custom commands

The first version is intentionally bootstrap-focused: make it easy to start from `npx`, scan a QR code, connect a real agent, and grow into a broader multi-channel / multi-protocol gateway.

## TL;DR

If you want the shortest path, this is enough:

```bash
npx tia-gateway
```

On first run, `tia-gateway` will onboard interactively and save the config for the current directory under `~/.tia-gateway/directories.json`.

## Features

- WeChat QR login with terminal QR rendering
- Lark connector with websocket receive flow
- Telegram bot connector for DM conversations
- WhatsApp Web connector with terminal QR login and reconnect handling
- HTTP chat channel with AI SDK-compatible SSE responses and resumable streams
- WebSocket chat channel with structured event forwarding
- Protocol abstraction layer so ACP is not hard-wired into the core
- ACP adapter built on [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk)
- One agent session per channel conversation
- Built-in ACP agent presets for common CLIs
- Custom raw ACP agent command support
- Auto-allow ACP permission requests
- Config-driven startup with good first-run defaults

## First-Run Onboarding

If you just run:

```bash
npx tia-gateway
```

and there is no configured channel or no ACP agent selected yet, `tia-gateway` will:

1. Launch interactive onboarding
2. Ask which ACP agent you want to use, or let you enter a custom ACP command
3. Ask which channel you want to configure
4. Walk through credentials or QR login for that channel
5. Save the config for the current directory in `~/.tia-gateway/directories.json`
6. Start the gateway with the newly saved config

If the current directory already has a saved config with channels and an ACP agent selection, `npx tia-gateway` starts the gateway immediately.

## Requirements

- Node.js 22 or newer
- A WeChat environment that can use the iLink bot API
- Lark app credentials if you enable the Lark channel
- A Telegram bot token if you enable the Telegram channel
- A phone that can link WhatsApp Web if you enable the WhatsApp channel
- A free local port if you enable the HTTP or WebSocket channels
- An ACP-compatible agent available locally or through `npx`

## Quick Start

Start with the zero-config bootstrap path:

```bash
npx tia-gateway
```

Run onboarding again later:

```bash
npx tia-gateway onboard
```

Or choose a specific built-in ACP agent:

```bash
npx tia-gateway --agent codex
npx tia-gateway --agent claude
npx tia-gateway --agent gemini
```

Or use a raw ACP command:

```bash
npx tia-gateway --agent "npx my-agent --acp"
```

When you want to explicitly skip onboarding and just start with the saved config:

```bash
npx tia-gateway start
```

## Built-In ACP Agent Presets

List the bundled presets:

```bash
npx tia-gateway agents
```

Current presets:

- `copilot`
- `claude`
- `gemini`
- `qwen`
- `codex`
- `opencode`

These resolve internally to concrete `command + args` pairs. Built-in presets use `npx -y`, so the package is fetched automatically if it is not already installed locally.

## CLI Usage

```text
tia-gateway [options]
tia-gateway start [options]
tia-gateway onboard [options]
tia-gateway agents
tia-gateway --help
```

Start options:

- `--config, -c <file>`: load a specific JSON config file and remember it for this directory
- `--agent <value>`: built-in ACP preset or raw ACP command
- `--cwd <dir>`: working directory for the ACP agent process
- `--show-thoughts`: forward ACP thinking messages back to the channel
- `--show-tools`: forward ACP tool progress messages back to the channel
- `--log-level <level>`: `debug | info | warn | error`
- `--version, -v`: show version
- `--help, -h`: show help

Onboarding options:

- `--config, -c <file>`: write or update a specific config file and remember it for this directory
- `--help, -h`: show help

Examples:

```bash
npx tia-gateway
npx tia-gateway onboard
npx tia-gateway onboard --config ./tia-gateway.config.json
npx tia-gateway start
npx tia-gateway --agent codex
npx tia-gateway --agent "npx @zed-industries/codex-acp"
npx tia-gateway --config ./tia-gateway.config.json
npx tia-gateway --config ./tia-gateway.config.json --agent claude --show-thoughts --show-tools
```

## Configuration File

By default, `tia-gateway` stores config in `~/.tia-gateway/directories.json`, keyed by the directory where you launched it.

If you prefer a standalone JSON config file, you can provide one with `--config`. When you do, `tia-gateway` remembers that file path for the current directory so plain `npx tia-gateway` can find it again later.

Example:

```json
{
  "gateway": {
    "idleTimeoutMs": 86400000,
    "maxConcurrentSessions": 10,
    "logLevel": "info"
  },
  "protocol": {
    "type": "acp",
    "agent": {
      "preset": "codex",
      "cwd": "./workspace",
      "showThoughts": false,
      "showTools": false
    }
  },
  "channels": [
    {
      "type": "wechat",
      "id": "wechat-main",
      "dataDirectoryPath": "~/.tia-gateway/channels/wechat-main"
    },
    {
      "type": "lark",
      "id": "lark-main",
      "appId": "${LARK_APP_ID}",
      "appSecret": "${LARK_APP_SECRET}",
      "groupRequireMention": true
    },
    {
      "type": "telegram",
      "id": "telegram-main",
      "botToken": "${TELEGRAM_BOT_TOKEN}"
    },
    {
      "type": "whatsapp",
      "id": "whatsapp-main",
      "authDirectoryPath": "~/.tia-gateway/channels/whatsapp-main",
      "groupRequireMention": true
    },
    {
      "type": "http",
      "id": "http-main",
      "host": "127.0.0.1",
      "port": 4311,
      "chatPath": "/chat",
      "ssePath": "/sse",
      "serveWebApp": true,
      "autoGenerateToken": true,
      "title": "TIA Gateway"
    },
    {
      "type": "websocket",
      "id": "websocket-main",
      "host": "127.0.0.1",
      "port": 4312,
      "path": "/ws"
    }
  ]
}
```

Notes:

- If `protocol.agent` is omitted, the gateway defaults to the `codex` preset.
- If you start the CLI with no configured channels, onboarding will guide you through creating them and save the result for the current directory.
- Strings support `${ENV_VAR}` expansion.
- Relative paths are resolved from the config file directory, or from the launch directory when using the default `~/.tia-gateway/directories.json` store.

## Channel Onboarding

`npx tia-gateway onboard` lets you revisit channel setup at any time.

When you run the standalone `onboard` command, it saves config and exits. Start the runtime afterward with `npx tia-gateway` to make HTTP or WebSocket endpoints reachable.

- onboarding now asks you which ACP agent to run before the channel-specific steps
- `wechat`: saves the channel config, detects whether a WeChat session already exists, and lets you re-login from the onboarding flow if you want to replace it.
- `whatsapp`: saves the channel config, detects existing WhatsApp auth files, and lets you re-link the device from onboarding.
- `telegram`: asks for the bot token step by step.
- `lark`: asks for the app ID and app secret step by step.
- `http`: asks for host, port, paths, web UI, and token settings step by step.
- `websocket`: asks for host, port, path, and optional token settings step by step.

For QR-based channels, onboarding shows the QR code directly in the terminal and waits for the login to complete before returning.

You can also add or override ACP presets:

```json
{
  "protocol": {
    "type": "acp",
    "agent": {
      "preset": "my-agent"
    },
    "agents": {
      "my-agent": {
        "label": "My Agent",
        "description": "Internal team ACP agent",
        "command": "npx",
        "args": ["my-agent-cli", "--acp"]
      }
    }
  },
  "channels": [
    {
      "type": "wechat"
    }
  ]
}
```

## Channel Support

Today:

- WeChat
- Lark
- Telegram
- WhatsApp
- HTTP
- WebSocket

### WeChat

The WeChat connector:

- logs in through the iLink bot QR flow
- long-polls inbound messages
- keeps WeChat session state on disk
- sends typing indicators when supported
- sends agent replies back into the same conversation context

Current behavior:

- optimized for direct-message style interactions
- text-first today
- non-text inbound items are currently normalized into readable text placeholders rather than rich ACP media blocks

### Lark

The Lark connector:

- receives messages over the Lark websocket SDK
- sends outbound text replies
- requires mention in group chats by default

### Telegram

The Telegram connector:

- uses a standard bot token through `telegraf`
- forwards private text messages into the shared gateway runtime
- keeps Telegram group chats disabled for now, matching the current TIA Studio behavior
- sends assistant replies back into the same DM

### WhatsApp

The WhatsApp connector:

- uses WhatsApp Web through `@whiskeysockets/baileys`
- prints the login QR code in the terminal when a session is not yet linked
- can be re-linked later through `tia-gateway onboard`
- stores auth state on disk under the configured channel directory
- reconnects automatically when the socket drops
- requires mentioning the bot in group chats by default, while still allowing direct chats normally

Current behavior:

- text messages only
- group chats are ignored unless the bot is mentioned

### HTTP

The HTTP connector:

- listens on the configured `host` and `port`
- can optionally serve a built-in browser chat shell at `GET /`
- serves shell assets at `GET /app.js` and `GET /app.css` when `serveWebApp` is enabled
- accepts `POST <chatPath>` requests with either a simple `{ id, message }` body or AI SDK-style `{ id, messages }`
- streams responses back as AI SDK UI-message SSE with `x-vercel-ai-ui-message-stream: v1`
- supports resumable streams at both `<chatPath>/:id/stream` and `<ssePath>/:id`
- uses `resumable-stream` with an in-memory publisher/subscriber bus
- can protect chat, session, and resume routes with an optional static `token`
- can auto-generate and persist an HTTP token under `~/.tia-gateway/channels/<channel-id>/http-token.json`
- includes a web-shell session API at `<chatPath>/sessions`:
  - `GET <chatPath>/sessions`: list sessions shown in the shell sidebar
  - `POST <chatPath>/sessions`: create a new draft shell session
  - `GET <chatPath>/sessions/:chatId`: load shell session detail and stored messages
  - `DELETE <chatPath>/sessions/:chatId`: delete only draft sessions (attached ACP sessions are protected)

This makes it straightforward to point an AI SDK frontend at the gateway by setting the transport `api` to the configured `<chatPath>`.

### WebSocket

The WebSocket connector:

- listens on the configured `host` and `port`
- accepts websocket upgrades on the configured `path`
- binds each socket to a chat via `?chatId=...` or generates one automatically
- forwards inbound `{ "type": "message", "text": "..." }` payloads into the shared gateway runtime
- pushes structured events like `typing`, `text-delta`, `reasoning-delta`, `protocol-event`, and final `message` responses back to connected clients
- can protect connections with an optional static `token`

## Runtime Behavior

- Each channel conversation stays bound to one ACP session unless `/new` is used.
- Session bindings are persisted on disk and restored after gateway restart when the agent supports `session/load`.
- Messages are processed serially per conversation.
- Built-in ACP presets are started through `npx -y`.
- ACP thought chunks can optionally be forwarded back to the user with `--show-thoughts`.
- ACP tool progress can optionally be forwarded back to the user with `--show-tools`.
- ACP permission requests are auto-approved today.
- Idle session cleanup is controlled by `gateway.idleTimeoutMs`.
- HTTP streams can be resumed while a turn is still active via the configured SSE endpoints.
- Attaching an existing ACP session restores server-side session context, but replayed history is intentionally not emitted back into channel/web chat logs.
- Slash commands supported by the gateway:
  - `/new`: clear the chat's current ACP binding and start fresh on next message
  - `/list`: list attachable ACP sessions from the current agent
  - `/attach <sessionId>`: bind this chat to an existing ACP session

## Storage

By default, runtime files live under:

```text
~/.tia-gateway
```

Gateway config is stored in:

```text
~/.tia-gateway/directories.json
```

Each entry is keyed by the directory where you ran `tia-gateway`.

ACP chat-to-session bindings are stored in:

```text
~/.tia-gateway/acp-session-bindings.json
```

HTTP web-shell session records are stored in:

```text
~/.tia-gateway/channels/<channel-id>/http-sessions.json
```

For WeChat channels, the channel state is typically stored under:

```text
~/.tia-gateway/channels/<channel-id>
```

This is used for things like:

- saved WeChat account/session data
- long-poll sync state
- QR login state

## Current Limitations

- Only ACP is implemented on the protocol side right now
- WeChat is the default bootstrap path; Lark requires explicit config
- WeChat support is text-first in this first pass
- Lark support is text-only in this first pass
- ACP communication is subprocess-based over stdio
- MCP server forwarding is not wired in yet
- Some preset agents may still require their own separate authentication before they can answer successfully

## Development

Install dependencies:

```bash
pnpm install
```

Workspace layout:

- `.`: publishable CLI package (`tia-gateway`)
- `apps/web`: bundled browser shell and web-only dependencies

`@tailwindcss/cli` depends on `@parcel/watcher` platform binaries, so do not install with `--no-optional` or `--omit=optional`. If `pnpm` blocks build scripts, run `pnpm approve-builds` and allow `esbuild`/`@parcel/watcher`.

Build:

```bash
pnpm run build
```

Run tests:

```bash
pnpm test
```

Run the built CLI locally:

```bash
node dist/bin/tia-gateway.js --help
```

Dry-run the package contents:

```bash
pnpm pack --dry-run
```

## Attribution

This project is directly inspired by [`formulahendry/wechat-acp`](https://github.com/formulahendry/wechat-acp).

In particular, the first-pass WeChat bootstrap experience, ACP preset idea, and simple operator UX were shaped by that project. `tia-gateway` extends the idea into a more general gateway architecture with:

- multiple chat channels
- a protocol abstraction layer in front of ACP
- room to add non-ACP agent protocols later

## License

MIT
