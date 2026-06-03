---
title: Consolidate all schedulers onto DBOS — port the active tail, delete the dead ones
slug: dbos-scheduler-consolidation-2026-06-03
status: draft
created: 2026-06-03
updated: 2026-06-03
owner: avi@storewolf.com
---

# Consolidate all schedulers onto DBOS — port the active tail, delete the dead ones

## Now

**State:** Audit complete (see Background). The prior DBOS effort (`dbos-durable-jobs-2026-05-31`) already moved 11 scheduled jobs to DBOS. `PAPERCUSP_DBOS_ENABLE=1` is live in dev (`apps/operator/.env.local:68`) and forced on for the desktop (`apps/operator/lib/gym/boot-spec.ts:76`), so **DBOS is the live scheduler path** and `instrumentation-node.ts` is the retired Next hook (agent-insight `dbos-durable-execution-gotchas`). What remains: **3 active legacy `setInterval` jobs** still on timers, a pile of **dead scheduler code** in the retired instrumentation path, plus 2 systemd timers and the "keep" set. Awaiting human review of scope before implementation.

**Next:** P-001 — port `harness-status-sweep` to a DBOS scheduled workflow (cleanest candidate, no in-process state), proving the recipe, then the other two ports and the deletions.

## Background

User instruction: *"do a thorough audit of our code for any place using cron or setInterval or any other scheduling system, and port them all to DBOS unless we have a good reason not to"* — done before building the (paused) git-sync auto-commit scheduler, so we don't add another scheduler on top of an unconsolidated surface.

The 5-area audit (apps/operator, libs/packages, Rust, infra/systemd, current DBOS state) bucketed every recurring-scheduling site:

- **A — Already on DBOS (11):** `lib/dbos/periodic-workflows.ts` (telemetry hourly, scratch-gc daily 03:00, memory-cleanup 6h, completion-ref 1m, embed-backfill 5m, backup-cadence 1m, coord-notify-gc daily 04:00, service-health 1m) + `autoloop-workflow.ts` (30s) + `orchestrator-loop.ts` (30s). All `DBOS.registerScheduled`, flag-gated, skip-missed, step-retry + recovery caps.
- **B — Legacy A/B halves, already dead in the live host:** the `setInterval` halves of telemetry-flush / scratch-gc / embed-backfill / completion-ref-verifier / memory-cleanup (the 5 "gated" ones) + the backup scheduler + orphan-cleanup. Their `start*Worker()` calls live **only** in the retired `instrumentation-node.ts`, which the live `:3070` Hono host (`bin/host-bootstrap.ts`) never imports. So in the live product DBOS already owns these; the legacy code is orphaned → delete (Phase 2).
- **C — Active timers still to port (this plan's Phase 1 + 3):** `harness-status-sweep` (30s), backup `orphan-cleanup` (5m, currently silently dead — see D-003), `device-push-credentials` (50m), + 1 portable systemd timer (`test-runs-prune`).
- **D — Keep off DBOS, with reasons (Phase 3, P-011; D-002):** all Rust schedulers; per-connection/request/spawn loops; in-memory sweepers; the at-least-once outbox-drain; UI hooks; infra/CI (systemd services + GitHub Actions cron). The custom `routine-ticker` (not currently running in the operator) is deferred to the git-sync work.

The port recipe is established: wrap the existing single-run tick fn in `DBOS.registerWorkflow` + `DBOS.registerScheduled({ crontab })` (6-field, seconds-resolution), register in `lib/dbos/bootstrap.ts` under a `dbos*Active()` predicate from `lib/dbos/dbos-flags.ts`, and stand the legacy starter down with `if (dbos*Active()) return;` (or just delete it when the only caller is the dead instrumentation path).

## Phase 1 — Port the active legacy timers to DBOS

- **P-001** `todo` Port **harness-status-sweep** (`apps/operator/lib/harness-status-sweep.ts:167`, 30s, started at `bin/host-bootstrap.ts:163`). Wrap the existing `tick()` (sweepAgentRunsRunning + sweepHarnessLanes) as `DBOS.registerWorkflow` + `registerScheduled({ crontab: '*/30 * * * * *' })`; add `dbosHarnessStatusSweepActive()` to `dbos-flags.ts` (default-on under the orchestrator gate); register in `bootstrap.ts`; stand `ensureHarnessStatusSweep()` down with `if (dbosHarnessStatusSweepActive()) return;`. No in-process state — clean port; this also proves the recipe. (M)
- **P-002** `todo` Port backup **orphan-cleanup** (`packages/backup/src/orphan-cleanup.ts:102`, 5m). Wrap `sweepOrphanSnapshots()` as `registerScheduled({ crontab: '0 */5 * * * *' })` in `bootstrap.ts`, gated by the existing `dbosTimersActive()`. NOTE this **revives** the job — its only current start site is the dead `instrumentation-node.ts:293`, so it isn't running today (D-003). Drop the legacy `startOrphanSweepWorker()` (handled in P-005). (S)
- **P-003** `todo` Port **device-push-credentials** refresh (`apps/operator/lib/device-push-credentials.ts:35`, 50m, started at `host-bootstrap.ts:144`). Wrap `refreshAll()` as a scheduled workflow (`'0 0 * * * *'` hourly is fine); add `dbosPushCredentialsActive()`. DBOS runs in the **same** operator process, so `refreshAll()` mutating `process.env.*_TOKEN` still takes effect; the step is naturally idempotent (re-mint is harmless). Stand `startPushCredentialRefresher()` down. (S)

## Phase 2 — Delete the dead scheduler code

- **P-004** `todo` Delete `apps/operator/lib/harness/wave-advance-sweep-live.ts` (and `wave-advance-sweep.ts` if it becomes unused) — RETIRED: commented out at `host-bootstrap.ts:168–177`, superseded by the orchestrator frontier (P-044). (S)
- **P-005** `todo` Delete the orphaned legacy maintenance **starters + their `setInterval` bodies**: `startTelemetryFlushWorker`, `startScratchGcScheduler`, `startMemoryCleanup`, `startEmbedBackfillWorker`, `startCompletionRefVerifier`, `startOrphanSweepWorker`, `startBackupScheduler` — all called **only** from the dead `instrumentation-node.ts`; DBOS owns each in the live host (D-001). Keep each module's single-run tick fn (the DBOS workflows call them). (M)
- **P-006** `todo` Delete `apps/operator/instrumentation-node.ts` (retired Next instrumentation hook; not imported by the live Hono host) — **after** confirming `bin/host-bootstrap.ts` covers the non-scheduler things it still nominally did (migrations `applyPendingMigrations`, auth init, hyperbee boot). Fix the now-stale "Wired from instrumentation-node.ts" doc-comments in `telemetry-flush.ts` / `scratch-gc.ts` / `memory/cleanup-worker.ts` / `search/embed-backfill.ts` / `dbos/bootstrap.ts` / etc. blocked-by: P-005 (M)
- **P-007** `todo` Decide `apps/operator/lib/pr-host/poll-daemon.ts` (60s, **never wired into bootstrap**, holds an in-memory `daemonState` backoff/seeding Map). Product call: is PR-host polling wanted? If yes → finish it as a DBOS workflow with backoff state in PG; if no/abandoned → delete it + its test. (S)
- **P-008** `todo` Investigate the ungated `setInterval` in `apps/operator/lib/provision/runner.ts`. Provisioning is now the DBOS `provision-workflow` (default-on); if this is the dead legacy claim/poll path, delete it, else gate it. (S)

## Phase 3 — Systemd timers + Set D dispositions

- **P-009** `todo` Port systemd **`papercup-test-runs-prune.timer`** (daily 04:17 UTC; prune `test_runs`, keep last 50) to a DBOS scheduled workflow (`'0 17 4 * * *'`); remove the `.timer`/`.service` units. Removes a user-session systemd dependency and co-locates DB maintenance with the operator. (S)
- **P-010** `todo` **Keep `llm-test-nightly.timer`** (daily 03:30) as **systemd**, NOT DBOS — a heavy external test-suite runner needing `ANTHROPIC_API_KEY`; it is not operator-process maintenance and running it inside the operator is the wrong shape (D-004). Document the reason at the unit. (XS)
- **P-011** `todo` Record the **Set D** keep-off-DBOS dispositions (D-002) here + a short agent-insight `schedulers-not-on-dbos`; add a one-line `// not a DBOS candidate: <reason>` at the few periodic-looking sites most likely to tempt a future porter (`harness-fs-watcher.ts` 60s reconcile backstop; `expirable-registry.ts` in-memory sweep). (S)

## Phase 4 — Verify

- **P-012** `todo` Integration-test each new scheduled workflow: fires once on schedule + survives crash-replay, mirroring `apps/operator/test/dbos-crash-replay.integration.test.ts`; assert the legacy stand-down so **exactly one** implementation fires. (M)
- **P-013** `todo` Live: restart the operator with `PAPERCUSP_DBOS_ENABLE=1`, confirm the 3 new scheduled workflows register (visible via `/admin/dbos` + the `dbos` schema), confirm boot is clean after the Phase-2 deletions, run `npm run test:affected`. blocked-by: P-001, P-002, P-003, P-006 (S)

## Decisions

### D-001 — DBOS is the live scheduler; the legacy maintenance timers are already A/B-dead
Date: 2026-06-03
`PAPERCUSP_DBOS_ENABLE=1` is set in `apps/operator/.env.local:68` and forced on for the desktop in `apps/operator/lib/gym/boot-spec.ts:76`. The live operator is the `operator-vite` + Hono host (`bin/host-bootstrap.ts`), which never imports `instrumentation-node.ts` (the retired Next instrumentation hook) — documented in agent-insight `dbos-durable-execution-gotchas` ("boot from the live host path, not the retired instrumentation hook"). The 7 legacy maintenance `start*Worker()` calls live only in that dead file, so deleting them is a runtime no-op; DBOS already owns those schedules. Pre-alpha (no users, no production) → delete the dead halves rather than keep A/B shims.

### D-002 — Set D stays off DBOS — an owned determination, not a punt
Date: 2026-06-03
Each Set-D site was evaluated against "could a periodic DBOS Node workflow correctly own this?" and the answer is no, for a concrete reason per category: **(a) All Rust schedulers** (`papercusp-desktop/src-tauri`, `papercup-rust-server`, `papercup-native`, `papercup-rust-mobile`) — DBOS is a Node/TS library and cannot run a Rust tokio/thread loop; the work is intrinsically runtime-bound (Axum SSE keepalive, PG `LISTEN` reconnect, PG/zero-cache process spawn+kill lifecycle, WebSocket/EventSource reconnect). **(b) Per-connection / per-request / per-spawn loops** — `expert-dispatcher.ts` (100ms result-file poll during one agent run), `pty-ws.ts` / `pty-bridge.ts` / `device-voice-ws.ts` / `voice-engines/deepgram.ts` keepalives, `run-command-sse.ts`, the `pty` route, `agent-tools/locks/acquire.ts` wait-poll, `voice-engine-health.ts` — each bound to a live in-process handle (socket / child process / session) that a detached periodic cron has no reference to; they are not crons. **(c) In-memory sweepers** — `expirable-registry.ts` sweeps a process-local `Map`; DBOS cannot see in-process memory (would only qualify if the registry moved to PG, out of scope). **(d) `sync/hyperbee/outbox-drain.ts`** — native at-least-once draining is the right fit; DBOS is a worse fit (existing plan D-006). **(e) UI** — `ui/use-ui-presence.ts` is a client React hook. **(f) Infra/CI** — 4 systemd *services* (mac VM, cloudflared ×2, pg-tunnel) and the `.github` nightly Actions cron are OS/platform-level, not operator work. The custom cron `routine-ticker.ts` (`libs/papercusp/libs/db`) is currently **not started in the operator** at all; reviving it under a DBOS tick is left to the paused git-sync work, which is what surfaced this audit.

### D-003 — orphan-cleanup is silently dead today; the port revives it
Date: 2026-06-03
`packages/backup/src/orphan-cleanup.ts` (marks `running` snapshot rows stuck >1h as failed) has its only `startOrphanSweepWorker()` call site in the dead `instrumentation-node.ts:293`. So in the live desktop it never runs — a latent gap. P-002 both ports it to DBOS and re-activates it by registering in the live `bootstrap.ts`.

### D-004 — test-runs-prune → DBOS; llm-test-nightly stays systemd
Date: 2026-06-03
`papercup-test-runs-prune` is operator-DB maintenance (prune a PG table) → it belongs in the operator's DBOS schedule (P-009), and porting removes a user-session systemd dependency. `llm-test-nightly` is a heavy external test-suite runner (needs `ANTHROPIC_API_KEY`, spawns the full LLM scenario tier) → it is CI-shaped, not operator-process work, and stays as a systemd timer (P-010).
