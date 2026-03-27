# tia-gateway Bootstrap Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and publish the first `tia-gateway` package that connects WeChat and Lark channels to agent protocols, with ACP implemented first but not hard-wired into the core architecture.

**Architecture:** Use a protocol-agnostic gateway runtime that accepts channel adapters on one side and protocol adapters on the other. Implement ACP as the first protocol adapter with per-conversation subprocess sessions, then wire WeChat and Lark channels into the shared runtime through a config-driven CLI.

**Tech Stack:** TypeScript, Node.js 20+, `@agentclientprotocol/sdk`, `@larksuiteoapi/node-sdk`, `qrcode-terminal`, Node test runner via `tsx`

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `README.md`
- Create: `CHANGELOG.md`
- Create: `LICENSE`

**Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import packageJson from "../package.json" with { type: "json" };

test("package metadata is publishable", () => {
  assert.equal(packageJson.name, "tia-gateway");
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL because package files and test scaffold do not exist yet

**Step 3: Write minimal implementation**

```json
{
  "name": "tia-gateway",
  "version": "0.1.0"
}
```

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add package.json tsconfig.json README.md CHANGELOG.md LICENSE
git commit -m "chore: scaffold tia-gateway package"
```

### Task 2: Gateway Core

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/abstract-channel.ts`
- Create: `src/core/serialized-session-manager.ts`
- Create: `src/core/gateway-app.ts`
- Test: `test/gateway-app.test.ts`

**Step 1: Write the failing test**

```ts
test("gateway serializes turns per conversation", async () => {
  assert.equal(actualOrder, expectedOrder);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- gateway-app`
Expected: FAIL because the core runtime does not exist yet

**Step 3: Write minimal implementation**

```ts
export class SerializedSessionManager<T> {}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- gateway-app`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core test/gateway-app.test.ts
git commit -m "feat: add protocol-agnostic gateway core"
```

### Task 3: ACP Protocol Adapter

**Files:**
- Create: `src/protocols/acp/config.ts`
- Create: `src/protocols/acp/client.ts`
- Create: `src/protocols/acp/adapter.ts`
- Test: `test/config.test.ts`

**Step 1: Write the failing test**

```ts
test("resolves built-in ACP presets", () => {
  assert.equal(resolveAcpAgentSelection("codex").command, "npx");
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- config`
Expected: FAIL because the ACP config layer does not exist yet

**Step 3: Write minimal implementation**

```ts
export const BUILT_IN_AGENTS = {
  codex: { command: "npx", args: ["@zed-industries/codex-acp"] }
};
```

**Step 4: Run test to verify it passes**

Run: `npm test -- config`
Expected: PASS

**Step 5: Commit**

```bash
git add src/protocols/acp test/config.test.ts
git commit -m "feat: add ACP protocol adapter"
```

### Task 4: Channel Connectors

**Files:**
- Create: `src/channels/wechat-channel.ts`
- Create: `src/channels/lark-channel.ts`
- Create: `src/channels/index.ts`

**Step 1: Write the failing test**

```ts
test("gateway can create configured channels", () => {
  assert.equal(channelCount, 2);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL because the channel factories do not exist yet

**Step 3: Write minimal implementation**

```ts
export function createChannel() {
  throw new Error("Not implemented");
}
```

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/channels
git commit -m "feat: add wechat and lark channels"
```

### Task 5: CLI, Docs, and Publish Verification

**Files:**
- Create: `src/bin/tia-gateway.ts`
- Create: `src/config.ts`
- Modify: `README.md`

**Step 1: Write the failing test**

```ts
test("loadGatewayConfig rejects empty channel lists", async () => {
  await assert.rejects(loadGatewayConfig({}));
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL because config validation does not exist yet

**Step 3: Write minimal implementation**

```ts
if (channels.length === 0) {
  throw new Error("At least one channel must be configured");
}
```

**Step 4: Run test to verify it passes**

Run: `npm run check`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bin src/config.ts README.md
git commit -m "feat: add CLI and publish docs"
```
