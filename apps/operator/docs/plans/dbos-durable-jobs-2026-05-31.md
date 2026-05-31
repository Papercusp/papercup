---
title: Adopt DBOS Transact for durable background jobs + orchestrator durability
slug: dbos-durable-jobs-2026-05-31
status: ready
created: 2026-05-31
updated: 2026-05-31
owner: avi@storewolf.com
---

# Adopt DBOS Transact for durable background jobs + orchestrator durability

## Now

**State:** Phase 0 substantially done. The P-002 cross-version resume **gate PASSED** against a real embedded-postgres-server PG16 (D-013): DBOS creates its `dbos` schema, completed steps aren't re-run on resume, an unpinned app-version change leaves prior workflows PENDING, and pinning recovers them. P-001 integration code is **committed (0443ccb7)** — `lib/dbos/bootstrap.ts` + `hello-workflow.ts` + a default-off, dynamic-import `PAPERCUSP_DBOS_ENABLE=1` boot block in `instrumentation-node.ts` + the `@dbos-inc/dbos-sdk` dep. In-operator activation is **blocked** on an unrelated workspace breakage: `@papercusp/chat-protocol` is unpublished and fails `npm install` (another agent's in-flight rename).

**Next:** Once the `@papercusp/chat-protocol` install breakage clears: `npm install`, reconcile the lockfile, set `PAPERCUSP_DBOS_ENABLE=1`, verify the `dbos` schema + `helloWorkflow` boot in-operator — then start Phase 1 (P-003 AutoLoop migration).

## Background

Papercusp's background work today runs as **in-process timers**, the most load-bearing being the **AutoLoop
ticker** (`apps/operator/lib/autoloop.ts`, ~30s, `PAPERCUSP_AUTOLOOP_TICK_MS`) that fires per-harness
director / coordinator / auditor roles and records outcomes to `harness_shared.autoloop_state`. The same
shape covers the operator scanner, embeddings/semantic indexing, snapshots/backups, and several smaller
workers (see P-008 for the full inventory). These timers share three weaknesses:

1. **No durability** — they die with the process and resume from nothing; a crash mid-run is silently lost.
2. **No real retry contract** — failures bump a `consecutive_errors` counter but there's no backoff, no
   dead-letter, no max-attempts.
3. **No observability** — no durable record of what ran, when, why it failed.

(A fourth oft-cited weakness — cross-process double-fire — is largely a **dev-box artifact**: production runs
one operator sidecar per workspace, so two processes rarely race. The dedup-ID design below makes single-fire
correct anyway, cheaply, but we don't oversell it as a production motivation.)

This came out of evaluating how **Restart** uses **BullMQ** (Redis, 18 queues in `shop-api` for
transactional side-effects). BullMQ is right for Restart (a server already running Redis) and wrong for
Papercusp: the public product ships as a **desktop app + embedded Postgres only** (`~/.papercusp/embedded-pg.json`,
resolved via `getHarnessAdminUrl()`); bundling Redis in every install breaks that topology. We surveyed the
Postgres-backed field — three options need zero infra beyond the embedded PG: pg-boss, graphile-worker, DBOS
Transact (full survey in **Alternatives considered**). We chose DBOS for durable execution.

**Related plans:** `papercusp-systems-abstraction-2026-05-29` (keep the harness core in-tree),
`production-readiness-test-coverage-2026-05-30` (P-010 orchestrator cancellation + orphaned-run cleanup;
D-007 JSONB durable-state corruption) — Phase 3 must reconcile with both.

## Decisions

### D-001 — Adopt DBOS Transact; reject BullMQ, pg-boss, and graphile-worker
Date: 2026-05-31
DBOS is **durable execution**, not merely a queue. Its queue is already full-featured (global + per-worker
concurrency, rate limiting, priority, deduplication IDs, delayed enqueue, cron via scheduled workflows,
step retries with backoff), so we give up no background-job capability we'd use. What it adds over
pg-boss/graphile-worker is **step-level checkpointing with automatic resume after a crash** and **workflow
composition** — which map onto Papercusp's differentiator: long, expensive, stateful agent runs on a desktop
app users quit/sleep/close mid-run. BullMQ is rejected (needs Redis). pg-boss/graphile-worker solve only the
easy half (timers), leaving orchestrator resume unaddressed; pg-boss is retained as the **Tier-A fallback**
if DBOS disappoints. Backing: DBOS Inc., MIT, v4, frequent releases (founders incl. Michael Stonebraker).
Related: P-001, P-002

### D-002 — No new infrastructure: DBOS runs on the existing embedded Postgres
Date: 2026-05-31
DBOS connects to the embedded PG via the existing discovery path (`getHarnessAdminUrl()` /
`~/.papercusp/embedded-pg.json`) — **never a hardcoded port** — with its system tables in a dedicated `dbos`
schema. Keeps the "desktop + embedded-pg only" topology intact; nothing new for a user to install.
Related: P-001

### D-003 — Two tiers, sequenced; Tier B approved but still gated behind Tier A
Date: 2026-05-31
**Tier A (Phases 0–2):** durable *background jobs* — replace the timers. Low risk, reversible-by-flag (D-011).
**Tier B (Phase 3):** durable *execution of the agent orchestrator* — resume the agent pipeline from the last
completed step. Tier B is now **approved** (D-012), but sequencing is unchanged: **ship Tier A first**; Tier
B's design spike (P-014) starts only after Phase 0 proves the substrate. Its true cost is workflow-versioning
discipline (D-008), accepted in D-012.

### D-004 — DBOS does not replace the LLM-driven orchestrator routing
Date: 2026-05-31
The orchestrator's value is the LLM deciding *what next* (`NEXT_WORKER`, `NEXT_VALIDATOR`, `ESCALATE`). DBOS
wraps the *execution* of that decision as durable, resumable steps; it does not turn dispatch into a dumb
FIFO queue. Workflows branch on runtime data (incl. LLM output), so dynamic routing survives. P-014's spike
must demonstrate this.
Related: P-014

### D-005 — Idempotency is still designed at step boundaries
Date: 2026-05-31
Durable execution makes the workflow's **control flow** exactly-once and resumable. It does **not** make an
external side effect (`git push`, an LLM call, an outbound message) idempotent — a crash *during* one is the
classic at-least-once boundary. Every step that touches the outside world is written idempotently. DBOS
reduces this burden; it doesn't erase it.

### D-006 — Polling latency (~1s) is acceptable; not for latency-sensitive paths
Date: 2026-05-31
DBOS workers dequeue by polling (~1s default), unlike graphile-worker's LISTEN/NOTIFY. Fine for cron/background
work and minutes-long agent runs. We do **not** adopt DBOS for any sub-second interactive dispatch; those keep
their existing SSE/in-process mechanisms.

### D-007 — Prune the dead Redis/BullMQ dependencies
Date: 2026-05-31
`bullmq`, `@nestjs/bullmq`, `ioredis` (root `package.json`) and `redis` (`apps/operator/package.json`) are
declared with **zero source usage** (only compiled `.next` artifacts reference them). Inherited dead weight;
remove as part of this work.
Related: P-012

### D-008 — App-version recovery is the real gate; pinning is safe for timers, hazardous for the orchestrator
Date: 2026-05-31
DBOS tags each workflow with an **application version** (a checksum of workflow code, overridable via
`DBOS__APPVERSION`) and, self-hosted without Conductor, **does not recover workflows whose version differs
from the running binary** — they sit `PENDING`, silently. This breaks the headline case (quit mid-run → update
the desktop app → reopen: the new binary won't auto-recover the old-version workflow). **Tier A policy:**
(a) the Phase-0 gate tests *cross-version* resume, not same-binary (P-002); (b) for background jobs we **pin
`DBOS__APPVERSION` to a stable value** — safe because a timer workflow body is trivial (fire a tick), so
running old-shape under new code is low-risk. **Tier B is not that simple, and the pin is not a free win.**
Resuming a long checkpointed *orchestrator* workflow whose code changed underneath it is the classic
durable-execution determinism hazard: DBOS replays by **step order/identity**, so reordered/renamed steps
reattach a resumed run to the **wrong checkpoint** (exactly what Temporal forces you to handle with
`patched()`/versioning). Tier B's real options are therefore **(i) pin + adopt workflow-versioning
discipline** — you owe a patching strategy for every incompatible change to the pipeline — or **(ii) recover
same-version only**, accepting that in-flight orchestrator runs from *before* an app update do **not**
auto-resume. The owner has chosen **(i)** (D-012); P-014's spike validates it on the real pipeline.
Related: P-002, P-014

### D-009 — Scheduled-workflow catch-up policy: explicitly select skip-missed
Date: 2026-05-31
DBOS scheduled workflows can backfill missed intervals via opt-in modes (`ExactlyOncePerInterval` /
`automaticBackfill: true`); DBOS docs frame these as things you *configure*, which indicates skip-missed is the
default — **but neither this plan nor the reviewer should encode a version-specific default as fact; P-003's
spike confirms the actual default before we rely on it.** A 30s ticker on a laptop closed overnight must not
fire thousands of backfilled ticks at launch. **Policy (independent of whatever the default turns out to
be):** AutoLoop and the other high-frequency tickers **explicitly select skip-missed** (run the next tick
only); backfill is enabled per-schedule **only** where a missed run genuinely must run (e.g. a daily backup may
want at-most-one catch-up). P-003 tests the closed-for-hours-then-reopen case explicitly.

### D-010 — Single-fire comes from the deduplication ID, not concurrency=1
Date: 2026-05-31
`concurrency = 1` only *serializes* execution — it does not stop N duplicate enqueues running back-to-back.
The single-fire guarantee comes from the **deduplication ID** (only one workflow with a given dedup ID may be
enqueued/active at once). Tickers enqueue with a dedup ID keyed on `(harness_slug, role, interval-bucket)`;
`concurrency = 1` is a secondary serializer, not the guarantee.
Related: P-004

### D-011 — Tier A is flag-gated and reversible by flip, not git-revert
Date: 2026-05-31
"Reversible" is only true if rollback is a flag flip. Gate DBOS behind the repo's feature-flag system
(`flags:*`) and keep the existing timer path live **through Phase 1**, so we can A/B and revert instantly. This
is a **temporary migration flag**, not a permanent compatibility shim: Phase 2 (P-013) deletes **both** the old
timer path and the flag once validated — consistent with the pre-alpha "no compatibility aliases" ethos.
Related: P-005, P-013

### D-012 — Phase 3 gate APPROVED: route the agent orchestrator through DBOS too
Date: 2026-05-31
Owner decision (2026-05-31): route **everything** through DBOS — not just background jobs but the agent
pipeline itself. Tier B is a go. The intent is full crash/quit resume *including across app updates*, which
requires **option (i) of D-008: pin `DBOS__APPVERSION` + adopt a `patched()`-style workflow-versioning
discipline** for every incompatible change to the pipeline. The ongoing maintenance cost of that discipline is
**explicitly accepted** as the price of cross-update orchestrator resume. The P-014 spike validates the
discipline is workable on the real pipeline and falls back to option (ii) (same-version-only) **only** if (i)
proves untenable. Sequencing is unchanged: Tier A (Phases 0–2) ships first; Tier B starts after Phase 0.
Related: P-014


### D-013 — Phase 0 gate PASSED + integration committed; in-operator activation blocked on chat-protocol
Date: 2026-05-31
The P-002 cross-version resume **gate passed** against a real embedded-postgres-server PG16 instance (DBOS v4.18.10, isolated probe in /tmp/dbos-probe): DBOS creates its `dbos` schema; a completed step is **not** re-run on resume; an `applicationVersion` change without pinning leaves the prior workflow **PENDING** (the D-008 hazard, empirically confirmed); pinning the version recovers it to **SUCCESS** with no double-execution. So the gate is clean — Phase 1 is unblocked on the substrate.

P-001 integration code is **committed (0443ccb7)**: `apps/operator/lib/dbos/bootstrap.ts` (functional API, resolve DSN via `getHarnessAdminUrlWithSource()`, refuse `native-fallback`, schema `dbos`, pinned `applicationVersion`, idempotent single launch) + `hello-workflow.ts` + a `PAPERCUSP_DBOS_ENABLE=1` (default-off, dynamic-import) block in `instrumentation-node.ts`, plus the `@dbos-inc/dbos-sdk` dep.

Refinement: the boot **launch** is env-gated (matching the other instrumentation workers) rather than PostHog-flag-gated — the `flags:*` A/B gate (D-011) belongs in Phase 1 with the AutoLoop *runtime*, not the boot launch (no async flag read at startup).

Two findings that revise earlier assumptions: v4.18 config exposes **`useListenNotify`** (DBOS can use LISTEN/NOTIFY, not poll-only — softens D-006's "~1s poll" caveat) and **`enablePatching`** (first-class `patched()` for the D-008/D-012 versioning discipline — confirms option (i) is supported).

**BLOCKER:** in-operator activation (workspace `npm install` + lockfile reconciliation + flip-the-flag boot verify) is gated on an **unrelated** breakage — `@papercusp/chat-protocol` (referenced by `packages/tooldef` + `libs/chat-protocol`, another agent's in-flight scout-convergence rename) is unpublished, so `npm install` fails E404. The committed boot block is dynamic-import + default-off, so it is fully inert until that clears.
Related: P-001, P-002

## Phase 0 — Spike & validation (GATE)

Prove the two things the plan rests on before anything else: DBOS runs on the embedded PG, and it resumes a
workflow **across an application-version change** (not just a same-binary restart).

- **P-001** `todo` Bootstrap DBOS against the embedded PG. Use the **functional API**
  (`DBOS.registerWorkflow` / `DBOS.runStep`), **not** decorators — the operator transpiles under tsx/esbuild
  (`:3070`) and Next/SWC (`:3055`), which handle decorators inconsistently. Call `DBOS.launch()` **exactly
  once**, in the non-HMR Node host (`apps/operator/instrumentation-node.ts`, where the other workers boot),
  with a clean shutdown on Tauri quit so HMR can't re-register/leak pollers. Resolve the connection via
  `getHarnessAdminUrl()` and **fail loudly if no embedded-pg discovery file exists** rather than silently
  hitting the dead native `:5432` (`papercusp_legacy`) fallback. Confirm system schema = `dbos`, embedded PG
  `max_connections` headroom (DBOS pool + ~1s/queue pollers on top of per-harness LRU pools (cap 8) + admin +
  scanner + SSE), and track the **DBOS system-schema migration on SDK upgrade together with the D-008 version
  pin** — DBOS migrates its own `dbos` schema at launch and that schema can change across SDK versions, so the
  two interact; resolve them as one concern, not separately. (S)
- **P-002** `todo` **GATE — cross-version crash-resume.** Enqueue a 3-step durable workflow under binary A
  (app version V1); change the workflow code and run binary B (app version V2); confirm the V1 workflow is
  recovered per the D-008 policy (pinned `DBOS__APPVERSION` or an explicit on-boot recover-prior-version
  step), **not** left silently `PENDING`. Same-binary `kill -9` resume is a sub-case, not the gate. This is a
  **one-time documented manual spike** for the gate (it needs two built binaries + a kill/restart dance — not
  standing CI coverage; don't over-promise it as automated); per the four-frameworks rule, any helper must not
  be an orphaned `.mjs` that CI lint rejects. If cross-version resume can't be made clean on embedded PG,
  **stop** and reconsider (pg-boss covers Tier A). blocked-by: P-001 (M)

## Phase 1 — Migrate the AutoLoop ticker (proof of concept)

Smallest target, highest payoff — the most load-bearing timer.

- **P-003** `todo` Model the AutoLoop tick as a **DBOS scheduled workflow** (cron) replacing the timer in
  `autoloop.ts`, preserving the per-harness `.harness/director-config.json` + `autoIntervalSeconds` cadence.
  **Explicitly select skip-missed** catch-up (D-009 — confirm the actual default in-spike, then set it
  deliberately rather than relying on it); test that closed-overnight-then-reopen produces **one** tick, not
  thousands. blocked-by: P-002 (M)
- **P-004** `todo` Fire per-harness director / coordinator / auditor via a **DBOS queue**, single-fire via a
  **deduplication ID** keyed on `(harness_slug, role, interval-bucket)` (D-010), with `concurrency = 1` per
  `(harness_slug, role)` as a secondary serializer; keep writing outcomes to `harness_shared.autoloop_state`
  as today. Verify single-fire with two processes against one embedded PG. (M)
- **P-005** `todo` Flag-gate the new path (D-011): put DBOS behind a `flags:*` flag and keep the existing
  `setInterval` AutoLoop live behind the flag so Phase 1 can A/B and revert by flip. (S)
- **P-006** `todo` Retry/backoff + dead-letter: map `consecutive_errors` onto DBOS step retries
  (`retriesAllowed` + backoff) and a bounded recovery cap (terminal error state surfaced for triage). (S)
- **P-007** `todo` **Add a DBOS tab to the `/admin` route** with a view into the events: workflow runs, queue
  state, and the per-workflow **step/event timeline** (running / failed / retrying / recovered), with filters
  by queue + status. **Local PG-query-backed** — read DBOS's `dbos` system tables directly — and explicitly
  **not** DBOS Conductor (their cloud dashboard would reintroduce the external dependency this plan exists to
  avoid). Follows the existing `/admin` tab pattern; tab + filter selection in **nuqs** (URL-backed) per repo
  convention. Optionally wire DBOS's built-in OpenTelemetry traces into existing telemetry. (M)

## Phase 2 — Migrate the remaining background timers

Once Phase 1 validates the pattern, fold the rest in — but first define "the rest".

- **P-008** `todo` **Enumerate every background timer and classify each migrate / stay-and-why** (the
  definition-of-done for Phase 2). Known set: `lib/autoloop.ts` (Phase 1), the operator scanner,
  embeddings/semantic indexing, `lib/backup/orphan-cleanup.ts` (snapshot reaper), `lib/telemetry-flush.ts`,
  `lib/memory/cleanup-worker.ts`, `lib/harness-status-sweep.ts` (stale agent-run reaper), `lib/harness/completion-ref-verifier.ts`,
  and `lib/harness-fs-watcher.ts` (**stays event-driven — must NOT become a poller**). Output: a table of
  timer → decision. (S)
- **P-009** `todo` Operator scanner → scheduled workflow + queue (mutual exclusion via dedup ID, replacing the
  scan-lock dance). (M)
- **P-010** `todo` Embeddings / semantic indexing → queue with **rate limiting** (`limitPerPeriod`) so
  re-index storms don't hammer the embedded PG or the embedding API. (M)
- **P-011** `todo` Snapshots / backups + the remaining migrate-classified timers from P-008 → scheduled
  workflows / queues (a backup may justify at-most-one catch-up per D-009). (M)
- **P-012** `todo` Remove the dead `bullmq` / `@nestjs/bullmq` / `ioredis` / `redis` deps (D-007); reconcile
  the lockfile so `npm ci` stays green. (S)
- **P-013** `todo` Once Phase 1 + 2 are validated in production, **delete the old timer paths and the
  migration flag** (completes D-011). (S)

> **Excluded — not a background timer:** "doc-build" is `npm run build` from `apps/operator-docs`, run manually
> / at operator build, not a `setInterval`/cron job. Verified; nothing to migrate.

## Phase 3 — Orchestrator durability (gate APPROVED, D-012)

The high-value tier. The gate is passed (D-012 — route the orchestrator through DBOS); it stays sequenced
after Phase 0 proves the substrate, and it touches the live orchestrator + its run-state machinery, so land it
carefully.

- **P-014** `todo` **Design spike (gate approved, D-012):** wrap the
  scoper→architect→worker→validator→reviewer pipeline as a DBOS durable workflow, each `invoke()` a checkpointed
  step. Spike one feature's pipeline; quit the operator mid-`worker`; confirm restart resumes at `worker`
  without re-running `scoper`/`architect`. **Implement option (i) of D-008** — pin + a `patched()`-style
  versioning discipline for incompatible pipeline changes — to get true cross-update resume; fall back to (ii)
  same-version-only **only** if the discipline proves untenable. Demonstrate a resumed run never reattaches to
  the **wrong checkpoint**, and that dynamic LLM routing survives (D-004). blocked-by: P-002 (L)
- **P-015** `todo` Reconcile run-state ownership so the DBOS workflow is the single source of truth for "is
  this pipeline running": re-scope the in-memory **lane pool** (`lanes.ts`, persisted to `lanes.json` — the UI
  reads that file, so the replacement must preserve that surface), the **agent-run reaper**
  (`lib/harness-status-sweep.ts` — stale `agent_runs.running` + `harness_lanes`, PID-liveness), and the
  `harness_shared.spawned_agents` status transitions, to avoid double-ownership (cross-ref
  `production-readiness-test-coverage-2026-05-30` P-010). Note: `backup/orphan-cleanup.ts` is the *snapshot*
  reaper and is out of scope here. blocked-by: P-014 (L)
- **P-016** `todo` Reconcile with the distributed **orchestrator-claim** arbitration in the dogfood plans
  (Autobase merge-order / Hypercore claim): decide how a DBOS workflow ID relates to a feature claim so the two
  don't fight over "who owns F-NNN". blocked-by: P-014 (L)
- **P-017** `todo` **Extend the `/admin` DBOS tab (P-007) to surface orchestrator pipeline workflows:**
  per-feature pipeline run, current / last-completed step, and resume status after a restart — so a recovered
  (or stuck-`PENDING`, version-mismatched) agent run is visible, not silent. blocked-by: P-014 (M)

## Risks & open questions

- **App-version recovery across upgrades (resolved into D-008 + D-012 + P-002).** The single sharpest risk;
  Phase-0 gate proves cross-version resume, D-012 commits to option (i)'s versioning discipline, P-014 proves
  it on the real pipeline. If the discipline turns out untenable, Tier B falls back to same-version-only.
- **Embedded-PG migrations on app upgrade.** DBOS migrates its own `dbos` system schema at launch and that
  schema can change across SDK versions, so this **interacts with D-008 version pinning** — resolve the two
  together in P-001, not separately.
- **Throughput ceiling.** Step checkpointing amplifies PG writes, capping throughput below graphile-worker — a
  non-issue at our volume (handful of jobs/min), noted so nobody points DBOS at a firehose.
- **Ecosystem maturity.** DBOS is younger (~53k weekly npm DL vs pg-boss ~637k). Mitigation: Tier A is small,
  flag-gated, and reversible — pg-boss is a drop-in for the background-job half if DBOS disappoints.
- **Connection budget.** DBOS's pool + per-queue pollers on top of the existing pools — *confirm headroom in
  P-001.*

## Alternatives considered

| Option | Why not (for Papercusp) |
| --- | --- |
| **BullMQ** (Restart's choice) | Needs Redis — a new bundled process per desktop install; breaks "embedded-pg only". |
| **pg-boss** | Excellent, mature, zero-infra — but a pure queue. Solves Tier A only; nothing for orchestrator resume. The fallback if DBOS disappoints. |
| **graphile-worker** | Same as pg-boss, plus sub-ms LISTEN/NOTIFY we don't need. Still no durable execution. |
| **pgmq** | A Postgres *extension* — shipping/compiling it into the embedded PG is the bundling friction we avoided by skipping Redis. |
| **pg-workflows / pgflow** | Durable workflows on PG, but immature/single-maintainer or Supabase-coupled. |
| **Hatchet / Windmill / Trigger.dev / Temporal** | Separate servers (often +RabbitMQ / +Redis / +S3). Heavy to bundle in a local-first desktop app. |
| **Inngest / Agenda / Faktory** | Cloud-first, or reintroduce Mongo / a standalone daemon. |

**Chosen: DBOS Transact** — the only zero-extra-infra option covering *both* tiers (background jobs now,
orchestrator durability later) on the Postgres we already ship.
