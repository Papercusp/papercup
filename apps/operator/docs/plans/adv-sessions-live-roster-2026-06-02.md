---
title: Sessions tab — live all-psu-agent roster (heartbeat-backed)
slug: adv-sessions-live-roster-2026-06-02
status: draft
created: 2026-06-02
updated: 2026-06-02
owner: avi@storewolf.com
---

# Sessions tab — live all-psu-agent roster (heartbeat-backed)

## Now

**State:** Draft — design complete (functionality + UI), grounded in the live code. Awaiting review of the two load-bearing decisions before Phase 1.

**Next:** Human reviews D-001 (the `adv_sessions` ↔ `coord_presence` join key) and D-003 (merge vs separate tab); then Phase 1 (P-001, `coord_owner_id`) begins.

## Background

### The problem / why now

The `/adv` "sessions" tab today shows only **plan-tied terminal launches** (the `adv_sessions` table), grouped by plan. Free / ad-hoc psu agents — the SU engineer shells, anything not launched against a plan — and the **live state** of every agent (what it's doing, which files it's on) aren't visible.

As of commit `d33d07837`, **`coord:inbox` bumps a presence heartbeat on every tool call**, so `harness_shared.coord_presence` is now a *complete, fresh* roster of every active psu agent — carrying its declared intent + current files. That's the missing live layer. This plan expands the sessions tab into a live "who's active, on what, touching which files" view, while keeping the existing plan-grouped interface for plan-associated agents (which the user confirmed is good).

It is also the human-facing twin of the `holder_intent` / `holder_focused` added to lock blocks (commit `14bb9fb0c`): the same presence data, surfaced as a dashboard instead of just-in-time on contention.

### Current state (grounded)

- **Tab component:** `apps/operator/app/adv/sessions/AdvSessionsClient.tsx` (rendered in the Vite SPA via the `@/app` alias; `AdvShell` tab config at `apps/operator-vite/src/components/adv/AdvShell.tsx:52`, already `supportsAll: true`).
- **Data:** `GET /api/adv/sessions` → `listAdvSessions(200)` over `harness_shared.adv_sessions`; polled every **3s** while visible; grouped by `plan_slug` (harness derived via plan→harness); pid-liveness via `/api/adv/sessions/alive?pid=N`.
- **`adv_sessions`** (`apps/operator/lib/ensure-schema.ts:1965`): durable psu-launch record — `plan_slug`, `agent` (claude/codex/omp), `role`, `feature`, `pid`, `omp_thread_id`, `started_at`, `ended_at`. Plan-tied; **not** a general live roster.
- **`coord_presence`** (the new live layer, `ensure-schema.ts:1777`): `owner_id` PK, `owner_label`, `source`, `intent`, `current_plan_slug`, `current_files`, `host`, `pid`, `started_at`, `heartbeat_at`. `stale` = `heartbeat_at` older than `PRESENCE_STALE_MS` (10m). Read via `listPresence()` / `GET /api/coord/presence` (`{active, stale}`); LEFT JOINs `power_user_sessions` for `user_id` / `revoked`.
- **Reuse candidate:** `apps/operator/app/coord/CoordDashboard.tsx` already renders active + stale presence — extract its row/section into a shared component.
- `formatRelativeUpdated` (`@/lib/format/relative-time`) + the existing agent badges are already in the tab.

### Data model & the join

`coord_presence` is keyed by **`owner_id`** (the coord identity: `PAPERCUSP_SID` for Claude/Codex SU, `omp-<auth>-<pid>` for OMP). `adv_sessions` is keyed by a `bigserial id` with **no owner column**, so the two don't join cleanly today — this is the one real design dependency (see D-001).

**`coord_presence` is the primary live roster** (every active agent, plan + non-plan); `adv_sessions` is the **enrichment** (plan/role/feature + durable history incl. ended sessions) joined where possible. An agent with no `adv_sessions` row (a plain SU shell) still appears from presence; a plan-tied agent gets the richer metadata and the existing grouped view (see D-002).

### Functionality (data layer)

- A merged roster endpoint (extend `GET /api/adv/sessions` or add `GET /api/adv/roster`) returns, per active agent: `{ owner_id, label, source, intent, current_files, current_plan_slug, host, pid, heartbeat_at, liveness, user_id }` + the `adv_sessions` enrichment (`plan`, `role`, `feature`, `started_at`, `ended_at`) when joinable, plus recent ended `adv_sessions` rows for the durable history.
- **Liveness** is derived from `heartbeat_at`, **not** `adv_sessions.pid`: `live` < ~60s · `idle` < `PRESENCE_STALE_MS` · `stale` ≥ `PRESENCE_STALE_MS`. Keep the pid check as a *secondary* signal and surface any presence↔pid discrepancy (zombie / orphan).

### UI design

- **Two sections** (preserve + extend):
  1. **Plan-associated** (`current_plan_slug` set) → the existing plan-grouped collapsible view, now driven by the merged model (liveness from presence).
  2. **Other active agents** (no plan) → new section: ad-hoc SU / engineer shells, grouped by harness/workspace or flat.
- **Per row:** a **3-state liveness dot** (live <60s · idle <10m · stale) + "active Ns ago"; a **source** icon (claude/codex/omp); `owner_label`; the **declared intent** one-liner; **`current_files`** as chips (the live "who's on X" map); plan/role/feature link when present; host/pid.
- **Filters:** client, liveness, harness/workspace, has-plan vs none; a "who's editing `<file>`" lookup off `current_files`.
- **Detail pane:** reuse the existing `SessionDetail`; add a presence panel (intent, current_files, heartbeat timeline) for agents lacking an `adv_sessions` row.
- **Real-time:** poll the merged endpoint every **3–5s** while visible (match the existing poll; pause when hidden). **No per-heartbeat SSE** — heartbeats are too frequent to push individually.
- **Reuse:** a shared `PresenceRow` + `LivenessDot` extracted from `CoordDashboard`; `formatRelativeUpdated`; existing badge styles; design tokens per `/internal/docs/design`.
- **Tooltip caveat:** "idle" = *no recent tool call* (could be mid-reasoning), not "gone" — the dot tracks tool-call cadence, since the heartbeat only fires on tool boundaries.

### Risks & open questions

- **`coord_owner_id` backfill:** existing `adv_sessions` rows predate the new column → they show durable metadata only (no live join) until relaunched. Acceptable.
- **Ephemeral clutter:** one-off agents create presence rows; mitigated by the stale (>10m) age-out + the liveness filter.
- **Workspace scope:** presence is workspace-scoped; the tab must scope to the current workspace (as `listAdvSessions` already does).
- **"idle vs gone"** ambiguity (the tooltip).

## Phase 1 — Data join + presence merge
- **P-001** `todo` Add coord_owner_id TEXT to harness_shared.adv_sessions (SQL migration in libs/papercusp/libs/db/sql + ensure-schema). Set it in the psu launcher's recordAdvSession to the PAPERCUSP_SID it exports (the coord owner_id the hooks use) → deterministic adv_sessions ↔ coord_presence join. (D-001) importance: high
- **P-002** `todo` Build mergeRoster(): coord_presence as the primary live roster (scoped to current workspace) LEFT JOIN adv_sessions on coord_owner_id for plan/role/feature/history; derive liveness (live<60s / idle<PRESENCE_STALE_MS / stale) from heartbeat_at. Needs the join column from the prior item. (D-002) importance: high



## Phase 2 — Endpoint (merged roster)

## Phase 3 — UI (sections, liveness, detail)

## Phase 4 — Polish (filters, file-map, tokens)


## Phase 2 — Endpoint (merged roster)

- **P-003** `todo` Extend GET /api/adv/sessions (or add GET /api/adv/roster) to return the merged model: active agents (presence-primary) + adv_sessions enrichment + recent ended sessions for the durable list. Consumes mergeRoster().


## Phase 3 — UI (sections, liveness, detail)

- **P-004** `todo` Extract a shared LivenessDot + PresenceRow component from CoordDashboard.tsx (3-state dot keyed on heartbeat age + relative "active Ns ago" + source icon).


## Phase 3 — UI (sections, liveness, detail)

- **P-005** `todo` Wire AdvSessionsClient to the merged endpoint: two sections — (1) plan-associated (existing grouped collapsible view, liveness from presence) and (2) Other active agents (no plan); per-row liveness dot, declared intent, current_files chips. Needs the endpoint + the shared LivenessDot. (D-003)


## Phase 3 — UI (sections, liveness, detail)

- **P-006** `todo` Detail pane: a presence panel (intent, current_files, heartbeat timeline) for agents that have no adv_sessions row, alongside the existing SessionDetail for plan/terminal sessions. importance: low


## Phase 4 — Polish (filters, file-map, tokens)

- **P-007** `todo` Filters: client (claude/codex/omp), liveness (live/idle/stale), harness/workspace, has-plan vs none; plus a "who's editing <file>" lookup driven by current_files.


## Phase 4 — Polish (filters, file-map, tokens)

- **P-008** `todo` Polish: "idle != gone" tooltip, empty states, a design-token pass per /internal/docs/design, and surface any presence-vs-pid discrepancy (zombie/orphan) as a warning. importance: low

## Decisions

### D-001 — Join via a new coord_owner_id column on adv_sessions
Date: 2026-06-02
adv_sessions (bigserial id) and coord_presence (owner_id PK = PAPERCUSP_SID for Claude/Codex, omp-<auth>-<pid> for OMP) share no key today. Add `coord_owner_id TEXT` to adv_sessions, set by the psu launcher at record time to the coord owner_id it exports, for a deterministic join coord_presence.owner_id = adv_sessions.coord_owner_id. Rejected: heuristic matching on pid+agent — fragile across restarts, reparenting, and OMP's owner shape.

### D-002 — coord_presence is the primary roster; adv_sessions enriches
Date: 2026-06-02
coord_presence is now complete (every active agent heartbeats on each tool call) and carries liveness + intent + current_files — exactly the live signal. adv_sessions is plan-tied and a poor liveness signal (pid-only), but holds the durable launch metadata (plan/role/feature) + ended history. So presence is the primary list; adv_sessions is a LEFT-JOIN enrichment. An agent with no adv_sessions row (a plain SU shell) still appears; a plan-tied one gets the richer grouped view.

### D-003 — Merge into the one sessions tab (two sections), not a separate Agents tab
Date: 2026-06-02
Render plan-associated agents in the existing grouped collapsible view, and add an "Other active agents" section beneath, in the SAME sessions tab. Rejected: a parallel "Agents" tab — the user confirmed the plan-associated interface is good and wants the other agents alongside it, not split across two surfaces.

### D-004 — Realtime by short poll, not per-heartbeat SSE
Date: 2026-06-02
Poll the merged roster every 3-5s while the tab is visible (pause when hidden), matching the existing sessions tab. Heartbeats fire on every tool call across the fleet — far too frequent to push individually over SSE; a short poll is cheap and smooth for a slower-moving roster.
