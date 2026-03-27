# tia-gateway

Bridge chat channels to agent protocols, starting with WeChat and Lark on the channel side, and ACP on the protocol side.

`tia-gateway` is designed as a gateway runtime rather than an ACP-only bridge:

- Channel side: WeChat and Lark
- Protocol side: pluggable architecture, with ACP implemented first
- Agent side: built-in ACP presets for common coding-agent CLIs plus raw custom commands

Near-term roadmap:

- WhatsApp support is planned very soon
- Telegram support is planned very soon

The first version is intentionally bootstrap-focused: make it easy to start from `npx`, scan a QR code, connect a real agent, and grow into a broader multi-channel / multi-protocol gateway.

## Features

- WeChat QR login with terminal QR rendering
- Lark connector with websocket receive flow
- Clear path to upcoming WhatsApp and Telegram channel connectors
- Protocol abstraction layer so ACP is not hard-wired into the core
- ACP adapter built on [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk)
- One agent session per channel conversation
- Built-in ACP agent presets for common CLIs
- Custom raw ACP agent command support
- Auto-allow ACP permission requests
- Config-driven startup with good first-run defaults

## First-Run Defaults

If you just run:

```bash
npx tia-gateway
```

`tia-gateway` will:

1. Default the protocol to `acp`
2. Default the agent preset to `codex`
3. Default the channel list to one `wechat` channel
4. Fetch the ACP agent package through `npx -y` if needed
5. Print the WeChat QR code in the terminal

That means first-run setup does not require a config file just to get started.

## Requirements

- Node.js 20+
- A WeChat environment that can use the iLink bot API
- Lark app credentials if you enable the Lark channel
- An ACP-compatible agent available locally or through `npx`

## Quick Start

Start with the zero-config bootstrap path:

```bash
npx tia-gateway
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

On first run with the default WeChat path, the gateway will:

1. Start WeChat QR login
2. Render a QR code in the terminal
3. Save the WeChat session under `~/.tia-gateway/channels/<channel-id>`
4. Start polling WeChat messages
5. Forward each conversation to a dedicated ACP agent session

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
tia-gateway start [options]
tia-gateway agents
tia-gateway --help
```

Options:

- `--config, -c <file>`: load JSON config file
- `--agent <value>`: built-in ACP preset or raw ACP command
- `--cwd <dir>`: working directory for the ACP agent process
- `--show-thoughts`: forward ACP thinking messages back to the channel
- `--login`: force WeChat re-login and replace the saved WeChat session
- `--log-level <level>`: `debug | info | warn | error`
- `--version, -v`: show version
- `--help, -h`: show help

Examples:

```bash
npx tia-gateway
npx tia-gateway --agent codex
npx tia-gateway --agent "npx @zed-industries/codex-acp"
npx tia-gateway --config ./tia-gateway.config.json
npx tia-gateway --config ./tia-gateway.config.json --agent claude --show-thoughts
```

## Configuration File

You can provide a JSON config file with `--config`.

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
      "showThoughts": false
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
    }
  ]
}
```

Notes:

- If `protocol.agent` is omitted, the gateway defaults to the `codex` preset.
- If `channels` is omitted or empty, the gateway defaults to one `wechat` channel.
- Strings support `${ENV_VAR}` expansion.
- Relative paths are resolved from the config file directory.

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

Coming very soon:

- WhatsApp
- Telegram

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

Current behavior:

- text messages only
- group chats are ignored unless the bot is mentioned

## Runtime Behavior

- Each channel conversation gets a dedicated ACP session and subprocess.
- Messages are processed serially per conversation.
- Built-in ACP presets are started through `npx -y`.
- ACP thought chunks can optionally be forwarded back to the user with `--show-thoughts`.
- ACP permission requests are auto-approved today.
- Idle session cleanup is controlled by `gateway.idleTimeoutMs`.

## Storage

By default, runtime files live under:

```text
~/.tia-gateway
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
npm install
```

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Run the built CLI locally:

```bash
node dist/bin/tia-gateway.js --help
```

Dry-run the package contents:

```bash
npm pack --dry-run
```

## Trusted Publisher Release

`tia-gateway` is set up for GitHub Actions + npm trusted publishing, without `NPM_TOKEN`.

Before the first publish:

1. Create and push the GitHub repository
2. Update `package.json` so `repository.url` exactly matches the GitHub repo you will publish from
3. On npm, open the package settings for `tia-gateway` and add a Trusted Publisher for:
   - your GitHub user or org
   - your repository name
   - workflow filename: `publish.yml`
4. Use a GitHub-hosted runner only

To publish the first version after trusted publishing is configured:

```bash
git tag v0.1.0
git push origin v0.1.0
```

That tag triggers `.github/workflows/publish.yml`, which will run CI checks and publish the package to npm using OIDC.

Notes:

- npm’s current trusted-publisher docs say the workflow filename must match exactly, including `.yml`
- npm also requires `package.json` `repository.url` to exactly match the GitHub repository used for publication
- with trusted publishing, npm automatically generates provenance for public packages from public repos, so no `NPM_TOKEN` is needed

Source references:

- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance statements](https://docs.npmjs.com/generating-provenance-statements/)
- [GitHub publishing Node.js packages](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages)

## Attribution

This project is directly inspired by [`formulahendry/wechat-acp`](https://github.com/formulahendry/wechat-acp).

In particular, the first-pass WeChat bootstrap experience, ACP preset idea, and simple operator UX were shaped by that project. `tia-gateway` extends the idea into a more general gateway architecture with:

- multiple chat channels
- a protocol abstraction layer in front of ACP
- room to add non-ACP agent protocols later

## License

MIT
