---
title: Glossary
description: Terms used across the harness and these docs.
---

**Architect** · Role that resolves spec ambiguity when orchestrator emits `NEXT_ARCHITECT`. Read-only on source files; writes only `validation-contract.md`.

**Boil the lake** · Principle (gstack-inspired) requiring roles to do fewer things perfectly rather than many things mediocrely.

**Branch isolation** · Per-feature `harness/<fid>` git branches off `baseBranch`. With `useWorktrees: true`, each branch lives in its own filesystem dir.

**Checkpoint** · Hermes-inspired named human-gated pause. Distinct from escalation: checkpoint = "hit a milestone, please approve"; escalation = "stuck."

**Competition mode** · Conductor-inspired same-feature race. N workers attack the same feature in sibling worktrees; validator picks a winner.

**Crosscheck** · Optional second-validator pass with a different model (e.g. validator runs Opus, crosscheck runs Sonnet). Catches confidently-wrong validator decisions.

**Curator** · Role that compacts memory. Promotes `raw.md` entries to `summary.md` / `MEMORY.md` / `identity/<role>.md`. Only role allowed to delete memory.

**Debugger** · Fires when `attempts >= threshold` for a failing feature. Investigates root cause; writes `debug/<fid>.md`.

**Decision verb** · Single-line output from the orchestrator each iteration. One of: `DONE`, `NEXT_WORKER`, `NEXT_VALIDATOR`, `NEXT_ARCHITECT`, `CONVERTED`, `ESCALATE <reason>`, `CHECKPOINT <name>`.

**Documenter** · Role that produces user-facing docs after a feature passes. Writes into the Restart docs (Fumadocs at `apps/web/content/docs/`), not the Papercup docs you're reading now (Fumadocs at `apps/papercup/content/docs/`).

**Escalation** · Mission halt with `escalation.md` describing the blocker. Run.sh exits 3.

**Evidence rule** · claudecode-orchestrator-inspired rule that every PASS claim must be accompanied by quoted source output.

**Feature** · One row in `.harness/features.json` with `id`, `title`, `claims[]`, `status`, `attempts`. Features may be original (planner-created) or `F-FIX-NNN` (curator+orchestrator-promoted from validator issues).

**Ghost** · An orchestrator output that doesn't parse as a known decision verb. Tracked as `ghostRate` in `/decisions`. Ghost rate ≥ 10% triggers a `low_ghost_rate` health check failure.

**Health check** · One of 9 signals at `/api/harness/:slug/health`. Composite OK = all 9 pass.

**Identity file** · `~/autonomous-harness/identity/<role>.md`. Cross-mission append-only memory per role.

**Issue** · Validator-flagged problem outside the current feature's claim scope. Lives in `.harness/issues.json`. Curator dedupes; orchestrator may promote to `F-FIX-NNN` features via `CONVERTED`.

**Lane** · One parallel worker slot. With `parallelWorkers.max: 3`, three lanes run concurrently. With `mode: competition`, all lanes attack the same feature.

**Mission** · One run of `run.sh` for a project. Multiple iterations until DONE / ESCALATE / CHECKPOINT / cost-cap / max-iter.

**Orchestrator** · Role invoked every iteration. Reads state, emits one decision verb. Designed to be the only role that picks "what next."

**Plan-reviewer** · Gate role that fires after planner. VERDICT line determines accept / accept-with-notes / reject.

**Planner** · Role that creates `features.json` + `validation-contract.md` from `SPEC.md`. Fires once per mission.

**Prompt cache** · Anthropic's cache of stable prompt prefixes. We design for ~99.94% cache hit rate.

**Product role** · Autonomous scope-expansion role. Diffs `GOAL.md` against `SPEC.md`; writes proposals.

**Raw memory** · `.harness/memory/raw.md`. Append-only one-liner observations from any role.

**Smoke test** · Service-level URL check via `bin/service-smoke-test.sh`. Optional gate on `DONE` or each feature pass.

**Snapshot** · State capture at iteration boundary. Lives in `.harness/snapshots/<ts>-iter-NNN/`. Restorable via UI.

**Summary memory** · `.harness/memory/summary.md`. Curator-maintained, capped at 40 lines / 800 tokens. Auto-injected into every role's prompt.

**Supervisor** · External-cron role that wakes periodically and writes intervention notes. Not part of the inner loop.

**TRICK:** · Worker prompt convention for flagging generalisable observations in `raw.md`. Curator promotes confirmed tricks to `identity/worker.md`.

**UI-QA** · Real-browser verification role. Fires for features with `VAL-UI-*` claims. Uses `verdict` CLI.

**Validator** · Role that adversarially verifies feature claims. TDD iron law + evidence rule. Default disposition: reject.

**VAL-XXX-NNN** · Claim id in `validation-contract.md`. Format encodes domain (e.g. `VAL-AUTH-001`) and number.

**Worker** · Role that implements features. Reads contract, writes code, runs its own tests, sets status to `validating`.

**Worktree** · git worktree at `.harness/worktrees/<fid>/`. One per feature when `useWorktrees: true`.

## Org layer terms

**ACTIONS contract** · Structured `actions` block emitted by an autonomous-loop worker. Backend executes each op (`send_message`, `mark_message_status`, `spinup_project`, `add_directive_summary`) sequentially. Charter validation runs server-side; a failed op aborts the iteration.

**Auto-loop** · Per-dept toggle in `~/org-{dept}/.harness/director-config.json`. When `true`, the server-side scheduler fires `run-loop` every `autoIntervalSeconds` (30–3600). Editable via `PUT /api/org/:dept/director-config`.

**CEO mode** · Worker variant for the Business director when handling a `Directive` kind. Different prompt overrides; emits routing decisions (which depts to engage, which projects to spin up) instead of a regular Decision/Priority.

**Charter** · Governance markdown at `~/.restart-org/charter.md` — read by every director on every run via symlink. Defines the 5 fixed departments, message kinds, and validation rules. Read-only in the Department Harness UI; edit via `PUT /api/org/charter`.

**Mission** · Eternal top-level north-star at `~/.restart-org/mission.md` — read by every director on every prompt run, injected before the charter. Default: "Make money." Editable via `PUT /api/org/mission` or the Mission panel on the Organization tab. R&D's worker prompt is explicitly tied to advancing the mission via Proposal generation.

**allowedActions** · Per-dept whitelist of ACTION ops the dept's worker is permitted to emit (charter-symmetric with `outboxKinds` for messages). Validated at `executeAction(action, callingDept)`. Defaults: Business gets full set including spinup_project + scaffold_harness; Management gets scaffold_harness + pause/resume; Tech gets scaffold_harness; R&D send-only; Marketing gets mark_campaign_published.

**Department director** · One of 5 LLM-backed agents (Business, R&D, Technology, Management, Marketing). Each runs as a `claude -p` subprocess with a per-role + per-dept resolved prompt + live state injected.

**Director memory** · Synthesized block of the dept's last N director-run records (when / decision keyword / first action / final outcome). Injected into every prompt as "Recent decisions (your own memory, newest first)" so directors notice their own patterns.

**Directive** · User-issued top-level direction (`POST /api/org/directives`). Auto-emits a `Directive` kind message to Business; CEO-mode routes it into one or more projects via spinup.

**Discarded folder** · `libs/papercup-shared/src/_discarded/` — components removed from active use but kept for revival. Not exported, not imported. Each entry has a sibling README explaining why removed and how to revive.

**Health snapshot** · `GET /api/org/health-snapshot` — composite single-fetch JSON for the operations cockpit (depts + active runs + backlog by status + last 20 audit). Used by the Harnesses page polling.

**Project (org)** · A strategic container with `slug`, `vertical`, `status`, `owning_director`, `budget_cents`, `metadata`. Distinct from a coding-harness project; usually they share a slug (e.g. `sheets`).

**Reserved project** · `platform-reserved` (Tech cross-cutting Capability/PlatformUpdate) and `org-ops-reserved` (governance / cross-project messages without a specific home). Default targets when a message is sent without an explicit `projectId`.

**Scheduler heartbeat** · `GET /api/org/schedulers` returns each active scheduler's `secondsRemaining` until next fire. Server-side; survives all browsers closing.

**Stale department** · Dept with `inboxPending > 0`, no auto-loop, and no run in the last hour. Surfaced as an amber badge — *was* on the Health page; UI control moved to per-dept Director Agent tab as of round 39.

