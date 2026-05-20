---
title: Desktop-native transport for the endpoint system
slug: desktop-native-transport-2026-05-12
status: active
created: 2026-05-12
updated: 2026-05-20
owner: pandawamble@gmail.com
---

## Now

**State:** **Status:** **implemented** on `sse-typed-events-ipc` (papercusp-desktop) + `sse-typed-events` (papercup). See decision below for the benchmark-gate override.

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# Desktop-native transport for the endpoint system

**Status:** **implemented** on `sse-typed-events-ipc` (papercusp-desktop) + `sse-typed-events` (papercup). See decision below for the benchmark-gate override.

## Decision (2026-05-12) — proceeded without Day-0 benchmark

The reviewer's Day-0 benchmark gate was overridden by user direction: the latency/throughput analysis in this doc was deemed sufficient evidence, and the user judged the medium-plan investment worthwhile on roadmap grounds (binary capability, native backpressure, future tool surface) rather than current measured latency. The shelving memo described in this doc was therefore not produced; the IPC code shipped against the original commit-order plan with the existing analysis as the rationale of record.

Benchmarking remains a useful P2 follow-up — if it later shows IPC isn't measurably better than HTTP+SSE on real workloads, the env-override (`NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT=1`) provides a clean rollback path without code changes.

Captures the conversation about going beyond HTTP+SSE for the desktop (Tauri) surface of the endpoint system. Includes the IPC-options landscape, the recommended designs at three investment levels, the reviewer's pushback, and the explicit go/no-go decision gate.

---

## TL;DR

- The endpoint system today serves the Tauri webview via localhost HTTP+SSE through the operator sidecar. **It works.**
- The "more native" alternatives (Tauri Channel<T>, UDS-pipe-protocol, shared memory) would all be measurable improvements *in theory* but **none of the wins land at user-perceptible scale for current workloads**.
- The right path forward is a **Day-0 benchmark** that decides between three investment ladders. Anything beyond Day 0 is contingent on the data + on a roadmap feature pulling for it.

---

## Goals

1. Quantify the actual cost of localhost HTTP+SSE on desktop. (Day 0.)
2. Pick the simplest transport that meets the goal pulled by an actual roadmap feature, if any.
3. Document the IPC-options landscape so future readers know what was considered and why we stopped where we did.

## Non-goals

- Removing the HTTP transport. It stays for MCP-spawned agents (out-of-process), the non-Tauri webapp (`:3070`), the dev browser at `:3055`, and the mobile `papercup-rust-mobile` target.
- Building a complete WebSocket transport for the browser. SSE handles every browser use case the framework currently has; if binary streaming becomes a browser requirement, that's a separate plan.
- Rewriting the projection registry in Rust.

## Hard prerequisite

Phase 3 of `apps/operator/docs/plans/sse-typed-events-2026-05-12.md` has shipped, specifically `dispatchProjectedToolStream` (commit 9). The IPC plan re-uses that as the dispatch primitive; without it the Node-side server has nothing clean to plug into.

Status as of writing: **shipped** on the `sse-typed-events` branch. Phase 3 commits 1-17, two pilots exercised (`architect:chat` and `operator:scan`), four routes folded in. Branch is `20 commits ahead of main` and pushed.

---

## What does localhost SSE actually cost?

Per emitted event on the Tauri-localhost SSE path:

| Cost | Value |
|---|---|
| TCP loopback syscall (Linux) | ~10-20 µs |
| HTTP chunked-encoding framing | ~5 bytes |
| SSE wire framing (`event: X\ndata: …\n\n`) | ~20-50 bytes |
| TLS, CORS, DNS | 0 (localhost passthrough) |
| **Total per event** | **~30-70 µs, ~50 bytes overhead** |

Claude/omp emit tokens at ~10-30/sec. Localhost SSE can sustain ~50 000 events/sec without breaking a sweat. **Current usage is ~0.06% of available bandwidth.** Token streams are CPU-bound on LLM inference and the parser loop. The SSE transport is rounding error.

So the cost is real but tiny. Where it stops being tiny:

- High-frequency binary (60 fps video frames, 96 kHz+ audio chunks, GPU readbacks).
- Cases that need browser-EventSource features we don't have (custom headers, POST body for input, native binary frames, backpressure signaling).
- Battery-sensitive contexts (not relevant on desktop).

---

## What "native transport" desktop currently uses

I traced the actual setup to make sure we weren't already on something I'd forgotten about:

1. `HarnessZeroProvider.tsx:48` detects Tauri via `window.__TAURI_INTERNALS__` and routes to `syncType="SSE"`.
2. `SSEAdapter` (`libs/sync/src/transports/sse/SSEAdapter.tsx:184`) opens an `EventSource` via `createResilientEventSource` from `@restart/sse`. That's the browser's built-in `EventSource` API.
3. The endpoint is `/api/zero-harness/sse` — the same Next.js operator process running as the Tauri sidecar (spawned by `src-tauri/src/main.rs`).
4. `tauri.conf.json` has `devUrl: "http://localhost:3055"` — the Tauri webview loads the operator UI from the sidecar.

**There is no Rust SSE bridge.** No `tauri::command` for streaming. No `app.emit` of upstream SSE events. Tauri is just a Chromium webview pointed at localhost.

What's "native" about the current design is operational, not technical:
- No `zero-cache` child process to manage (the WS path requires `spawn_zero_cache_server` in `main.rs:209`). SSE comes from the operator's own Next.js process.
- PG LISTEN/NOTIFY powers the server side, so push latency is millisecond-class.
- Tauri webview's `EventSource` doesn't traverse a real network — `localhost:3055` is in-process IPC at the OS level.

The 2026-05-07 commit referenced in `SSEAdapter.tsx:21` is the WS → SSE switch, which eliminated the `zero-cache` subprocess. That's what "more native" means in the existing codebase.

---

## IPC options landscape

For the cross-platform Tauri-sidecar case, the realistic options:

| Option | Latency | Complexity | Cross-platform | Multiplex | Binary | When |
|---|---|---|---|---|---|---|
| Unix Domain Sockets / Named Pipes | ~5-10 µs | Low | Yes (Tokio) | Native | Yes | **Default for any IPC investment** |
| Stdio (pipes via spawn) | ~5-10 µs | Lowest | Yes | No | Yes | Single-call sidecars (MCP-style) |
| Anonymous pipes (extra FDs) | ~5-10 µs | Medium | Awkward on Windows | Per-pair | Yes | Solves stdio's stdout-conflict only |
| **Shared memory + ring buffer** | ~1-3 µs | High | Three platform impls | Yes | **Zero-copy** | Real-time video/audio (not Papercusp today) |
| gRPC over UDS | ~50 µs+ | High (proto toolchain) | Yes | Native | Yes (framed) | Cross-network typed RPC |
| HTTP/2 over UDS | ~30 µs | Medium | Yes | Native | Yes (framed) | Migrating an HTTP server to local socket |
| Mach / D-Bus / etc. | Low | High per platform | No | Varies | Yes | Platform OS integrations |
| io_uring + shared rings | <1 µs | Very high | Linux-only | Yes | Zero-copy | DB / messaging infrastructure |

### Why UDS+named-pipes is the default for any IPC investment

- Multiplexing matters: many tool calls in flight (operator scan + delegate chat + harness chat all running simultaneously). UDS gives a stream you can frame; stdio doesn't multiplex; shared memory adds protocol design work; gRPC/HTTP add framing overhead.
- Latency budget is generous: chat token streams are bounded by LLM inference (50-100 ms per token). 5-10 µs IPC syscall is invisible. Going from 10 µs (UDS) to 1 µs (shared memory) saves nothing user-visible.
- Cross-platform is non-negotiable: desktop ships on macOS, Linux, Windows. UDS+named-pipes is the only option with clean Tokio abstraction.
- Diagnostics: `socat - UNIX-CONNECT:/tmp/papercusp-$pid.sock` for ad-hoc poking. Shared memory has no inspector.
- Listener pattern: multiple Tauri windows can connect to the same Node sidecar independently. Stdio can't.

### When the answer changes to shared memory

The day Papercusp ships:
- A tool emitting real-time video frames (e.g. "screen-capture-to-LLM").
- An audio capture/playback tool with sub-millisecond requirements.
- A GPU-readback tool.

None of those are on the roadmap. If one lands, **add shared memory as a parallel transport for that one tool**, not a rewrite of the whole IPC layer.

---

## The investment ladder

Three levels, in order of cost. **Each step is contingent on a measurable driver from the previous step.**

### Ladder Level 0: HTTP+SSE over localhost (current state)

What's there today. Works for every current use case. No work needed.

### Ladder Level 1: Light-touch Channel adapter

**~1 day of work.** Tauri command + Channel<T> + Rust-side SSE consumer.

```
[Webview]  → invoke('endpoint_subscribe', { toolName, input })  → [Rust]
                                                                    │
                                                                    ▼
                                                   fetch SSE from localhost:3055
                                                                    │
                                                                    ▼
[Webview]  ← Channel<EndpointEvent>  ← parse + re-emit ←         [Rust]
```

What this gives that browser SSE doesn't:
- **Native binary frames.** Channel<T> can carry Uint8Array directly (verify Specta typing; see footgun list).
- **Custom headers / auth on the SSE request.** Rust does the fetch; we control everything.
- **Backpressure.** Channel has flow control; pause Channel → Rust pauses pulling.
- **No HTTP→webview hop on stream-back.** Events go Rust→JS via Tauri IPC, skip the localhost SSE-parse phase entirely.

What it doesn't give:
- **The Node sidecar still emits SSE.** Rust→Node hop is still localhost HTTP. That hop is genuinely free in latency terms.

**Driver to build this:** A roadmap feature concretely needs custom headers / native binary / backpressure on desktop. Examples: streaming image-generation tiles, audio TTS chunks back to the browser, file-upload streams from a tool's input.

### Ladder Level 2: Medium UDS pipe protocol

**3-5 days of work.** Replace the Rust↔Node HTTP hop with a Unix-socket framed protocol; keep HTTP for everything else.

```
[Webview JS]
    │
    │  invoke('endpoint_invoke', { toolName, input, channel })
    │
    ▼
[Tauri Rust]
    │
    │  multiplexed UDS / named pipe
    │  frame: [4B len][1B type][payload]
    │
    ▼
[Node sidecar]
    │
    │  dispatchProjectedToolStream(tool, …, ctx, deps)
    │  ctx.emit → write frames back over same socket
    │
    ▼
[Tool function]
```

#### Wire format

```
+----------+--------+-----------------+
| length   | type   | payload         |
| (4 BE)   | (1)    | (length bytes)  |
+----------+--------+-----------------+
```

| Tag | Direction | Payload |
|---|---|---|
| `0x01` REQUEST | Rust → Node | `{ id: u64, toolName: string, input: unknown }` |
| `0x02` EVENT_JSON | Node → Rust | `{ id, name, data }` |
| `0x03` DONE | Node → Rust | `{ id, result: ToolResult }` |
| `0x04` ERROR | Node → Rust | `{ id, error: { code, message } }` |
| `0x05` EVENT_BIN | Node → Rust | `[8B id u64][4B name-len BE][name UTF-8][raw binary]` |
| `0x06` CANCEL | Rust → Node | `{ id }` |

**Self-describing binary frame** (no separate header). Each binary event carries its own `id` and `name` prefix, then raw bytes. Eliminates the concurrent-binary state-management bug the original sketch had (single global `pending_bin_header` slot was a real footgun under concurrent emits).

#### Trust model — webview-IPC bypasses signature verification

The HTTP path enforces auth/role/quota via seven HMAC-signed URL params (`workspace`, `harness`, `role`, `run`, `spawn`, `exp`, `sig`). That signing scheme was designed for the threat *"a spawned subprocess rewrites its own role param."*

**That threat doesn't apply to webview-originated IPC calls.** The Tauri webview is itself inside the trust boundary — same UID, same process tree, loopback-bind-equivalent. The Rust forwarder synthesizes a `principal: { role: 'operator' }` and the workspace from active context, then dispatches. Signature verification is skipped.

This matches what the existing chrome-scope HTTP routes already do — `/api/agent-mcp/operator-scan` and friends trust loopback + Host header and synthesize the operator principal without signing. IPC inherits that model.

**Must be documented in `transports.mdx`** alongside the existing loopback-bind trust model. Don't slip it in.

#### What stays on HTTP

- **MCP-spawned agents** (`claude-code` / `omp` subprocesses) hit `/api/mcp` and `/api/sse` over loopback HTTP. They are out-of-process; they cannot share the UDS. Mandatory.
- **Non-Tauri webapp** (`:3070` test surface, `papercup-rust-mobile` mobile target, dev browser at `:3055`). The transport picker falls through to HTTP.
- **The transport picker's fallback path** itself — when IPC fails or is force-disabled.

**IPC is webview-additive, not a replacement.** HTTP stays as the universal floor.

#### File layout

```
apps/operator/lib/
  endpoint-ipc-server.ts        ~150 LoC   UDS listener; dispatches via projection registry
  endpoint-ipc-framing.ts        ~80 LoC   Shared frame codec
  endpoint-ipc-server.test.ts   ~120 LoC   Round-trip tests
  transport-adapters/index.ts    ~30 LoC   isTauri() picker + env override
  transport-adapters/ipc-stream.ts  ~100 LoC  useTauriEndpointStream hook
  transport-adapters/http-stream.ts (existing, lightly refactored)

apps/papercusp-desktop/src-tauri/src/
  endpoint_ipc.rs               ~250 LoC   UnixStream/NamedPipe + tokio reader + DashMap demux + Tauri commands
  endpoint_ipc_framing.rs        ~60 LoC   Rust frame codec (matches Node byte-for-byte)
  endpoint_ipc.test.rs           ~80 LoC   Round-trip against mock server

apps/operator/server.ts            mod    Bootstrap startEndpointIpcServer via PAPERCUSP_IPC_SOCKET env
apps/papercusp-desktop/src-tauri/src/main.rs  mod  Spawn sidecar with socket path; init IpcClient as State
```

Total: ~870 LoC across 6 new files + 2 modifications.

#### Transport picker

```ts
// apps/operator/lib/transport-adapters/index.ts
import { isTauri } from '@tauri-apps/api/core';
import { dispatchEndpointStreamIpc } from './ipc-stream';
import { dispatchEndpointStreamHttp } from './http-stream';

const FORCE_HTTP =
  typeof process !== 'undefined' &&
  process.env.NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT === '1';

export const dispatchEndpointStream =
  !FORCE_HTTP && isTauri()
    ? dispatchEndpointStreamIpc
    : dispatchEndpointStreamHttp;
```

`isTauri()` (stable Tauri 2 API) instead of `window.__TAURI_INTERNALS__`. Env override means a regression in IPC ships a hotfix in minutes (set env, rebuild) instead of hours (revert + rebuild).

#### Cold-start: stdout-ready-line

Not retry-loop. Concretely:

```ts
// Node side, after server.listen() resolves:
process.stdout.write(`PAPERCUSP_IPC_READY socket=${socketPath}\n`);
```

```rust
// Rust side, sidecar manager parses each stdout line:
if line.starts_with("PAPERCUSP_IPC_READY ") {
    let socket_path = parse_kv(&line, "socket");
    socket_ready_tx.send(socket_path).unwrap();
}
```

Plus a 30 s timeout that hard-fails app boot with a fatal error dialog if the line never arrives. Wedged sidecars are debuggable; UI hangs aren't.

#### Socket path

`~/.papercusp/sockets/<pid>.sock` with `mkdirSync({ recursive: true, mode: 0o700 })`. Works on every distro regardless of `XDG_RUNTIME_DIR` semantics. `unlink` before bind to handle stale sockets after a crash.

**Linux-only optimization:** abstract socket namespace (`@papercusp-$pid` with leading null byte) lives in the kernel rather than the filesystem — no stale-file cleanup needed. macOS / Windows don't have this; gate the choice on `cfg!(linux)`.

#### Backpressure: bounded mpsc

Per-call mpsc capacity **10 000 events**, bounded. Unbounded queues are how you OOM the Tauri Rust process when one tool emits faster than the webview consumes. 10 k events is generous for any reasonable burst; we can tune up or down with telemetry.

When the queue hits high-water mark: drop oldest events with a `warn` log, OR backpressure the source via `Channel::send_blocking`. Decision deferred to implementation but the cap itself is non-negotiable.

#### Telemetry

Add `transport: 'ipc' | 'http' | 'mcp' | 'in_process'` column to `harness_shared.tool_invocations`. "Which transport did this call come from" is the obvious first debug query. Trivial to add now, painful to backfill later.

#### Typed events end-to-end — P2 follow-up

Phase 3 introduces typed event schemas on the registry. The IPC adapter as designed surfaces them as untyped `serde_json::Value` in the Rust enum:

```rust
pub enum EndpointEvent {
    Event { name: String, data: serde_json::Value },
    Binary { name: String, data: Vec<u8> },
    Done { result: serde_json::Value },
    Error { code: String, message: String },
}
```

Per-tool typed Rust enums (e.g. `OperatorScanEvent::Suggestion | Done | Error`) would require either:

1. A build step that reads Node's tool registry → emits Rust types via `quote!`. ~2 days of its own work + a deploy story for the dump file.
2. A shared `@papercusp/tool-schemas` package consumed by both Node (via Zod re-export) and Rust (via codegen). Cleanest architecturally; slowest to set up.
3. **Accept opaque events end-to-end on Rust side, narrow on JS** via the Zod schemas the dispatcher already has. Rust stays generic.

For the medium plan, option 3 is the right answer. The end-to-end Rust typing is a P2 follow-up — useful but not blocking IPC, and only really pays off if there are Rust-side consumers of these events, which there aren't today.

If the typed-pipeline investment happens later:
- Phase A (this plan): IPC with generic `EndpointEvent`, JS-side narrowing via Zod.
- Phase B (follow-up): build step that emits a TypeScript mirror of every tool's typed events from the registry. JS uses that for narrowing without parsing schemas at runtime.
- Phase C (further follow-up, if Rust-side consumers materialize): Rust-side codegen of typed events.

### Ladder Level 3: Shared-memory per-tool ring buffers

**~half-day per tool.** When real-time video/audio/GPU streaming becomes a feature.

The framework supports this naturally: declare the tool's binary event as `z.instanceof(Uint8Array)` and add an `expose.shm?: { ring: 'video-frame-1' }` field. The Channel<T> adapter routes binary events through shared memory instead of the UDS frame. Same `ctx.emit` API; different wire underneath.

No work is justified at Level 3 until a Level-3-specific feature lands on the roadmap.

---

## Day-0 spike + decision gate

The medium plan is contingent on Day-0 data. The current latency-and-throughput analysis says HTTP+SSE on localhost is plenty for current workloads, but **we don't ship plans on analyses, we ship on benchmarks.**

### Day-0 work (~6 hours)

- ~50 LoC Node socket server, one tool (`operator:scan` — high-frequency emits, real workload, already migrated to the framework).
- ~80 LoC Rust client + single Tauri command that subscribes and pumps via Channel.
- No framing protocol yet — JSON Lines over the socket, one tool, no multiplex.
- Same prompt, same model, same hardware. Capture:
  - p50 / p99 end-to-end token-to-render latency (browser SSE path vs IPC path).
  - CPU usage under sustained streaming (10-minute run).
  - Memory usage at peak (looking for IPC reducing parser allocations).
  - Events-per-second sustained throughput at a CPU budget — the "ceiling" matters more than per-event latency for future high-frequency tools.

### Decision gate

**Proceed with the medium plan if ANY of:**
- p99 token-to-render latency improvement **≥ 5 ms** on operator:scan streaming.
- Sustained-throughput ceiling **≥ 2× current** at the same CPU budget.
- A roadmap feature concretely needs **binary** / **custom headers** / **native backpressure** that HTTP+SSE can't deliver.

**Shelve the plan if NONE** of these hold. Write a public "we considered IPC, here's why HTTP is fine" memo at `apps/operator/docs/plans/desktop-native-transport-2026-05-12-shelf.md` with the data attached. Reclaim the 3-5 days for higher-leverage work.

The framing is intentional: this isn't "is the localhost path slow?", it's **"is there anything IPC unlocks that HTTP can't?"** — the wider question is the honest one.

---

## Pre-flight verification spikes

Three things to confirm during Day 0, each takes ~10-30 minutes:

### 1. Tauri `Channel<Vec<u8>>` binary path

Tauri 2's `Channel<T>` serializes via Serde. `Vec<u8>` defaults to a JSON array of numbers (24× overhead). Need to confirm either:
- Tauri exposes a binary serialization path for Channel payloads.
- `serde_bytes` or a custom Serde impl maps `Vec<u8>` to a base64 string (~1.33× overhead — acceptable).
- A 30-minute hello-world Tauri Channel<Vec<u8>> spike.

If binary doesn't work cleanly over Channel, the design still works for text events; **binary support waits for Tauri 3 or an upstream patch.** Plan can ship without binary if needed.

### 2. Specta + Channel<T> typing

Tauri 2's Channel + Specta has known footguns where the generated TypeScript thinks the channel argument is `unknown`. A 10-minute spike with `tauri-specta` against `Channel<EndpointEvent>` to verify the generated bindings include the correct type.

If Specta breaks on the generic Channel: fall back to typing-only on the JS side (`as Channel<EndpointEvent>` after invoke).

### 3. Backpressure semantics

Tauri Channel buffers in Rust. Verify the buffer depth and what happens when JS is slow:
- Does Rust block on `channel.send`?
- Does Rust drop events?
- Configurable, or fixed?

Answer determines per-call mpsc bounded capacity. Plan defaults to 10 k events with the understanding that backpressure-policy may need a follow-up.

---

## Revised commit order (if Day-0 proceeds)

1. **Commit 0 — Day-0 spike + benchmark + decision memo.** Lands either as first commit of the IPC PR (if go) or as a standalone shelved-doc commit (if no-go). Data is public either way.

2. **Commit 1 — Framing module + trust-boundary doc.** Frame codec on both sides matching byte-for-byte. Trust-boundary section in `transports.mdx` documenting the webview-IPC signature-skip carve-out.

3. **Commit 2 — Node IPC server, stdout-ready-line, `~/.papercusp/sockets/<pid>.sock`. Synthetic operator principal + signature-skip. Single-tool dispatch (operator:scan). `transport` column added to `tool_invocations`.**

4. **Commit 3 — Rust client, self-describing BIN_PAYLOAD format, bounded mpsc with 10 k high-water mark, `isTauri()` + `NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT` override. Specta spike, decide whether `Channel<EndpointEvent>` generic works as-is.**

5. **Commit 4 — Frontend transport picker, vertical-slice migration of operator:scan to IPC. End-to-end smoke: dev-tauri, dev-browser, prod-browser all work; force-http override flips back to HTTP cleanly.**

6. **Commit 5 — Reconnect with backoff, cancellation correctness, connection-lost fan-out, multiplex stress test (5 concurrent tools emitting at 10/sec).**

7. **Follow-up PR — Typed events end-to-end via Specta codegen. Deferred per P2 framing.**

Total: 3-5 days if the spike proceeds, **plus** the Day-0 spike before commitment.

---

## What I'd build first if a binary use case appears

If a roadmap feature needs binary streaming on desktop *before* the medium plan is justified by raw latency:

**Build Ladder Level 1 first** (light-touch Channel adapter, ~1 day). It gets binary-via-Channel + custom headers + backpressure for 25% of the medium plan's cost. The Rust→Node hop stays HTTP, which is genuinely free in latency terms. Most of the wins land.

The medium plan becomes worthwhile when **either** the Day-0 benchmarks show measurable latency gains **or** the high-throughput-multiplex case appears (5+ tools concurrently emitting binary at 60+ events/sec each).

---

## Open items / next decisions

- [ ] Schedule the Day-0 spike. Owner unassigned; ~6 hours of focused work.
- [ ] Pre-flight: 30-min `Channel<Vec<u8>>` spike, 10-min Specta-typing spike, 10-min backpressure-semantics check.
- [ ] If Day-0 proceeds: open the IPC PR with commit 0 as the data + decision memo, then commits 1-5 land in sequence.
- [ ] If Day-0 shelves: write the shelving memo, reclaim engineering time, link from `MEMORY.md`.

---

## Reviewer pushback that shaped this doc

1. **Lead with the benchmark, not bury it as pre-flight check #5.** Original plan committed to 3-5 days of work before data was in. This doc puts the Day-0 spike + decision gate at the top.

2. **Privilege escalation via missing signed URL params.** Original wire format had no auth on REQUEST frames; would have let webview JS call any tool as any role. Fix: webview-IPC is inside the trust boundary, synthesize operator principal, skip signature verification, document explicitly.

3. **Concurrent-binary protocol bug.** Original sketch used a single global `pending_bin_header` slot — two concurrent binary emits would have crossed wires. Fix: self-describing `EVENT_BIN_PAYLOAD` frame carrying its own `id`/`name`/raw-bytes prefix. No pairing state at all.

4. **Transport picker fragility.** `window.__TAURI_INTERNALS__` is outdated; `isTauri()` from `@tauri-apps/api/core` is the stable API. Added env-override `NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT=1` for runtime rollback.

5. **Cold-start ordering needs to be deterministic.** Original "either retry loop or stdout-ready-line — verify which" became "stdout-ready-line, period; 30-second timeout with fatal error."

6. **HTTP doesn't go away.** Original plan didn't address that MCP-spawned agents + the non-Tauri webapp + dev-browser all stay on HTTP. IPC is webview-additive, not a replacement. Now stated explicitly.

7. **Phase 3 prerequisite must be stated up top.** `dispatchProjectedToolStream` (Phase 3 commit 9) is the dispatch primitive the Node IPC server re-uses. Made the prereq explicit.

8. **Telemetry `transport` column.** Trivial to add now, painful to backfill. Now in the plan.

9. **Bounded mpsc with high-water mark.** Unbounded queues OOM the Rust process. 10 k events is the agreed default.

10. **Specta-typed events end-to-end.** Right in spirit, wrong in scope as a blocker. Documented as P2 follow-up; medium plan ships with generic `EndpointEvent` and JS-side Zod narrowing.

The two architectural bugs (auth bypass, concurrent binary state) would have shipped without this review. Recording them here so the next person building on this design starts with the fixed version.
