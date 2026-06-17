# Codex CLI Protocol Audit

Date: 2026-06-17

## Version Baseline

- Installed CLI: `codex-cli 0.140.0` from `codex --version`.
- Current npm stable: `@openai/codex@0.140.0` from `npm view @openai/codex version dist-tags --json`.
- Current npm alpha: `@openai/codex@0.141.0-alpha.4` from npm dist-tags. This audit uses stable, not alpha.
- Project package: `@nervmor/codexui@1.0.33`.

The project app-server schemas were regenerated with `codex app-server generate-json-schema --experimental` and `codex app-server generate-ts --experimental` through `npm run appserver:schema:update`.

## Official Protocol Evidence

- Official app-server documentation: `https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md`.
- Official package source for this runtime: the installed `@openai/codex@0.140.0` package and its generated app-server schemas.
- Protocol transport remains JSON-RPC 2.0.
- Current app-server schema namespace remains `v2`; the version did not change to `v3`.

## Current Project Bridge

- `codexAppServerBridge.ts` starts `codex app-server` over stdio.
- The bridge initializes with `capabilities.experimentalApi: true`.
- `/codex-api/rpc` is a generic JSON-RPC proxy, so the server layer can forward current CLI methods even when the UI has no first-class workflow.
- `/codex-api/meta/methods` and `/codex-api/meta/notifications` are generated from the installed CLI schema at runtime.
- The bridge captures server-initiated requests and exposes them through pending request endpoints for UI approval handling.

## Protocol Drift Found And Fixed

Before this update, `npm run appserver:schema:check` reported drift against `codex-cli 0.140.0`.

The checked-in schema now matches the installed stable CLI. Changes versus the previous checked-in schema:

- Request methods added:
  - `thread/delete`
  - `thread/backgroundTerminals/list`
  - `thread/backgroundTerminals/terminate`
- Notification methods added:
  - `thread/deleted`
- Removed methods: none.
- Existing shape changes:
  - `remoteControl/enable` and `remoteControl/disable` now accept nullable params types instead of only `undefined`.
  - `thread/realtime/start` accepts per-session realtime `architecture`, `model`, and protocol version overrides.
  - `thread/realtime/appendText` requires a text role type in the schema.
  - `thread/start` includes `selectedCapabilityRoots`.
  - Thread item/source types expanded for sub-agent activity and more flexible source strings.

Verification:

- `npm run appserver:schema:check` reports `App-server schemas are up to date.` after regeneration.

## Functional Coverage Snapshot

Generated `0.140.0` protocol surface:

- Request methods: 120.
- Notification methods: 67.
- Request methods directly used by project source: 40.
- Notification methods directly handled by project source: 25, plus generic refresh for `thread/*`, `turn/*`, and `item/*`.

Implemented or aligned in this update:

- The sidebar `Delete thread` action now calls `thread/delete` instead of archiving the thread.
- The delete confirmation copy now describes permanent deletion and spawned child thread deletion.
- Local title/read/scroll/goal/queue state is cleared after a successful delete.
- `thread/deleted` is covered by the existing generic `thread/*` notification refresh path.

Important missing or partial first-class feature areas:

- Background terminals: `thread/backgroundTerminals/list` and `thread/backgroundTerminals/terminate` are now in the protocol, but the UI only has generic RPC access and no terminal management surface.
- Remote control: enable, disable, pairing, status, client list, and revoke methods are not surfaced in the UI.
- Native account flows: app-server login/logout/cancel/add-credits and `account/usage/read` are not first-class UI workflows.
- Conversation management: unarchive, unsubscribe, loaded-list, inject-items, memory mode, manual compact, shell command, and elicitation increment/decrement are still not first-class UI workflows.
- Realtime voice: realtime start, append audio/text, stop, and list voices are not exposed as a complete browser workflow.
- Filesystem mutation and watch APIs: write, create directory, remove, copy, watch, and unwatch are not first-class UI workflows.
- Low-level command/process APIs: command exec and process spawn/control methods are not first-class UI workflows.
- Plugin sharing, marketplace administration, MCP resource/tool calls, external agent config import, experimental features, and Windows sandbox setup remain partial or unsurfaced.

## Priority Gaps

1. Background terminal management: latest stable CLI added list and terminate, making this the newest unimplemented feature gap.
2. Remote control workflows: the protocol has a broad pairing/client lifecycle, but the current project does not expose it.
3. Account usage: useful next to existing account/rate-limit UI.
4. Thread unarchive and manual compact: important conversation lifecycle parity.
5. Realtime voice: large feature area requiring browser audio/WebRTC UX and permission handling.

## Notes

- Stable parity for protocol documentation is now based on `codex-cli 0.140.0`.
- Runtime method catalogs remain safer than static documentation when the user runs a different installed CLI version.
- The project intentionally keeps a generic RPC proxy; missing direct source references should be read as missing product workflows, not necessarily missing server transport capability.
