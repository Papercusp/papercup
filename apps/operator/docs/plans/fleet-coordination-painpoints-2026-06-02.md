---
title: Fleet coordination pain points — audit-driven fixes (non-lock)
slug: fleet-coordination-painpoints-2026-06-02
status: draft
created: 2026-06-02
updated: 2026-06-03
owner: aviynw@gmail.com
---

# Fleet coordination pain points — audit-driven fixes (non-lock)

## Now

**State:** Buildable scope COMPLETE. P-019 desktop/Tauri health probe landed 2026-06-02 (commit 82185f193): desktop-health.ts probes the Tauri shell via dev-bridge /eval + IPC socket + toastLog error count, present:false when no desktop is running so the 1-min tick never broadcasts a phantom DOWN; up = bridgeEval && ipcConnectable, recentErrors informational only (one transient error toast must not flip DOWN); wired into probeAll + dev:service_health; 15 unit tests + tools-md-sync 46/46 green. All Phase 1/2/3b/4/6 work shipped. REMAINING (all need the user, none autonomous): P-008/P-010 code-health breaker — BLOCKED by D-009 (no clean green signal on this box: 553 pre-existing tsc errors + stale origin/main); P-012 harness-spawn empty-config-stub bug (needs-human, needs a live repro); P-015 human ship sign-off.

**Next:** User decisions needed for full close: (1) P-008/P-010 — invest in a trustworthy green signal or formally drop the code-health breaker (D-009); (2) P-012 — attempt the empty-config-stub repro now or park it; (3) P-015 ship sign-off.

## Background — the audit

A sweep of `harness_shared.coord_event_log` (the coord channel) on 2026-06-02:

- **Volume:** 17,546 `notify` vs **114** real `message`s — a 154:1 firehose. `notify` breakdown: `lock_acquired` 9,714 · `any`-trigger 6,860 · `plan_referenced` 978. Fanned to **13** watcher agents. The injection hook (`posttooluse-coord-inbox.sh`) renders notifies line-by-line (no kind filter), so any agent with a broad `**`+`any` watch gets its context spammed with "X acquired a lock on Y".
- **Recurring message themes** (of the 114 real messages): migration/schema drift **33**, stale-server/:43xx/:3070 **25**, broken-`main` (tsc-red / gate-broke / orphaned importer) **19**, spawn/empty-config-stub **12**.
- **0 open escalations** (agents resolve in-band — healthy). Handoffs (27) are mostly smoke-test traffic.

The lock-solvable items are DONE under `named-resource-locks-drain` (shop / desktop-sidecar / submodule + dev-server / db-schema). This plan is the **non-lock** remainder.

## Phase 1 — Notify de-noise (coord channel signal-to-noise)

The auto-generated `notify` firehose has **no push-consumer value**: an agent learns about file contention when *it* tries to acquire (the lock hook tells it then). So the fix is to stop generating + pushing it — NOT to collapse it to a "+N suppressed" line (that count is noise too; D-002).

- **P-001** `done` Injection hook (`posttooluse-coord-inbox.sh`) surfaces ONLY interrupts — `message` / `handoff` / `escalation` / `ack` — and drops `notify` from the injection ENTIRELY (no line, no count). importance: high
- **P-002** `done` At the SOURCE: stop auto-firing `lock_acquired` notifies (9,714 rows, zero consumer). Keep the `coord:watch` / `notify` mechanism only for explicitly-requested watches an agent reads via `coord:inbox` on demand — never auto-pushed. importance: high
- **P-003** `done` GC the accumulated notify rows (17k+) and add a retention window so the table can't grow unbounded. blocked-by: P-002 (one-time delete cleared 17,951 rows; daily DBOS GC tick added)
- **P-004** `done` `coord:inbox` defaults to excluding `notify` (opt-in via an explicit `kinds` arg), so even a direct inbox read isn't firehosed. importance: high

## Phase 2 — Native-PG migration drift detection

Root cause confirmed: native `:5432` (this dev box's substrate) has **no migration auto-runner** — the operator's `applyPendingMigrations` (`instrumentation-node.ts:138`) is embedded-pg-only. Agents hand-apply to `:5432` and drift (missing columns, boot crashes from out-of-order DDL).

- **P-005** `done` `db:check-drift` tool — diff `libs/papercusp/libs/db/sql/*.sql` against what's recorded applied on the live `:5432`; report missing (and unexpected) migrations. Detection only.
- **P-006** `done` Surface drift as a boot/health warning (a notification / `/coord` signal) so it's caught before a runtime "missing column" failure. (post-boot drift warning in instrumentation-node + db:check_drift tool)
- **P-007** `done` Decide: add an OPT-IN native `:5432` auto-apply, or stay detection-only — respecting "embedded-pg is the source of truth, native is a dev chore" (CLAUDE.md). importance: normal (resolved: detection-only D-008)

## Phase 3 — main-health monitor

Recurring: agents leave `main` tsc-red / gate-broken (partial commits, swept deletions without importer edits, a crash-looping host).

- **P-008** `dropped` A periodic `test:affected` + `tsc` check that, on RED, broadcasts a `main RED since <commit> (<area>)` coord message so the breaker is told fast. (no clean green-signal on this box D-009 — full tsc always-red 553 pre-existing, test:affected vs stale origin/main) (Dropped per user-delegated call 2026-06-02, D-009: no trustworthy green signal on this box 553 baseline tsc errors + stale origin/main + commit-whole-tree/--no-verify = red main is semi-normal, so a breaker would be noise. The useful half of main-health services up shipped via P-016–P-019. Drop beats a flaky gate pre-alpha.)
- **P-009** `done` Decide where it runs (`/loop` / cron / the operator background loop / a git hook) + cadence. importance: normal (RESOLVED D-006: operator process — code-health via fs-watch on .git ref event, not poll, service-health via a voice-engine-health-style probe sweep; output via a health-bus @papercusp/sse + coord message)
- **P-010** `dropped` (optional) An OPT-IN pre-commit affected-typecheck a breaker can enable — explicitly NOT mandatory (the repo deliberately allows `--no-verify` + the commit-packages-whole-tree model). blocked-by: P-008 (Dropped with P-008 its parent. Already marked optional/non-mandatory; the repo deliberately allows --no-verify. An agent who wants a pre-commit typecheck can run tsc directly; no breaker needed.)

## Phase 4 — Host freshness (complements the locks)

- **P-011** `done` `/api/build-info` (or a tool) returns the running operator's commit SHA + process start time, so an agent can verify "is `:3070` running my commit?" before trusting a probe — the no-hot-reload stale-code trap (memory: verify-server-PID-before-measuring). Restart's BuildStatus pill is precedent. (already provided by GET /api/desktop/version sidecarSha + sidecarStartedAtMs + nowMs — no new endpoint needed; service-health consumes it)

## Phase 5 — Harness-spawn empty-config-stub bug

- **P-012** `needs-human` Investigate the reported bug: a FULL agent spawn (MCP + subagents + persona) writes EMPTY config stubs (`package.json`, `bunfig.toml`, `.env.*`). Reproduce, root-cause, fix; may spin out into its own plan. importance: high (ROOT-CAUSED live strace: NOT a Papercusp bug — claude-code's plugin-marketplace git auto-update checks its plugin tree out into the worker cwd O_CREAT|O_EXCL ⇒ only-missing files on a mid-spawn refresh. Fix our side: DISABLE_AUTOUPDATER=1 + isolated CLAUDE_CONFIG_DIR in the claude spawn env orchestrator invoke.ts. Not applied — load-bearing submodule path; needs go-ahead.)

## Phase 6 — Tests & docs

- **P-013** `done` Tests for the notify removal (injection + inbox default), the drift-check, and the main-health broadcast. (per-unit tests: inbox 3, gcOldNotifies, migration-drift, service-health diffHealth 3)
- **P-014** `done` Document the coord-channel convention — `notify` is on-demand situational awareness, NOT a pushed interrupt — in the SU playbook + agent-spawning docs.

## Phase 7 — Ship gate

- **P-015** `needs-human` Human sign-off before considering this shipped. importance: urgent


## Phase 3b — Service health (endpoints up)

- **P-016** `done` Endpoint registry: {name, url, probe-type} for the dev services — :3070 operator (HTTP 200 + build-info SHA), :3055 vite SPA (200 + HMR-ws), :4321 shop, :4848 zero-cache, :3350 scout, :3001 web, :8082 code-server, PG (dev:pg_health). Desktop has no HTTP health — see P-019. importance: high


## Phase 3b — Service health (endpoints up)

- **P-017** `done` Poller: probe each registered endpoint on an interval; record up/down transitions (+ latency) in a `service_health` PG table (transitions, not every tick — avoid a new firehose). blocked-by: P-016 (probeAll + diffHealth + module-state restart-safe via unknown-as-up; no PG table needed)


## Phase 3b — Service health (endpoints up)

- **P-018** `done` Broadcast a coord message on a DOWN transition (and recovery) + surface current status in /coord. Use the message channel, NOT notify (Phase 1 just killed the notify firehose — don't recreate it). blocked-by: P-017 (coord message on transition + dev:service_health snapshot; SSE health-bus UI pill deferred — see D-009)


## Phase 3b — Service health (endpoints up)

- **P-019** `done` Desktop/Tauri health (no built-in HTTP health): probe via the existing tauri-agent-tools dev bridge (webview up + JS eval) + the Tauri↔sidecar IPC unix socket (alive = healthy) + toastLog.recent (recent error toasts = unhealthy). blocked-by: P-016 (desktop-health.ts: probe via dev-bridge /eval + IPC socket + toastLog; present:false when no desktop runs diffHealth skips it → no phantom DOWN. up=bridgeEval&&ipcConnectable; recentErrors informational. Wired into probeAll + dev:service_health. 15 unit tests + tools-md-sync green. commit 82185f193)

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


### D-007 — Monitors are DBOS scheduled workflows, not setInterval (supersedes D-006's mechanism; BullMQ is not installed)
Date: 2026-06-02
Confirmed the durable-job system: DBOS (`@dbos-inc/dbos-sdk`) — `DBOS.registerScheduled` ×8, `DBOS.runStep` ×17, and `apps/operator/lib/dbos/periodic-workflows.ts` is an in-flight arc (`dbos-durable-jobs-2026-05-31`) deliberately REPLACING `setInterval` workers (telemetry-flush, scratch-gc) with DBOS scheduled workflows: skip-missed mode (no backfill storm after a closed desktop), flag-gated `PAPERCUSP_DBOS_TIMERS=1`, step retries + recovery cap. Pattern: single-run tick fn → `DBOS.runStep(..., {retriesAllowed})` → `DBOS.registerWorkflow` → `DBOS.registerScheduled({crontab})`.

So this plan's monitors follow THAT shape, not a raw setInterval (my earlier rec — the anti-pattern they're migrating off): service-health, code-health, and the migration drift-check (P-005) all become DBOS scheduled workflows in/alongside `periodic-workflows.ts`. Durability matters precisely because the `:3070` operator restarts constantly (no hot-reload) — a setInterval monitor dies on restart; a DBOS scheduled workflow resumes (skip-missed). The external-liveness probe (service-health) is still a probe, but as a `DBOS.runStep` with retries. Code-health: a short-crontab scheduled workflow doing a cheap `git rev-parse HEAD` compare → `runStep(tsc/test:affected)` only when HEAD moved (chokidar fs-watch is an optional refinement; sub-second commit detection isn't needed for a health monitor — this simplifies vs D-006's fs-watch).

Output is UNCHANGED: DBOS owns durable execution + transactional state writes; the live fan-out to UI/agents stays the SSE/IPC bus (`ctx.emit` / a health-bus) + a coord message on a down/RED (DBOS's own setEvent/send is workflow-to-workflow, not live UI push).

BullMQ is NOT installed (no `bullmq` import, absent from every package.json; the only `new Worker` is a Web Worker for embeddings) — DBOS-on-Postgres is the system, matching the repo's no-Redis / PG-by-default stance.
Related: P-005, P-008, P-009, P-016, P-017


### D-008 — P-007 resolved — native :5432 migration drift is detection-only
Date: 2026-06-02
User delegated. Native `:5432` migration drift = DETECTION-ONLY (`db:check-drift` + a boot warning, P-005/P-006), NOT a native auto-apply. Embedded-pg stays the ship-target source of truth; native `:5432` is a dev chore (CLAUDE.md) — auto-applying there would let code quietly depend on the chore having happened.
Related: P-007


### D-009 — Code-health monitor (3a) deferred — no reliable green signal on this box
Date: 2026-06-02
Service-health (3b) shipped. Code-health (P-008/P-010) is DEFERRED/blocked: there's no reliable always-green check here. Full `tsc --noEmit` is always-RED (553 pre-existing operator type errors), and `test:affected` diffs against a never-pushed, stale `origin/main` (→ broad + slow). A naive code-health monitor would fire on every commit — pure noise, the exact opposite of Phase 1's de-noise. Unblock options for later: (a) drive the 553 pre-existing tsc errors to zero so `tsc` becomes a valid gate; (b) a per-workspace affected-typecheck scoped to only the changed workspace(s); or (c) a committed green baseline to diff against. Also deferred: the SSE health-bus (live UI pill, D-005) — the coord transition-broadcast + `dev:service_health` snapshot already deliver the functional alerting; the SSE bus is a UI nicety, not load-bearing.
Related: P-008, P-010


### D-010 — Spawn empty-config-stub bug — investigation pointer (P-012)
Date: 2026-06-02
Bounded investigation: the per-spawn HOME / sandbox setup lives in `libs/papercusp/packages/orchestrator/src/invoke.ts` (`resolveSpawnHome`, `writeSignedSpawnCodexHome`, the sandbox cache-redirect that mkdir's CARGO_HOME/XDG_CACHE_HOME/etc., gitConfigNoPushEnv). The empty `package.json`/`bunfig.toml`/`.env.*` stubs reported by su-971b8d33 were NOT pinpointed to an explicit writeFile in a static read — they're likely seeded by the spawn-home or sandbox path under a condition. Root-causing needs a live repro (spawn a full agent, inspect the HOME) + ideally pairing with the reporter (su-971b8d33). Left as needs-human (P-012); the dbos-flows P-007 (DBOS-ify spawn provisioning) is gated on this root-cause — only worth a durable workflow if the bug is a partial-spawn failure mode.
Related: P-012

## Open questions
- **Notify** — confirm source-removal of `lock_acquired` (D-002) vs keeping it but never injecting. Lean: remove at source.
- **main-health** — where does it run + cadence (P-009)?
- **Native migration auto-apply** — opt-in, or never (P-007)?
- **Order** — lead with Phase 1 (notify de-noise) — highest leverage, lowest risk?
