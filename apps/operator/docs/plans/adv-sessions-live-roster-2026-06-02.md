---
title: Sessions view — live all-psu-agent roster (heartbeat-backed)
slug: adv-sessions-live-roster-2026-06-02
status: draft
created: 2026-06-02
updated: 2026-06-02
owner: avi@storewolf.com
---

# Sessions view — live all-psu-agent roster (heartbeat-backed)

## Now

**State:** Phases 1–3 shipped. Data (P-001/P-002), endpoint (P-003 GET /api/adv/roster), and the UI integration are done: P-004 (shared LivenessDot + dep-free @/lib/liveness leaf), P-006 (SessionsRosterView — grouped rich rows: plan / always-shown No-plan + presence-only, LivenessDot + intent + file chips, polls the roster endpoint), and P-005 (Sessions is now the 3rd ?view= in the combined Plans/Inbox shell, rail-filtered; the standalone ?tab=sessions peer is removed). ~40 tests green across the suites; apps/operator typecheck clean on touched files. NOT yet live-verified in the Tauri shell: the SPA renders, but the roster's fetch of /api/adv/roster (and new-launch coord_owner_id population) needs the deferred :3070 host restart.

**Next:** Live-verify in the Tauri shell after the (deferred, user-held) :3070 restart. Then Phase 4: P-007 detail dossier (reusing AdvSessionsClient's SessionDetail) + P-009 (locks/coord enrichment), P-008 files-in-play map, P-010 filters + design-token polish.

## Background

### The problem / why now

The `/adv` Sessions tab today is a **standalone `?tab=sessions` peer** showing only **plan-tied terminal launches** (`adv_sessions`), grouped by plan, with no live signal. Free / ad-hoc psu agents (plain SU/engineer shells) and the **live state** of every agent — what it's doing, which files it's on, whether it's even alive — are invisible.

Two things changed that make a real live roster possible *and* make a better home for it obvious:

1. As of `d33d07837`, **`coord:inbox` bumps a presence heartbeat on every tool call**, so `harness_shared.coord_presence` is now a *complete, fresh* roster of every active psu agent — carrying declared intent + current files. That is the missing live layer.
2. Plans and Inbox were merged into **one shell** (`PlansClient.tsx`) with a `?view=plans|inbox` toggle that shares a single left **plan rail** (`?itemPlans=`); Inbox reuses the rail as its filter (`planFilters`). Sessions belongs in that same shell as a third lens on the same plan-scoped world — not off in its own tab.

So: promote Sessions into the combined shell as a third `?view=`, make it presence-primary, and reuse the rail to filter the roster by plan exactly as Inbox does. It is also the human-facing twin of the `holder_intent` / `holder_focused` lock enrichment (`14bb9fb0c`): the same presence data, surfaced as a dashboard instead of just-in-time on contention.

### Current state (grounded)

- **Combined shell:** `apps/operator/app/admin/plans/PlansClient.tsx` renders the `Plans | Inbox` toggle (`?view=`, buttons ~L561–579) and the shared left rail `aside.pc-plans__rail` (~L544–630). The rail's plan selection is `?itemPlans=` (nuqs array); Inbox passes it down as `planFilters` to `PlanItemsList` / `PlanOtherList` (~L719/732).
- **Standalone Sessions tab (to be removed as a peer):** `AdvShell.tsx` registers `{ id:'sessions', label:'Sessions', icon:Terminal, supportsAll:true }` in `ADV_TABS` (~L36–60); `routes/adv/index.tsx` switch renders `<AdvSessionsClient/>` for `?tab=sessions` (~L54). The component is `apps/operator/app/adv/sessions/AdvSessionsClient.tsx` — grouped-by-plan `Collapsible`s; row = `[agent badge][role][feature][harness][label][times][RowUsagePills] → [Focus/Fresh/Resume]`; a right `SessionDetail` pane.
- **Data today:** `GET /api/adv/sessions` → `listAdvSessions(200)` over `harness_shared.adv_sessions`; polled every **3s** while visible; grouped by `plan_slug`; pid-liveness via `/api/adv/sessions/alive?pid=N`.
- **`adv_sessions`** (`ensure-schema.ts:1965`): durable psu-launch record — `plan_slug, mode(omp|console), terminal_bin, pid, window_id, omp_thread_id, label, cwd, agent, role, feature, started_at, ended_at, exit_code`. Plan-tied; not a live roster.
- **`coord_presence`** (`ensure-schema.ts:1777`, the new live layer): `owner_id` PK, `owner_label, workspace_id, source, intent, current_plan_slug, current_files(jsonb), host, pid, started_at, heartbeat_at`. `stale` = heartbeat older than `PRESENCE_STALE_MS` (10m). `listPresence()` LEFT JOINs `power_user_sessions` → `user_id` / `revoked`.
- **Reuse:** `apps/operator/app/coord/CoordDashboard.tsx` already renders active + stale presence rows; `formatRelativeUpdated`; the existing agent badges.

### Data model & the join

`coord_presence` is keyed by **`owner_id`** (the coord identity: `PAPERCUSP_SID` for Claude/Codex SU, `omp-<auth>-<pid>` for OMP). `adv_sessions` is keyed by a `bigserial id` with **no owner column**, so the two don't join today — the one real dependency (D-001). **`coord_presence` is the primary live roster** (every active agent, plan + non-plan); `adv_sessions` is the **enrichment** (plan/role/feature + durable ended history). A plain SU shell with no `adv_sessions` row still appears from presence; a plan-tied agent gets the richer metadata + grouped view (D-002).

### Agent information available (what we can display)

Grouped by source + cost-to-fetch, so row vs. detail-pane placement is deliberate:

**Tier 1 — free (coord_presence + its power_user_sessions join):** client (`source`: claude/codex/omp) · `owner_label` · liveness dot + "active Ns ago" (`heartbeat_at`) · `intent` one-liner · `current_plan_slug` · `current_files[]` · `host`/`pid` · session age (`started_at`) · `user_id` + `revoked`.

**Tier 2 — one join to adv_sessions (via coord_owner_id):** `role` (worker/validator/…/SU) · `feature` (F-NNN) · `mode`/`terminal_bin`/`window_id`(→ Focus)/`omp_thread_id`(→ Resume)/`cwd` · usage `summary` (latest model, total tokens, $cost, user-message count) · `ended_at`/`exit_code` history.

**Tier 3 — richer joins/parses (detail pane, lazy):** locks **held** (files + lock intent + expiry, `locks:queue` / papercusp_su) and **blocked-waiting** queue position · coord (last message, open handoffs/escalations, unread inbox count, `coord_event_log`) · transcript/progress (todos & phases, latest messages, per-tool call/error counts, goals/jobs/compactions, full token in/out/cache breakdown — the `OmpSessionState` we already parse for OMP; a claude/codex analog).

**Tier 4 — derived (no new data):** live/idle/stale counts per group · "files in play" inverse map (file → agents) · contention (2+ agents on one file) · zombie/orphan (heartbeat-vs-pid disagreement).

### UI design

**Placement:** Sessions is the **third `?view=`** in `PlansClient`'s shell — a `Plans | Inbox | Sessions` toggle — reusing the existing left **plan rail**. Selecting plans in the rail filters the roster to agents whose `current_plan_slug` is in the selection, exactly as it filters inbox items via `planFilters` (D-003). The standalone `?tab=sessions` peer is removed from `AdvShell`.

**Three panes** (rail | roster | detail), matching Inbox's rail + two-pane (list + preview):

```
RAIL (shared) │ Plans │ Inbox │ *Sessions               │ AGENT DETAIL
 [+ New Plan]  │ Filter:[client v][live v][role v] file_ │ * claude · session-188
 (o)Plans      │                                          │ worker · F-012
 ( )Inbox      │ v dbos-retire-legacy-orchestrator *2 ~1 │ Intent "refactoring
 (*)Sessions   │  * claude·worker·F-012·session-188  4s  │  attempt-claim split"
 [Active|Stale]│    "refactoring attempt-claim split"    │ Files(3) attempt-claim L
 search ____   │    [F]attempt-claim.ts x3  L2  W0       │  distributed-claim
 harness v     │    23m · 1.2M tok · $0.84 · opus-4.8    │  feature-claim L
 PLANS(filter) │    [Focus window] [Resume]              │ Locks held(2)
 > dbos-retire2│  * codex·architect·session-190     9s   │  attempt-claim  19m
 > prod-readi 0│    "reviewing claim-handle adapter"     │  feature-claim  19m
 > next-remov 1│    [F]claim-handle.ts x1  L1           │ Coord  handoff -> codex
 > (no plan)  1│ v No plan · ad-hoc SU sessions      *1  │  last "pushed the fix"
               │  * claude·papercup·session-201     2s   │ Usage in 980k out 41k
 selecting a   │    "investigating OMP 400 schema"       │  cache-rd 1.1M  $0.84
 plan filters  │    [F]tool-schema-sanitize.ts x2        │ Transcript >  Todos >
 the roster    │ v Other active agents (presence-only)~1 │ host avi-dev pid 33417
 (Inbox-style);│  ~ omp·~/papercup·omp-..4471  idle 4m   │ started 14:02 · console
 no-plan groups│ -- Files in play(4) -- attempt-claim.ts │
 ALWAYS shown  │   *claude/188 L · ~codex/190?  ...      │
```

(Legend: `*` live dot · `~` idle dot · `L` holds-lock · `W` waiting-on-lock · `[F]` file chip · `>` collapsed.)

- **Grouping:** by plan (rail-filtered) **then** an always-visible `No plan · ad-hoc SU` group **and** an `Other active agents (presence-only)` group — rail selection never hides these (D-005).
- **Rich rows (D-006):** dot · client · role · feature · session-id · "Ns ago" → intent → file chips + `L held` / `W waiting` counts → `age · tokens · $ · model` → contextual actions (Focus/Resume for terminal-backed rows; none for presence-only).
- **Liveness:** dot from `heartbeat_at` — live <60s · idle <`PRESENCE_STALE_MS` · stale. Tooltip: "idle = no recent tool call (may be mid-reasoning), not gone."
- **Detail dossier** (right pane, `SessionDetail` extended): the full Tier-1..3 set for ANY agent incl. presence-only — intent, files w/ lock markers, locks-held + expiry, coord (handoffs / last-said), usage breakdown, expandable transcript/todos.
- **Files in play:** a Tier-4 inverse-map strip/section (file → agents on it) headlining contention.
- **Realtime:** poll the merged endpoint every 3–5s while visible (pause when hidden); no per-heartbeat SSE (D-004).
- **Reuse:** shared `LivenessDot` + `PresenceRow` extracted from `CoordDashboard`; `formatRelativeUpdated`; existing badges; tokens per `/internal/docs/design`.

### Risks & open questions

- **coord_owner_id backfill:** pre-existing adv_sessions rows lack the column → durable metadata only (no live join) until relaunched. Acceptable.
- **current_files reliability:** only populated when an agent calls declare-intent / writePresence with files — the heartbeat alone does not set them. So file-chip / file-map coverage depends on agents declaring; show "—" when empty, don't imply "touching nothing."
- **Tier-3 cross-DB:** locks live in papercusp_su, coord in harness_shared — the dossier joins across DBs; keep it lazy (detail-pane only) so the roster stays one cheap query.
- **Ephemeral clutter:** one-off agents create presence rows; mitigated by stale (>10m) age-out + the liveness filter.
- **Workspace scope:** presence is workspace-scoped; scope the roster to the current workspace (as `listAdvSessions` already does).
- **idle vs gone** ambiguity (the tooltip).

## Phase 1 — Data join + presence merge

- **P-001** `done` Add `coord_owner_id TEXT` to harness_shared.adv_sessions (SQL migration in libs/papercusp/libs/db/sql + ensure-schema). Set it in the psu launcher's recordAdvSession to the PAPERCUSP_SID it exports → deterministic adv_sessions ↔ coord_presence join. (D-001) importance: high (migration 106 + ensureAdvSessionsTable column; coordOwnerId threaded through adv-sessions.ts; bootstrap-su/role record the SID. Commits 29895bf80 / 7a3702c.)
- **P-002** `done` Build mergeRoster(): coord_presence as the primary live roster (current-workspace-scoped) LEFT JOIN adv_sessions on coord_owner_id for plan/role/feature/history; derive liveness (live<60s / idle<PRESENCE_STALE_MS / stale) from heartbeat_at. Needs P-001. (D-002) importance: high (adv-roster.ts: mergeRoster + pure core deriveLiveness/scopePresenceToWorkspace/mergeRosterEntries + advSessionsByCoordOwner helper; 9 unit tests green. Commit 29895bf80.)

## Phase 2 — Endpoint (merged roster + enrichment)

- **P-003** `done` Merged roster endpoint (extend GET /api/adv/sessions or add GET /api/adv/roster): active agents (presence-primary) + adv_sessions enrichment + recent ended sessions for the durable list. Consumes mergeRoster(). (GET /api/adv/roster: {active: mergeRoster, ended: listEndedAdvSessions} + dedupeEndedAgainstActive + ?workspace/?endedLimit. 19 tests, typecheck clean, SQL validated live. Registered via routes/adv/sessions array. Live on next :3070 restart. Commit c2fc44539.)
- **P-009** `todo` Tier-3 enrichment for the detail dossier: per-agent locks-held + expiry (locks:queue / papercusp_su) and coord state (last message, open handoffs/escalations, unread count from coord_event_log). Lazy / per-agent so the roster query stays cheap. importance: low

## Phase 3 — Shell integration (Sessions = 3rd view)

- **P-004** `done` Extract a shared LivenessDot + PresenceRow from CoordDashboard.tsx (3-state dot keyed on heartbeat age + relative "active Ns ago" + source icon). (@/lib/liveness dep-free leaf + app/coord/presence-ui.tsx LivenessDot shared, used by CoordDashboard; drift-guard test. Commit 397f6d466.)
- **P-005** `done` Fold Sessions into the combined Plans/Inbox shell as a third ?view= (Plans|Inbox|Sessions) in PlansClient; remove the standalone ?tab=sessions peer from AdvShell + routes/adv/index.tsx; consume the rail's ?itemPlans as planFilters to scope the roster; always-render the No-plan + presence-only groups regardless of rail selection. (D-003, D-005) importance: high (PlansClient: Sessions = 3rd ?view= rail filters roster via itemPlans, D-003/D-005; standalone ?tab=sessions removed from AdvShell + adv route. Commit 2813058ee.)
- **P-006** `done` Rich roster rows wired to the merged endpoint: grouped (plan / No-plan / presence-only); per-row liveness dot, intent, current_files chips, held/waiting lock counts, age·tokens·$·model line; Focus/Resume for terminal-backed rows. (D-006) (SessionsRosterView.tsx/.css: grouped rich rows plan/no-plan/presence-only, D-005, LivenessDot+intent+file chips, polls /api/adv/roster. 6 jsdom tests. Commit 5d17de307.)

## Phase 4 — Detail dossier + polish

- **P-007** `todo` Full agent dossier detail pane (extend SessionDetail): intent, files w/ lock markers, locks-held + expiry, coord (handoffs / last-said), usage breakdown, expandable transcript/todos — for ANY agent incl. presence-only (no adv_sessions row).
- **P-008** `todo` "Files in play" inverse map (current_files → which agents) with contention (2+ agents/file) + zombie/orphan (heartbeat-vs-pid) markers.
- **P-010** `todo` Filters (client / liveness / role + "who's editing <file>" search) + polish: idle != gone tooltip, empty states, design-token pass per /internal/docs/design. importance: low

## Decisions

### D-001 — Join via a new coord_owner_id column on adv_sessions
Date: 2026-06-02
adv_sessions (bigserial id) and coord_presence (owner_id PK = PAPERCUSP_SID for Claude/Codex, omp-<auth>-<pid> for OMP) share no key today. Add `coord_owner_id TEXT` to adv_sessions, set by the psu launcher at record time to the coord owner_id it exports, for a deterministic join coord_presence.owner_id = adv_sessions.coord_owner_id. Rejected: heuristic matching on pid+agent — fragile across restarts, reparenting, and OMP's owner shape.

### D-002 — coord_presence is the primary roster; adv_sessions enriches
Date: 2026-06-02
coord_presence is now complete (every active agent heartbeats on each tool call) and carries liveness + intent + current_files — exactly the live signal. adv_sessions is plan-tied and a poor liveness signal (pid-only), but holds the durable launch metadata (plan/role/feature) + ended history. So presence is the primary list; adv_sessions is a LEFT-JOIN enrichment. An agent with no adv_sessions row (a plain SU shell) still appears; a plan-tied one gets the richer grouped view.

### D-003 — Sessions becomes the 3rd view in the combined Plans/Inbox shell (shares the rail), not a standalone tab
Date: 2026-06-02
Plans and Inbox already live in one shell (PlansClient, ?view=plans|inbox) sharing a single left plan rail (?itemPlans); Inbox reuses the rail as its filter (planFilters). Make Sessions a third ?view= in that same shell so the rail filters the roster by plan exactly as it filters inbox items, and remove the standalone ?tab=sessions peer from AdvShell. Rejected: (a) keep it a standalone tab — splits the plan-scoped world across two surfaces with a duplicate filter; (b) a separate "Agents" tab — the human confirmed the plan-associated interface is good and wants the other agents alongside it, in one place.

### D-004 — Realtime by short poll, not per-heartbeat SSE
Date: 2026-06-02
Poll the merged roster every 3-5s while the tab is visible (pause when hidden), matching the existing sessions tab. Heartbeats fire on every tool call across the fleet — far too frequent to push individually over SSE; a short poll is cheap and smooth for a slower-moving roster.

### D-005 — Rail selection never hides no-plan / presence-only agents
Date: 2026-06-02
Selecting plans in the rail filters plan-tied agents (current_plan_slug in selection), but the "No plan · ad-hoc SU" and "Other active agents (presence-only)" groups stay visible below the filtered set regardless of selection. Rejected: mirror Inbox's hide-on-any-selection — live SU/engineer shells (often the most interesting agents) would vanish whenever a plan filter is active.

### D-006 — Rich multi-line rows as the default density
Date: 2026-06-02
Default row shows dot + client + role + feature + id + age, the intent line, current_files chips with held/waiting lock counts, and the age·tokens·$·model line; the detail pane adds locks-held, coord, and transcript. Rejected (for now): a one-line compact row — denser but defers the at-a-glance "what is this agent doing / touching" signal that is the whole point. Compact can return later as a view toggle if the list gets long.
