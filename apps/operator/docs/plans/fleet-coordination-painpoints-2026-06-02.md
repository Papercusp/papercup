---
title: Fleet coordination pain points — audit-driven fixes (non-lock)
slug: fleet-coordination-painpoints-2026-06-02
status: draft
created: 2026-06-02
updated: 2026-06-02
owner: aviynw@gmail.com
---

# Fleet coordination pain points — audit-driven fixes (non-lock)

## Now

**State:** Design captured + refined in review. Q1 CONFIRMED — remove the `lock_acquired` notify firehose at the source (D-002). "main-health" split into TWO concerns (D-005): Phase 3a = CODE health (is `main` green — tsc/test:affected → broadcast "main RED since X"); Phase 3b = SERVICE health (poll all dev endpoints, record up/down transitions, broadcast on a down). Neither Vite nor Tauri ships a health/metrics endpoint — probe Vite via HTTP-200 + HMR-ws, Tauri via the tauri-agent-tools bridge + IPC socket + toastLog. No code written.

**Next:** Resolve the remaining open questions — where the code-health monitor + service poller RUN and at what cadence (P-009), and native-migration auto-apply opt-in vs detection-only (P-007) — then implement Phase 1 (notify de-noise) first.

## Background — the audit

A sweep of `harness_shared.coord_event_log` (the coord channel) on 2026-06-02:

- **Volume:** 17,546 `notify` vs **114** real `message`s — a 154:1 firehose. `notify` breakdown: `lock_acquired` 9,714 · `any`-trigger 6,860 · `plan_referenced` 978. Fanned to **13** watcher agents. The injection hook (`posttooluse-coord-inbox.sh`) renders notifies line-by-line (no kind filter), so any agent with a broad `**`+`any` watch gets its context spammed with "X acquired a lock on Y".
- **Recurring message themes** (of the 114 real messages): migration/schema drift **33**, stale-server/:43xx/:3070 **25**, broken-`main` (tsc-red / gate-broke / orphaned importer) **19**, spawn/empty-config-stub **12**.
- **0 open escalations** (agents resolve in-band — healthy). Handoffs (27) are mostly smoke-test traffic.

The lock-solvable items are DONE under `named-resource-locks-drain` (shop / desktop-sidecar / submodule + dev-server / db-schema). This plan is the **non-lock** remainder.

## Phase 1 — Notify de-noise (coord channel signal-to-noise)

The auto-generated `notify` firehose has **no push-consumer value**: an agent learns about file contention when *it* tries to acquire (the lock hook tells it then). So the fix is to stop generating + pushing it — NOT to collapse it to a "+N suppressed" line (that count is noise too; D-002).

- **P-001** `todo` Injection hook (`posttooluse-coord-inbox.sh`) surfaces ONLY interrupts — `message` / `handoff` / `escalation` / `ack` — and drops `notify` from the injection ENTIRELY (no line, no count). importance: high
- **P-002** `todo` At the SOURCE: stop auto-firing `lock_acquired` notifies (9,714 rows, zero consumer). Keep the `coord:watch` / `notify` mechanism only for explicitly-requested watches an agent reads via `coord:inbox` on demand — never auto-pushed. importance: high
- **P-003** `todo` GC the accumulated notify rows (17k+) and add a retention window so the table can't grow unbounded. blocked-by: P-002
- **P-004** `todo` `coord:inbox` defaults to excluding `notify` (opt-in via an explicit `kinds` arg), so even a direct inbox read isn't firehosed. importance: high

## Phase 2 — Native-PG migration drift detection

Root cause confirmed: native `:5432` (this dev box's substrate) has **no migration auto-runner** — the operator's `applyPendingMigrations` (`instrumentation-node.ts:138`) is embedded-pg-only. Agents hand-apply to `:5432` and drift (missing columns, boot crashes from out-of-order DDL).

- **P-005** `todo` `db:check-drift` tool — diff `libs/papercusp/libs/db/sql/*.sql` against what's recorded applied on the live `:5432`; report missing (and unexpected) migrations. Detection only.
- **P-006** `todo` Surface drift as a boot/health warning (a notification / `/coord` signal) so it's caught before a runtime "missing column" failure.
- **P-007** `needs-human` Decide: add an OPT-IN native `:5432` auto-apply, or stay detection-only — respecting "embedded-pg is the source of truth, native is a dev chore" (CLAUDE.md). importance: normal

## Phase 3 — main-health monitor

Recurring: agents leave `main` tsc-red / gate-broken (partial commits, swept deletions without importer edits, a crash-looping host).

- **P-008** `todo` A periodic `test:affected` + `tsc` check that, on RED, broadcasts a `main RED since <commit> (<area>)` coord message so the breaker is told fast.
- **P-009** `done` Decide where it runs (`/loop` / cron / the operator background loop / a git hook) + cadence. importance: normal (RESOLVED D-006: operator process — code-health via fs-watch on .git ref event, not poll, service-health via a voice-engine-health-style probe sweep; output via a health-bus @papercusp/sse + coord message)
- **P-010** `todo` (optional) An OPT-IN pre-commit affected-typecheck a breaker can enable — explicitly NOT mandatory (the repo deliberately allows `--no-verify` + the commit-packages-whole-tree model). blocked-by: P-008

## Phase 4 — Host freshness (complements the locks)

- **P-011** `todo` `/api/build-info` (or a tool) returns the running operator's commit SHA + process start time, so an agent can verify "is `:3070` running my commit?" before trusting a probe — the no-hot-reload stale-code trap (memory: verify-server-PID-before-measuring). Restart's BuildStatus pill is precedent.

## Phase 5 — Harness-spawn empty-config-stub bug

- **P-012** `needs-human` Investigate the reported bug: a FULL agent spawn (MCP + subagents + persona) writes EMPTY config stubs (`package.json`, `bunfig.toml`, `.env.*`). Reproduce, root-cause, fix; may spin out into its own plan. importance: high

## Phase 6 — Tests & docs

- **P-013** `todo` Tests for the notify removal (injection + inbox default), the drift-check, and the main-health broadcast.
- **P-014** `todo` Document the coord-channel convention — `notify` is on-demand situational awareness, NOT a pushed interrupt — in the SU playbook + agent-spawning docs.

## Phase 7 — Ship gate

- **P-015** `needs-human` Human sign-off before considering this shipped. importance: urgent


## Phase 3b — Service health (endpoints up)

- **P-016** `todo` Endpoint registry: {name, url, probe-type} for the dev services — :3070 operator (HTTP 200 + build-info SHA), :3055 vite SPA (200 + HMR-ws), :4321 shop, :4848 zero-cache, :3350 scout, :3001 web, :8082 code-server, PG (dev:pg_health). Desktop has no HTTP health — see P-019. importance: high


## Phase 3b — Service health (endpoints up)

- **P-017** `todo` Poller: probe each registered endpoint on an interval; record up/down transitions (+ latency) in a `service_health` PG table (transitions, not every tick — avoid a new firehose). blocked-by: P-016


## Phase 3b — Service health (endpoints up)

- **P-018** `todo` Broadcast a coord message on a DOWN transition (and recovery) + surface current status in /coord. Use the message channel, NOT notify (Phase 1 just killed the notify firehose — don't recreate it). blocked-by: P-017


## Phase 3b — Service health (endpoints up)

- **P-019** `todo` Desktop/Tauri health (no built-in HTTP health): probe via the existing tauri-agent-tools dev bridge (webview up + JS eval) + the Tauri↔sidecar IPC unix socket (alive = healthy) + toastLog.recent (recent error toasts = unhealthy). blocked-by: P-016

## Decisions

### D-001 — Separate plan from the locks work
Date: 2026-06-02
`named-resource-locks-drain-2026-06-02` (shipped) solved the lock-shaped pain. This plan captures the audit's NON-lock findings so they're tracked independently; the two cross-reference.

### D-002 — Notify de-noise removes the firehose, doesn't summarize it
Date: 2026-06-02
The auto-generated `notify` stream (esp. `lock_acquired`) has no push-consumer: an agent learns contention when it acquires, from the lock hook. So injecting it — even as a "+N file-lock notifies suppressed" count — is pure noise (user feedback: that line is itself useless). The fix is to (a) drop `notify` from the injection entirely and (b) stop auto-firing `lock_acquired` at the source. `coord:watch` stays as an EXPLICIT, on-demand capability (read via `coord:inbox` when an agent actually wants it), never auto-pushed.

### D-003 — Migration drift = detection, not forced native auto-apply
Date: 2026-06-02
Native `:5432` is a dev-box convenience; embedded-pg is the ship-target source of truth (CLAUDE.md). The default fix is DETECTION (drift-check + warning), not a native auto-runner that would let code depend on the manual step having happened. An opt-in native auto-apply is a separate decision (P-007).

### D-004 — main-health informs, doesn't gate
Date: 2026-06-02
The repo deliberately runs a loose shared-commit model (`--no-verify`, commit-packages-whole-tree). A hard pre-commit gate fights that. So main-health is a MONITOR that broadcasts breakage to coord; any pre-commit gate stays opt-in for the breaker (P-010).


### D-005 — "main-health" is two distinct concerns — keep both (code-green vs services-up)
Date: 2026-06-02
My original "main-health" conflated two things; user's reframe splits them cleanly:

(A) CODE health — is committed `main` green (tsc / test:affected)? This is the audit's 19 "broken-main" messages. Phase 3a (P-008/P-010): a monitor that broadcasts `main RED since <commit>`.

(B) SERVICE health — are the running endpoints up? Per user: poll all relevant endpoints on an interval, record up/down transitions, broadcast on a down. Phase 3b (P-016–P-019). Endpoints to register: :3070 operator (+ the Phase-4 build-info SHA), :3055 vite SPA, :4321 shop, :4848 zero-cache, :3350 scout, :3001 web, :8082 code-server, and PG (via the existing dev:pg_health).

Built-in metrics question — neither ships a real health/metrics endpoint:
- Vite: no `/health` or metrics route. Liveness = HTTP 200 on `/` + HMR-WebSocket connectivity. Note Vite DOES hot-reload, so "stale code" isn't its failure mode (that's the no-hot-reload :3070 Hono host — covered by the build-info SHA, Phase 4).
- Tauri: no HTTP health endpoint (it's a desktop shell). Use the EXISTING `tauri-agent-tools` dev bridge (webview-up + JS-eval health), the Tauri↔sidecar IPC unix socket (alive = link healthy), and `toastLog.recent` / `notifications:recent` (recent error toasts = unhealthy UI).

Build on the existing dev:pg_health / dev:processes / dev:build_status / notifications:recent / toastLog.recent surfaces rather than re-rolling probes.
Related: P-008


### D-006 — Use the existing eventing system — don't reinvent polling (resolves P-009)
Date: 2026-06-02
User: don't we already have eventing? Yes. Confirmed primitives: `ctx.emit` (54 uses — the endpoint typed-event primitive projected over IPC/SSE/MCP), `pg_notify` (15), and the `@papercusp/sse` "bus" pattern (`flag-bus`/`harness-log-bus`/`run-chunk-bus` via `getChannel`). Plus existing sweeps to mirror: `harness-fs-watcher.ts` (chokidar + debounce) and `voice-engine-health.ts` (probe-loop + transition detection). So the monitors become event-driven, not poll-loops:

- CODE-HEALTH TRIGGER is an EVENT, not a poll: chokidar-watch `.git/HEAD` + `.git/refs/heads/main` (mirror harness-fs-watcher's watch+debounce) → fires on a ref change = a real commit. No `git HEAD` polling. The heavy `tsc`/`test:affected` runs as a bounded, debounced child process.
- SERVICE-HEALTH input is the ONE irreducible pull: external liveness has no event source (you can't subscribe to "a separate port died"). But mirror `voice-engine-health` (probe interval + last-known-up + fire on transition), hooked as a sibling health sweep — not a bespoke timer.
- OUTPUT for both: emit transitions through a `health-bus` (`@papercusp/sse getChannel`, mirroring flag-bus) → SSE (web) / IPC (desktop) live, PLUS a coord `message` on a down/RED for agents. Transitions only; never write-to-PG-and-poll (storage policy: DB is not a transport).

Resolves P-009: both run IN the operator process — code-health as an fs-watcher, service-health as a voice-engine-health-style probe sweep — both emitting via the health-bus. (P-008's "periodic" is superseded by the fs-watch trigger.)
Related: P-008, P-009, P-016, P-017, P-018

## Open questions
- **Notify** — confirm source-removal of `lock_acquired` (D-002) vs keeping it but never injecting. Lean: remove at source.
- **main-health** — where does it run + cadence (P-009)?
- **Native migration auto-apply** — opt-in, or never (P-007)?
- **Order** — lead with Phase 1 (notify de-noise) — highest leverage, lowest risk?
