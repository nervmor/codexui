# Codex CLI Protocol Audit

Date: 2026-06-16

## Version Baseline

- Installed CLI: `codex-cli 0.139.0` from `codex --version`.
- Current npm stable: `@openai/codex@0.140.0` from `npm view @openai/codex version dist-tags --json`.
- Current npm alpha: `@openai/codex@0.141.0-alpha.2` from npm dist-tags.
- Project package: `@nervmor/codexui@1.0.33`.

This audit compares the project with the installed CLI protocol, because the app-server schema generator is version-specific. A separate CLI upgrade pass is required before claiming parity with `0.140.0`.

## Official Protocol Evidence

- The Codex manual documents `codex app-server` as a JSON-RPC 2.0 interface used by rich clients.
- Supported app-server transports are stdio, websocket, Unix socket, and off.
- The manual states generated TypeScript and JSON Schema artifacts match the Codex version that generated them.
- `codex app-server --help` on the installed CLI exposes `generate-ts` and `generate-json-schema`, both marked experimental.

## Current Project Bridge

- `codexAppServerBridge.ts` starts `codex app-server` over stdio.
- The bridge initializes once per process with `capabilities.experimentalApi: true`.
- `/codex-api/rpc` is a generic JSON-RPC proxy, so the server layer is not limited to a hard-coded method whitelist.
- `/codex-api/meta/methods` and `/codex-api/meta/notifications` generate a live method catalog from the installed CLI schema.
- The bridge captures server-initiated requests and exposes them through pending request endpoints for UI approval handling.

## Protocol Drift Found And Fixed

Before this audit, `npm run appserver:schema:check` reported drift against installed `codex-cli 0.139.0`.

The generated schema now matches the installed CLI. New app-server protocol surface versus the previous checked-in schema:

- New request methods:
  - `account/usage/read`
  - `remoteControl/pairing/status`
- New notification method:
  - `turn/moderationMetadata`
- Removed request methods: none.

Verification:

- `npm run appserver:schema:check` now reports `App-server schemas are up to date.`

## Functional Coverage Snapshot

Generated installed-CLI protocol surface:

- Request methods: 114.
- Notification methods: 65.
- Request methods referenced by project source: 41.
- Request methods not yet surfaced by project source: 73.

The 73 unused methods are not all required UI bugs, because the bridge can still proxy them. They are missing product features or unimplemented UI workflows when a user expects first-class support.

Important missing or partial feature areas:

- Account and usage: `account/usage/read`, app-server native `account/login/start`, `account/login/cancel`, `account/logout`, `account/sendAddCreditsNudgeEmail`.
- Remote control: `remoteControl/enable`, `remoteControl/disable`, `remoteControl/status/read`, `remoteControl/pairing/start`, `remoteControl/pairing/status`, `remoteControl/client/list`, `remoteControl/client/revoke`.
- Conversation management: `thread/unarchive`, `thread/unsubscribe`, `thread/loaded/list`, `thread/inject_items`, `thread/memoryMode/set`, `thread/compact/start`, `thread/shellCommand`, `thread/backgroundTerminals/clean`, elicitation increment/decrement.
- Realtime voice: `thread/realtime/start`, `thread/realtime/appendAudio`, `thread/realtime/appendText`, `thread/realtime/stop`, `thread/realtime/listVoices`.
- Filesystem mutation and watching: `fs/writeFile`, `fs/createDirectory`, `fs/remove`, `fs/copy`, `fs/watch`, `fs/unwatch`.
- Command/process control: `command/exec`, `command/exec/write`, `command/exec/terminate`, `command/exec/resize`, `process/spawn`, `process/writeStdin`, `process/kill`, `process/resizePty`.
- Plugin and marketplace administration: `marketplace/add`, `marketplace/remove`, `marketplace/upgrade`, `plugin/installed`, `plugin/skill/read`, plugin share and checkout methods.
- MCP advanced operations: `mcpServer/resource/read`, `mcpServer/tool/call`.
- Configuration and migration: `config/batchWrite`, `configRequirements/read`, `externalAgentConfig/detect`, `externalAgentConfig/import`, `experimentalFeature/list`, `experimentalFeature/enablement/set`.
- Windows sandbox support: `windowsSandbox/setupStart`, `windowsSandbox/readiness`.

## Priority Gaps

1. `account/usage/read`: high value because the project already shows rate-limit and account information; token usage is now a current CLI protocol method.
2. `turn/moderationMetadata`: should be considered for notification handling so moderation state is not silently ignored.
3. Remote-control pairing/status: important if the web UI should match current Codex remote workflows.
4. Thread unarchive, compact, loaded-list, memory mode, and background terminal cleanup: important for richer session management parity.
5. Realtime voice and low-level command/process/file mutation methods: larger feature areas that need UX design and safety decisions before exposing.

## Notes

- The installed CLI is behind npm stable by one release: `0.139.0` installed versus `0.140.0` latest.
- The schema committed here should be treated as `0.139.0` protocol documentation, not latest stable protocol documentation.
- Runtime method catalogs are safer than static docs because they are generated from the installed CLI at runtime.
