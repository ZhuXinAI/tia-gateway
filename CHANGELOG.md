# Changelog

## 0.4.0

- Add ACP agent selection to interactive onboarding, including built-in presets and custom ACP commands.
- Align the package version metadata with the published release tag.

## 0.3.0

- Store default gateway config centrally in `~/.tia-gateway/directories.json`, keyed by the launch directory, instead of auto-creating `tia-gateway.config.json` in each repo.
- Keep `--config` file support while remembering the chosen config path per directory for future `npx tia-gateway` runs.
- Add a TL;DR to the README so the zero-config `npx tia-gateway` path is visible immediately.

## 0.2.0

- Add Telegram DM support through `telegraf`.
- Add WhatsApp support through `@whiskeysockets/baileys`, including terminal QR login and reconnect handling.
- Replace the old argument parser with a Commander-based CLI and add interactive `onboard` flows.
- Auto-launch onboarding on `npx tia-gateway` when no channels are configured, including WeChat and WhatsApp re-login from the onboarding flow.

## 0.1.0

- Bootstrap `tia-gateway` as a publishable npm package.
- Add a protocol-agnostic gateway core with ACP as the first protocol adapter.
- Add WeChat and Lark channel connectors.
- Add CLI bootstrap, config loading, tests, and documentation.
