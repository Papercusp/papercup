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

**State:** Design captured from a coord-channel audit (2026-06-02), a follow-up to the shipped `named-resource-locks-drain-2026-06-02` plan. That plan solved the *lock-shaped* parallelism pain (stale-server tests, build clobbers, submodule owner-sync). This plan captures the recurring pain locks do NOT solve. No code written.

**Next:** human reviews scope + the open questions (notify source-removal vs opt-in, where main-health runs, native auto-apply yes/no, priority order) before implementation starts.

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
- **P-009** `needs-human` Decide where it runs (`/loop` / cron / the operator background loop / a git hook) + cadence. importance: normal
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

## Open questions
- **Notify** — confirm source-removal of `lock_acquired` (D-002) vs keeping it but never injecting. Lean: remove at source.
- **main-health** — where does it run + cadence (P-009)?
- **Native migration auto-apply** — opt-in, or never (P-007)?
- **Order** — lead with Phase 1 (notify de-noise) — highest leverage, lowest risk?
