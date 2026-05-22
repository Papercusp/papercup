---
title: Plans as launchable context — revision spine and agent runs
slug: plan-agent-launch-2026-05-21
status: active
created: 2026-05-21
updated: 2026-05-21
owner: avi@storewolf.com
---

# Plans as launchable context — revision spine and agent runs

## Now

**State:** v3, ratified — implementation in flight (started
2026-05-21). **Phase 1 (revision spine) is complete — 5/5.**
**Phase 2 (conversation linkage): P-006 + P-009 built; P-007 +
P-008 corrected to depend on Phase 3.** **Phase 3 (agent launch)
is in flight — P-010 + P-011 done.**

Phase 1: P-001 (`plan_revisions` schema); P-002 + P-003 (`rationale`
+ revision capture on all seven `plans:*` write verbs via the shared
`planRevisionCapture` / `withPlanLock` `afterWrite` hook); P-004
(`plans:revisions` read verb); P-005 (`plans:backfill-revisions`).

Phase 2: P-006 `done` — the call ctx carries no conversation session
id, so the `plan_run` session is threaded via `?plan_run=` on the
MCP URL → `ctx.planRunSessionId` → `resolvePlanSessionRef` → the
write verbs' `plan_revisions` rows (D-016). P-009 `done` —
`buildPlanContextBundle` assembles the invariant launch seed
(preamble + plan doc verbatim + rationale digest; transcripts never
inlined). P-007 + P-008 both need a persisted transcript
(`plan_run_turns`), which Phase 3 builds — their `blocked-by` was
corrected to P-010 + P-012 (the plan v3 had mis-scoped them as
buildable in Phase 2), so they execute alongside Phase 3, not before
it.

Phase 3: P-010 `done` — `ensurePlanRunsTable()` +
`ensurePlanRunTurnsTable()` in `ensure-schema.ts`, the
`harness_shared.plan_runs` (launches-only) + `harness_shared.plan_run_turns`
(transcript, FK → `plan_runs`) tables, flag-guarded and wired into
the `instrumentation-node.ts` prewarm — same pattern as P-001.
P-011 `done` — the plan-agent runner (`runner.ts`): `runPlanAgent`,
a `runAgentChat` wrapper (P-009 bundle as `systemPromptText`,
`sessionMode: 'force'` for create-or-resume); `buildPlanAgentMcpConfig`
emits the `?plan_run=` MCP URL (D-016); the tool surface is native
coding tools + the operator world-model + `plans:*` (D-017). No
`lib/delegates` coupling.

tsc-clean (0 errors in touched files; tree 551 is other agents'
churn), 120 plans tests + 8 transport tests green. 17 decisions, no
open questions.

**Verification debt:** the live PG paths (`plan_revisions` /
`plan_runs` / `plan_run_turns` DDL + INSERT/SELECT, the backfill's
idempotency check) run on first operator boot / first invocation and
are formally re-verified in P-027 — the working shell cannot reach
the auth-gated embedded PG directly. `runPlanAgent` itself spawns an
agent process; its live behaviour is verified when P-012 exercises
it. All git + pure logic is verified now (120 tests, incl. real-git
`readPlanFileAtCommit` integration, `resolvePlanSessionRef`, the
`buildPlanContextBundle` seed assembler, and the runner's
`buildPlanAgentMcpUrl` / tool-surface constants).

**Next:** P-012 — `plans:launch { slug, note? }`: assemble the
P-009 bundle, mint a `session_id`, run via the P-011 runner, insert
the `plan_runs` row, persist turns to `plan_run_turns`. P-007 and
P-008 unblock once P-012 lands.

## Background

Plans today are inert documents. A plan records *what to do* and the
*settled why*, but two things are missing:

1. **No launch path.** Getting from "a plan exists" to "an agent is
   executing it" is entirely manual — a human copies context into a
   chat box. The plan, which already *is* a context bundle ("here is
   the work, the decisions, the next action"), is not wired to start
   anything.
2. **The reasoning evaporates.** A plan is a distillation. The
   back-and-forth that produced it — the rejected alternatives, the
   arguments, the constraints that shaped a decision but never became
   a line item — lives only in a chat transcript that nothing links
   to. An agent re-seeded from the plan doc alone re-litigates
   settled questions and misses unwritten constraints.

The unifying observation (Avi's, from the design discussion): **an
agent is just context.** Papercusp already spawns agents this way —
`runAgentChat` (`libs/papercup-shared/src/agent/chat-stream.ts`) is
the shared primitive that spawns a CLI agent with a persona + tool
config + a resumable session and streams its output; eight surfaces
(oracle, architect, agent_chats, …) call it directly. What is missing
is a *named, reusable, conversation-linked context bundle* to seed one
from. The plan is the natural bundle.

This plan makes a plan a **launchable context**: it gains a
conversation-linked revision history, and an agent can be launched
from it with a single click — seeded with the plan plus the
rationale behind every revision — with every launch recorded and
resumable.

## Design

### The core model

A **revision** and the **conversation** that produced it are one
event. Every time a plan changed, a session drove that change. So
the revision carries its conversation, and "the full context of a
plan" gets a precise definition:

> **The current plan doc + the revision chain, where each revision
> carries a written rationale and is openable to the session that
> produced it.**

Three new PG tables:

- `plan_revisions` — the document's history. One row per plan write.
- `plan_runs` — agents **launched** from the plan. One row per launch.
- `plan_run_turns` — the transcript of each run. One row per turn.

The plan's author/origin is **not** a `plan_runs` row — it is simply
`plan_revisions` seq 1 (`author` + `session_id`). `plan_runs` is
launches-only (D-006). A launched agent that edits the plan produces
new `plan_revisions` rows whose `session_id` points back at its run —
the loop closes recursively.

### Why `plan_revisions`, not git history (D-003)

A git-history strip exists today (`GitHistoryStrip.tsx`, P-303 of
`plans-admin-ui-2026-05-20`). Git commits ≠ plan revisions:

- One commit batches many files; a plan write can sit uncommitted
  for an hour; three plan writes can land in one commit. (Observed
  first-hand committing the `plans-admin-ui` work.)
- A commit carries a hash, author, subject, diff — but **no
  conversation and no rationale**.

`plan_revisions` is appended by the `plans:*` write verbs themselves,
so it is precise (1:1 with semantic plan writes), plan-scoped, and
conversation-linked. The `plans:history` / `plans:diff` git-backed
tools are kept as a coarse cross-file *backup data source* — not
deleted, but the Revisions UI is built on `plan_revisions`.

### Layered context — provenance, not replay (D-002, D-005)

Raw transcripts must **not** be inlined unboundedly: a multi-revision
plan has N conversations and N grows; transcripts are ~90% mechanical
noise (tool-call JSON, file reads). So context is two layers:

- **Seed (always inlined):** the current plan doc + a short
  per-revision *rationale* — the distilled "why / what was rejected,"
  preferring the substantive `set-content` rationales.
- **Retrievable (on demand, scoped):** the transcript of a revision's
  session, behind a tool — searched/paginated, never dumped whole
  (a raw dump would blow the caller's window — the very thing this
  layering avoids).

Because the rationale is always seeded (D-009) and raw transcripts
are never seeded (D-005), **the launch seed is invariant** — there is
no context-depth choice. `buildPlanContextBundle(slug)` takes no
depth argument.

### Who writes the rationale (D-009)

The rationale is **authored at write time, by whoever makes the
revision** — part of writing the plan, not a separate pipeline stage.

```
agent or human does the work
  → calls a plans:* write verb  { content/change, rationale? }
      (inside the existing write lock)
      → write the .md file
      → append a plan_revisions row  { content_snapshot, content_hash,
                                       rationale, author, session ref }
  → done   — one atomic act
```

- **Agent writer:** the write verbs gain an optional `rationale`
  argument. Verb guidance instructs the agent to state why on a
  substantive `set-content` — "this becomes the always-loaded context
  for the next agent."
- **Human writer:** the `/admin/plans` editor's Save gains a small
  "what changed & why" field supplying the same `rationale`.

`rationale` is **optional**, and the expectation scales with the
write's significance: a substantive `set-content` rewrite should
carry one; a one-item `set-status` flip need not (the change is
already visible in the plan doc, and a timeline of trivial "marked
P-007 done" rows is noise). The seed prefers `set-content`
rationales.

Why at write time and not a downstream pass: the moment of the write
is the moment of **maximum context** — the author just did the
reasoning. A later curator/auto-summary pass has to *reconstruct* the
why from a noisy transcript. Auto-summary exists only as a
best-effort fallback for rationale-less revisions that still have a
session (P-007).

### Run substrate — a sibling surface over `runAgentChat` (D-004)

The launch is built directly on **`runAgentChat`** — the shared
primitive (`libs/papercup-shared/src/agent/chat-stream.ts`) that
spawns a CLI agent and streams it. It already takes everything the
launch needs as parameters: the persona (`systemPromptText`), the
tool surface (`mcpConfig` + `allowedTools`), the process (`cwd`,
`model`, backend), and **resume** (`sessionId` + `sessionMode:
'force'` — create-or-resume). Eight surfaces already call it
directly.

A plan-launched agent is therefore a **new sibling surface**, built
in the same mould as `oracle/chat.ts`:

- its own plan-execution persona (a `systemPromptText`),
- its own `buildPlanAgentMcpConfig` — the `agentmcp` tool surface
  (`plans:*`, files, search); *not* delegate's voice-routing stdio
  server,
- its own session + transcript tables (`plan_runs`,
  `plan_run_turns`),
- and it calls `runAgentChat`.

It does **not** import `lib/delegates` or `operator:delegate`.
`operator:delegate` is just one more sibling of `runAgentChat` (a
voice persona + the `lib/delegates` store); it is not a substrate and
there is nothing in it to "generalize." Keeping plan agents separate
means zero coupling to — and zero blast radius on — the voice
feature. `agent_chats` (harness-scoped) and orchestrator spawns
(chunk-bound) remain the wrong primitives.

### Launching and resuming (D-007, D-010)

The launch is a single "Launch agent" button + an optional free-text
note — no intent or depth pickers (D-007); the seed is invariant.
The launch runs at **workspace scope** (D-008) — plans are
cross-harness, so the agent `cd`s into whatever harness a task needs.

A `plan_run` is **durable and resumable** (D-010): the run owns a
stable `session_id`. The first launch calls `runAgentChat` with that
id and `sessionMode: 'force'` (creates the session); "continue" calls
`runAgentChat` again with the same id (resumes it) — resuming an
auto-archived run reactivates it. Every turn, launch or continue, is
appended to `plan_run_turns` — the queryable canonical transcript.
The run detail view is an interactive chat, not a static transcript.

### Revisions with no conversation

Two human write paths: via the operator chat (`session_kind =
operator_chat` — has a transcript) and via the `/admin/plans` editor
(no session — `session_id` NULL). The UI handles this without an
"empty state": the **rationale is always shown inline** on the
revision row, and the "open conversation" drill-down is a
*conditional* affordance, present only when `session_id` is set. A
direct-editor revision shows a "direct edit" tag and its inline
rationale — which is the complete record.

### Schema sketch

```sql
-- harness_shared schema (D-012; alongside spawns, tool_invocations)

CREATE TABLE harness_shared.plan_revisions (
  id              BIGSERIAL PRIMARY KEY,
  plan_slug       TEXT NOT NULL,
  seq             INT  NOT NULL,          -- 1-based, per plan_slug, allocated max+1 in-lock
  content_hash    TEXT NOT NULL,          -- hashPlanContent() of the snapshot
  content_snapshot TEXT NOT NULL,         -- full bytes — D-011
  rationale       TEXT,                   -- the "why"; optional, supplied at write time (D-009)
  author_kind     TEXT NOT NULL,          -- 'agent' | 'human'
  author_id       TEXT NOT NULL,          -- agent identity or email
  session_id      TEXT,                   -- the conversation; NULL for direct edits / backfill
  session_kind    TEXT,                   -- 'plan_run' | 'operator_chat' | 'agent_chat'
  created_at      BIGINT NOT NULL,
  UNIQUE (plan_slug, seq)
);

CREATE TABLE harness_shared.plan_runs (
  id                BIGSERIAL PRIMARY KEY,   -- launches only; the origin is plan_revisions seq 1
  plan_slug         TEXT NOT NULL,
  plan_content_hash TEXT NOT NULL,        -- which revision seeded the launch
  session_id        TEXT NOT NULL,        -- our own claude/omp session uuid (runAgentChat sessionId)
  note              TEXT,                 -- optional free-text instruction at launch
  launched_by       TEXT NOT NULL,
  launched_at       BIGINT NOT NULL,
  status            TEXT NOT NULL,        -- running | idle | archived | done | failed
  title             TEXT,
  updated_at        BIGINT NOT NULL
);

CREATE TABLE harness_shared.plan_run_turns (
  id          BIGSERIAL PRIMARY KEY,
  plan_run_id BIGINT NOT NULL REFERENCES harness_shared.plan_runs(id),
  seq         INT  NOT NULL,             -- 1-based, per run
  role        TEXT NOT NULL,             -- 'user' | 'assistant'
  content     TEXT NOT NULL,
  tokens_in   INT,
  tokens_out  INT,
  cost_usd    NUMERIC,
  created_at  BIGINT NOT NULL,
  UNIQUE (plan_run_id, seq)
);
```

Plan *content* stays filesystem-canonical — these tables hold the
plan↔session relations, the (small) content snapshots, and the run
transcripts, per the PG-by-default / FS-canonical-for-plan-content
split.

## Scope

**In scope**

- `plan_revisions` + `plan_runs` + `plan_run_turns` tables (in
  `harness_shared`) and their migration.
- Revision capture — content snapshot + optional `rationale` — on
  every `plans:*` write verb.
- `plans:revisions`, `plans:revision-transcript` (scoped),
  `plans:launch` (+ resume), `plans:runs` tool verbs.
- The plan-agent runner — a `runAgentChat` sibling surface with its
  own plan-execution persona and `buildPlanAgentMcpConfig`.
- `buildPlanContextBundle(slug)` — framing preamble + plan doc +
  rationale summaries.
- Fallback rationale auto-summary for rationale-less revisions.
- UI: the Revisions panel (rebuilding `GitHistoryStrip`), the Agents
  tab in `PlanDetail` (launch + resumable run detail), and a "why"
  field on the editor's Save.

**Out of scope**

- SSE live-sync of run status — v1 polls.
- Cross-plan context — a launch sees exactly one plan.
- Coordinating parallel launches — nothing caps them; two agents on
  one plan coordinate through `set-content`'s CAS and the plan itself.
- Touching `lib/delegates` / `operator:delegate` — plan agents are a
  separate surface (D-004).
- Mobile.
- Deleting the `plans:history` / `plans:diff` git tools — they remain
  as a backup data source.

## Phase 1 — Revision spine

The PG foundation. Every plan write becomes a durable, identified
revision carrying its rationale. Independently shippable — a precise
plan history — before any launch capability exists.

- **P-001** `done` Add `ensurePlanRevisionsTable()` to `ensure-schema.ts` — `CREATE TABLE IF NOT EXISTS harness_shared.plan_revisions` (full snapshot) + grants, flag-guarded, wired into the `instrumentation-node.ts` prewarm. → D-003, D-011, D-012, D-013
- **P-002** `done` Add an optional `rationale` parameter to `plans:set-content`; inside its existing write lock, after the CAS write, append a `plan_revisions` row — content snapshot + hash + identity + session ref + rationale; `seq` allocated max+1 in-lock. The append goes through a new `recordPlanRevision` helper (`revisions.ts`) called from a new `withPlanLock` `afterWrite` hook; recording is best-effort (D-014). → D-009, D-014
- **P-003** `done` Add the same optional `rationale` + revision-append to the other mutating verbs (`set-now`, `set-status`, `add-item`, `add-decision`, `new`, `set-frontmatter`). Done via a shared `planRevisionCapture` helper (`revisions.ts`) wired into each verb's `withPlanLock` `afterWrite`; `set-content` refactored onto the same helper. blocked-by: P-002
- **P-004** `done` `plans:revisions { slug }` read verb — the revision chain newest-first: seq, author, rationale, session ref, diff-stat (a self-contained line-LCS over the adjacent snapshot pair — no npm `diff` dependency). Snapshots themselves are not returned; an empty chain (no recorded revisions) is not an error. → D-003
- **P-005** `done` Backfill `plan_revisions` from existing git history — one synthetic revision per past commit, the commit subject as a weak `rationale`, `session_kind` `git_backfill`, `session_id` NULL. Shipped as the `plans:backfill-revisions` tool (idempotent, skip-if-populated); `readPlanFileAtCommit` reconstructs each snapshot via `git show`; per-plan atomic. → D-015 blocked-by: P-001

## Phase 2 — Conversation linkage

Make each revision openable to the conversation that produced it,
and define the launch seed.

- **P-006** `done` Investigated: the MCP call ctx carries no conversation/run session id — `runId`/`spawnId` regenerate per-call (forbidden as identity), `uiClientId` is the stable agent id. Threaded the `plan_run` session through: `?plan_run=<uuid>` on the MCP URL → `ctx.planRunSessionId` (new optional `UnifiedToolContext` field) → `resolvePlanSessionRef` → all seven write verbs' `plan_revisions` rows. → D-016
- **P-007** `todo` Fallback rationale auto-summary — for revisions with a session but no supplied rationale, best-effort summarize the transcript into `rationale`. Needs a persisted transcript to summarize, so it cannot land before Phase 3 builds `plan_run_turns` and a run persists turns. → D-009 blocked-by: P-010, P-012
- **P-008** `todo` `plans:revision-transcript { revisionId, query?, cursor?, limit? }` — *scoped* transcript retrieval (search / paginate), never a whole-transcript dump; reads `plan_run_turns` for a plan-run session, the operator/agent-chat store otherwise. The `plan_run_turns` store (P-010) must exist and a run must have persisted turns (P-012) before this is buildable + verifiable. blocked-by: P-006, P-010, P-012
- **P-009** `done` `buildPlanContextBundle(slug)` helper (`context-bundle.ts`) — assembles the invariant launch seed: a framing preamble + the plan doc verbatim (parser `raw`) + the per-revision rationale digest (one entry per revision that recorded a `rationale`, newest-first; rationale-less revisions omitted). Transcripts are never inlined (D-002/D-005). Pure assembler `assemblePlanContextBundleText` split out for unit test; the revision read is best-effort so a `plan_revisions` outage cannot block a launch. Returns the seed text + `contentHash` (byte-identical to `plans:get`) for P-012 to stamp on the run. → D-002

## Phase 3 — Agent launch

Build the plan-agent runner as a `runAgentChat` sibling surface, then
wire the launch and its history on top.

- **P-010** `done` `ensurePlanRunsTable()` + `ensurePlanRunTurnsTable()` in `ensure-schema.ts` — `CREATE TABLE IF NOT EXISTS` for `harness_shared.plan_runs` (launches-only, indexed on `plan_slug` for the `plans:runs` history query) and `harness_shared.plan_run_turns` (FK → `plan_runs.id`, `UNIQUE(plan_run_id, seq)`); flag-guarded, grants best-effort, wired into the `instrumentation-node.ts` prewarm. `ensurePlanRunTurnsTable` ensures `plan_runs` first so the FK resolves regardless of call order. → D-006, D-012, D-013
- **P-011** `done` Plan-agent runner (`runner.ts`) — `runPlanAgent`, a `runAgentChat` wrapper in the mould of `operator/converse.ts`: the P-009 bundle is the `systemPromptText`, the launch note is the `promptText`, `sessionMode: 'force'` makes it create-or-resume (D-010). `buildPlanAgentMcpConfig` builds the `agentmcp` direct-HTTP MCP config with `?plan_run=<sessionId>` (the D-016 consumer); `PLAN_AGENT_ALLOWED_TOOLS` = native coding tools + the operator world-model surface + `plans:*` (D-017). No `lib/delegates` / `operator:delegate` import. → D-004, D-016, D-017
- **P-012** `todo` `plans:launch { slug, note? }` — assemble the bundle (P-009), mint a `session_id`, start the run via the P-011 runner (`runAgentChat`, `sessionMode: 'force'`), insert the `plan_runs` row, persist turns to `plan_run_turns`, return the run id; warn when the plan is `superseded`. blocked-by: P-011, P-009, P-010
- **P-013** `todo` Resume — a "continue" call re-invokes the runner with the run's existing `session_id`; new turns append to `plan_run_turns`. → D-010 blocked-by: P-012
- **P-014** `todo` Add `agent_launched` to `PlanEventType` in `coordination/plan-events.ts` *with* its emitter (the type is exhaustive over emitters).
- **P-015** `todo` `plans:runs { slug }` read verb — the launch history for the Agents tab.
- **P-016** `todo` Run-status lifecycle — maintain `plan_runs.status` (running/idle/archived/done/failed) across launch, continue, and idle (poll-based for v1).

## Phase 4 — UI: Revisions panel

Rebuild the git strip as a first-class, conversation-linked revision
timeline.

- **P-017** `todo` Rebuild `GitHistoryStrip` as a `plan_revisions`-backed Revisions panel — rows: seq, author, when, the rationale inline, diff-stat. (`plans:history`/`plans:diff` stay as a backup data source, not shown here.) blocked-by: P-004
- **P-018** `todo` Per-revision diff modal — keep the `react-diff-view` modal; source the patch from the snapshot pair instead of `git diff`.
- **P-019** `todo` Per-revision drill-down — "open conversation" affordance shown only when `session_id` is present; a no-session revision shows a "direct edit" tag and its inline rationale only. blocked-by: P-008
- **P-020** `todo` nuqs URL state for the Revisions panel (`?tab=revisions`, `?rev=<id>`).

## Phase 5 — UI: Agents tab

The launch surface and the resumable run history.

- **P-021** `todo` Agents tab in `PlanDetail` — origin card (author sourced from `plan_revisions` seq 1) + the past-runs list. blocked-by: P-015
- **P-022** `todo` "Launch agent" — a single button plus an optional free-text note field; no pickers. → D-007 blocked-by: P-012
- **P-023** `todo` Run detail view — an interactive, *resumable* chat over `plan_run_turns` (not a static transcript) + a plan-version badge (⚠ when `plan_content_hash` ≠ the plan's current hash). → D-010 blocked-by: P-013
- **P-024** `todo` Route handlers — `POST …/launch`, `POST …/runs/:id/continue`, `GET …/runs`, `GET …/revisions` — the in-process tool-proxy route pattern from `plans-admin-ui-2026-05-20`.
- **P-025** `todo` PlanEditor Save — add an optional "what changed & why" field that supplies `rationale` to `plans:set-content`. → D-009 blocked-by: P-002
- **P-026** `todo` nuqs URL state for the Agents tab (`?tab=agents`, `?run=<id>`).

## Phase 6 — Verification

- **P-027** `todo` Unit tests — revision + rationale append on every write verb, scoped transcript retrieval, bundle assembly, launch + resume round-trip. blocked-by: P-012, P-017
- **P-028** `todo` End-to-end through the desktop app — author a plan, edit it twice, launch an agent, continue it, verify the revision timeline + run history + resumable run detail; assert seeding + row-creation rather than running a live LLM. blocked-by: P-021, P-022, P-023

## Decisions

### D-001 — The conversation is first-class context, not just the plan doc
Date: 2026-05-21
The plan document is the *spec* — the distilled what and settled
why. The conversation that produced it holds the *reasoning* —
rejected alternatives, arguments, unwritten constraints. An agent
seeded from the plan doc alone re-litigates settled questions and
misses constraints. The conversation must be part of the context
bundle. (Avi's correction; the initial proposal under-weighted it.)

### D-002 — Layered context: rationale inlined, raw transcripts retrievable
Date: 2026-05-21
The launch seed is the plan doc + the per-revision rationale
summaries; the transcript of any revision is retrievable on demand,
scoped (searched/paginated), never inlined whole. Because the
rationale is always seeded (D-009) and transcripts never are (D-005),
the seed is invariant — no context-depth choice.

### D-003 — `plan_revisions` is the revision spine; git history is a backup
Date: 2026-05-21
Git commits ≠ plan revisions (commits batch files, plan writes sit
uncommitted, multiple writes coalesce). The spine is a PG table
appended by the `plans:*` write verbs — precise, plan-scoped,
conversation-linked. The `plans:history`/`plans:diff` git tools are
kept as a coarse backup data source only.

### D-004 — Run substrate is `runAgentChat`; plan agents are a sibling surface
Date: 2026-05-21
The shared spawn/stream/resume primitive is `runAgentChat`
(`libs/papercup-shared/src/agent/chat-stream.ts`) — it takes the
persona (`systemPromptText`), tool surface (`mcpConfig` +
`allowedTools`), and resume (`sessionId` + `sessionMode: 'force'`,
create-or-resume) as parameters, and eight surfaces already call it
directly (oracle, architect, agent_chats, operator-converse, scan,
scanner-session, pm-dispatch, delegate). A plan-launched agent is a
new sibling surface in the mould of `oracle/chat.ts`: its own
plan-execution persona, its own `buildPlanAgentMcpConfig`, its own
session/transcript tables (`plan_runs` / `plan_run_turns`). It calls
`runAgentChat` and never imports `lib/delegates` or
`operator:delegate` — zero coupling to, and zero blast radius on, the
voice feature. `agent_chats` (harness-scoped) and orchestrator spawns
(chunk-bound) remain the wrong primitives. (v2 said "generalize the
delegate substrate" — wrong; the generalized substrate already exists
as `runAgentChat`. Corrected in v3 after Avi's review.)

### D-005 — Provenance, not replay
Date: 2026-05-21
The "starting context" of a plan is the plan doc + its revision
chain (with rationales) — NOT a replay of the author agent's raw
transcript (noise + unbounded). The author's session is recorded on
revision #1; its transcript is retrievable like any other
revision's, never the seed.

### D-006 — Three tables; `plan_runs` is launches-only
Date: 2026-05-21
`plan_revisions` is the document's history; `plan_runs` is agents
launched from the plan; `plan_run_turns` is each run's transcript.
The plan's author/origin is **not** a `plan_runs` row — it is
`plan_revisions` seq 1 (`author`, `session_id`). Modelling the origin
as a `plan_runs` row was dropped: it duplicated the seq-1 row and
broke the `session_id NOT NULL` constraint for human-authored plans
(which have no agent session). The origin card reads revision 1.

### D-007 — One launch action, no pickers
Date: 2026-05-21
The launch is a single "Launch agent" button (Q1) + an optional
free-text note. No intent dimension; and with D-009 (rationale always
seeded) + D-005 (transcripts never seeded) there is no context-depth
choice either. `plan_runs` carries no `intent` or `context_depth`.

### D-008 — Plans are cross-harness; the launch is workspace-scoped
Date: 2026-05-21
A plan can span multiple harnesses (Q2) — no `harness:` frontmatter
field. `plans:launch` runs the agent at workspace scope; a launched
agent `cd`s into whatever harness a task needs. Plans are
operator-level, not harness-level, state.

### D-009 — The rationale is authored at write time, by the writer; optional
Date: 2026-05-21
Every plan write verb takes an optional `rationale` argument; the
agent (or the human, via the editor Save's "what changed & why"
field) supplies the why in the same call that writes the content, and
it is stored on the `plan_revisions` row atomically. It is not a
separate pipeline stage. `rationale` is optional and the expectation
scales with the write's significance — guided for a substantive
`set-content`, unnecessary for a one-item `set-status` flip. The seed
prefers `set-content` rationales. Auto-summary from the transcript is
a best-effort fallback only for rationale-less revisions that have a
session.

### D-010 — Launched agents are resumable
Date: 2026-05-21
A `plan_run` is a durable, resumable run, not a one-shot. Its detail
view is an interactive chat the user can continue; resuming an
auto-archived run reactivates it. The mechanism is `runAgentChat`'s
`sessionId` + `sessionMode: 'force'` (create-or-resume) — resume is a
parameter of the shared primitive, nothing run-type-specific. A
read-only "transcript only" model was rejected — it contradicts the
"an agent is a persistent thing" mental model. (Avi, Q4.)

### D-011 — Revision storage: full content snapshot
Date: 2026-05-21
Each `plan_revisions` row stores the entire plan markdown in
`content_snapshot` (`NOT NULL`). Plans are small (~5–25 KB); 50
revisions ≈ a few hundred KB. Each revision is self-contained —
rendering or diffing any revision is pure row reads — and the spine
never depends on git being intact, which is the whole point of D-003.
Hash-only + git reconstruction was rejected. (Avi, Q3.)

### D-012 — Schema home: `harness_shared`
Date: 2026-05-21
`plan_revisions`, `plan_runs`, and `plan_run_turns` live in the
`harness_shared` schema, alongside `spawns` and `tool_invocations`.
Plans are cross-harness operator-level state (D-008); a dedicated
schema would only be worth a separate migration/backup lifecycle,
which these tables don't need. (Avi, Q5.)

### D-013 — Schema DDL uses the `ensure-schema.ts` runtime-ensure pattern
Date: 2026-05-21
P-001/P-010 originally said "PG migration." The codebase's actual
pattern for a new `harness_shared` table is a runtime
`ensureXxxTable()` in `apps/operator/lib/ensure-schema.ts` —
idempotent `CREATE TABLE IF NOT EXISTS` + grants, flag-guarded, wired
into the `instrumentation-node.ts` prewarm and called lazily by the
feature module. That is how `operator_scans`, `toast_log`,
`delegate_inbox` and ~40 other shared tables were added; the numbered
`commands/migrations/*.sql` files are reserved for ALTER / rename /
grant on existing tables. Plan tables use the ensure pattern.
(Discovered reading the code at P-001.)

### D-014 — Revision recording is best-effort, not fatal to the write
Date: 2026-05-21
`recordPlanRevision()` never throws: a failure to append the
`plan_revisions` row (a transient DB outage) is logged and returns
`null`, and the plan write still succeeds. The `.md` file is the
canonical artifact for plan *content*; blocking every plan write on
the revision DB would be a worse failure than a recoverable spine
gap — and a gap *is* recoverable, since P-005's git backfill
reconstructs missing revisions from commit history. The
`plans:set-content` response carries `revision: { seq } | null` so a
caller can see whether the append landed. This mirrors the existing
`emitPlanEventForCaller` best-effort precedent (plan-events are
observability, swallowed on failure) — though a revision is closer to
state than an event, the FS file remains the source of truth for
content, which is what makes best-effort safe here.
(Decided at P-002.)

### D-015 — Git-history backfill: one-time, idempotent, provenance-marked
Date: 2026-05-21
P-005 seeds the `plan_revisions` spine from each plan's pre-existing
git history — one synthetic revision per `git log --follow` commit,
the content snapshot reconstructed via `git show`. Design choices:

- **Idempotent, skip-if-populated.** A plan with any existing
  `plan_revisions` rows is left untouched. The spine table is empty
  until the backfill runs, so backfilled `seq` is a clean 1..N; once
  a plan has rows (backfilled or live) the backfill never touches it
  again — no renumbering, no collision with live revisions, safe to
  re-run. The check + insert hold the plan-file lock, serialized
  against live `recordPlanRevision` writes.
- **`session_kind = 'git_backfill'`, `session_id` NULL.** A commit
  has no conversation. `git_backfill` is the provenance marker the
  Revisions UI keys on (P-019: a "from git history" tag; the "open
  conversation" affordance stays hidden — there is no session).
- **`author_kind = 'human'`.** A git commit is nominally
  person-authored — even an agent's commit is attributed to a person
  in this repo; the commit author string goes in `author_id`.
- **Commit subject as a weak `rationale`.** It is the only "why" a
  commit carries — better than nothing, weaker than an authored
  rationale. P-007's auto-summary may later improve rationale-less
  rows.
- **Per-plan atomic.** All of a plan's inserts run in one
  `withWorkspace` transaction; a mid-loop failure rolls the whole
  plan back, so a retry re-backfills cleanly.
- **Invoked via the `plans:backfill-revisions` tool**, not a
  standalone script — the tool runs in-process where the embedded PG
  is reachable; a bare `tsx` script is not. Archived plans are out
  of scope for the v1 backfill.
(Decided at P-005.)

### D-016 — The plan-run session is threaded via `?plan_run=` on the MCP URL
Date: 2026-05-21
P-006 investigated whether the MCP call ctx already identifies the
conversation a plan write belongs to. It does not: `runId`/`spawnId`
regenerate on every MCP call (`coordination/identity.ts` forbids
deriving identity from them), and `uiClientId` is the stable
per-agent id (for a superuser it is the transport's `Mcp-Session-Id`
handshake) — none of these is "the conversation that produced this
write".

So the plan-run session is threaded explicitly:

- The plan-agent runner (P-011) mints the run's `runAgentChat`
  session id and carries it on the MCP endpoint URL it hands the
  launched agent as `?plan_run=<uuid>`.
- The MCP transport (`_mcp-handler.ts` `tryBuildSpawnContext`) reads
  `?plan_run=` and folds it onto a new optional `UnifiedToolContext`
  field, `planRunSessionId`. It is set on all three authed ctx
  branches (superuser / power-user / per-spawn) so whichever tier
  P-011 picks, it works.
- `plans:*` write verbs resolve it via `resolvePlanSessionRef(ctx)` →
  `{ sessionId, sessionKind: 'plan_run' }`, recorded on the
  `plan_revisions` row. Every non-plan-run caller (SU engineer
  session, browser `/admin/plans` save) resolves to `{ null, null }`
  — a "direct edit" (P-019).

`planRunSessionId` is a provenance label only, never a security
boundary — same status as `uiClientId`. Only the `plan_run` session
kind is threaded; `operator_chat` / `agent_chat` linkage would each
need their own surface to thread a session id and is out of P-006's
scope. **P-011 is bound to the `?plan_run=` param name by this
decision.**
(Decided at P-006.)

### D-017 — A launched plan agent gets the operator world-model surface, not a plans-only allowlist
Date: 2026-05-21
P-011's runner gives the launched agent three tool layers:

- **native coding tools** (`Read` / `Write` / `Edit` / `Bash` /
  `Glob` / `Grep` / …) — a plan agent does real engineering work, so
  unlike the chat brains it needs the agent's own file/shell tools;
- **the operator world-model surface** — `NON_INTERACTIVE_AGENT_MCP_TOOLS`
  (`harness:*`, `search:*`, `messages:*`, `goals:*`, `issues:*`,
  `memory:*`, `orchestrator_*`, `ui:*`);
- **the `plans:*` surface** — to advance the plan it was launched on
  (`plans:backfill-revisions` excluded — a one-time migration tool).

P-011's draft text named only "(`plans:*`, files, search)". That was
illustrative: a plan is usually *about* harness work, and a
plans-only agent could not read harness state, search the tree, or
message other agents — it would be unable to actually do most plans.
The established full-agent pattern (`operator:converse`) uses the
whole `ALL_AGENT_MCP_TOOLS` surface; the plan agent mirrors it, minus
the interactive `chat:ask_choice` (a launched run has no live
mid-run responder — it is resumed asynchronously, D-010), plus
`plans:*`. The MCP *server* stays scoped to `agentmcp` (D-004) — the
breadth is in the tool allowlist, not a new server.
(Decided at P-011.)
