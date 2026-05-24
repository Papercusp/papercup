---
title: Papercusp dogfooding v2 — shared harnesses, hybrid sync, cupboard
slug: papercusp-dogfood-v2-2026-05-22
status: superseded
created: 2026-05-22
updated: 2026-05-23
owner: avi@storewolf.com
supersedes: papercusp-dogfood-2026-05-22
superseded_by: papercusp-dogfood-v3-2026-05-23
---

> **Superseded by [`papercusp-dogfood-v3-2026-05-23`](./papercusp-dogfood-v3-2026-05-23.md)**
> after the collaboration-first vision refinement. v3 promotes
> user-branches + the PR workflow to first-class primitives,
> forces GitHub OAuth for shared harnesses, adds the
> `contributors` + `feature_queue` Hyperbee tables and the
> orchestrator-claim flow over Hypercore sequence, and ships the
> Features / Contributors / PR sidebar tabs. v2 is kept for
> history; all carried decisions/questions are restated in v3.

# Papercusp dogfooding v2 — shared harnesses, hybrid sync, cupboard

## Now

**State:** **draft (v2).** Supersedes `papercusp-dogfood-2026-05-22`
(v1) after a code-verified review. v2 changes:

- **Sync model is now a hybrid** (D-006). Most shared collaborative
  state syncs **git-as-sync** (one file per row under
  `.harness/state/`, committed, propagated by the Hyperdrive
  peer-mirror). Only a small, genuinely-live minority syncs via
  **Hyperbee CRDT**. v1 put all 37 shared tables through Hyperbee;
  that was over-built.
- **§7 is a complete table-by-table classification** of every
  table in the schema (~155 tables) into LOCAL / GIT / HYPERBEE /
  SECURITY — built from how each table is *used*, not its name.
- **Q-7 / Q-8 resolved** (decided-first gate): the four papercup
  repos stay **separate** top-level harnesses; no monorepo, no
  umbrella superproject.
- The dogfood is **pulled forward** — single-engineer dogfooding
  starts after Phase 3, not Phase 8.
- Review fixes folded in: peer-mirror is **opt-in per-harness**
  (not on-by-default); `completion_ref` verification is a
  background poll, not on-read; phase items renumbered `P-NNN`;
  Phase 0 spike has a named fallback; phases carry S/M/L sizing.

**Next action:** review-and-revise this draft; then split into
per-phase execution plans.

## What changed from v1 — the review incorporation

A second agent reviewed v1 against the repo. The substantive
outcomes, all folded into v2:

- **Hybrid sync** (review point A). v1's §9.3 never compared
  Hyperbee-CRDT against committing collab state as files in git.
  The honest answer is neither extreme — it's a split by
  write-frequency. See §6, §7.
- **Decided-first gate** (review point B). The repo-structure
  question is a prerequisite, not an open question. Resolved
  below.
- **Dogfood pulled forward** (review point D). v1 gated the
  payoff behind 7 phases of infrastructure. v2 starts dogfooding
  papercup single-engineer right after reactivity ships.
- **LWW honesty** (review point E). The "CRDT" merge in v1 was
  last-writer-wins. v2 says so plainly and scopes where it's
  acceptable (§6.4).
- **Peer-mirror opt-in** (review point F). v1's default branch
  pattern broadcast every commit. v2: peer-mirror is off until
  explicitly enabled per-harness (§12, D-020).
- **`completion_ref` background poll** (review point G).
  `git ls-remote` on every feature-list read would be slow and
  rate-limited. v2 polls in the background and serves from cache
  (§13).
- **Factual fixes**: unpushed-commit count is not hardcoded
  (it was 19 in v1; actual at draft time is 46 and rising, a mix
  of several agents' work); `POST /api/harness/projects` only
  covers the existing-repo path — the other three entry points
  need new backend; the §2 classifier gains an explicit fourth
  case (a `libs/*` dir with no nested `.git` is just part of the
  parent repo); v1's "D-003 supersedes D-008" is downgraded to
  "amends".

## Background

Papercusp has reached the point where it can manage its own
development, but doesn't: the four papercup repos are built in
ordinary git/GitHub flow, outside Papercusp tooling. This arc
brings them in and builds the collaboration substrate the team
needs to run the project's own queue through Papercusp.

Three problems block dogfooding:

1. **The four papercup repos aren't harnesses.** No create-harness
   UI exists on the main surface (the backend route is dev-page
   only and only handles existing repos); no concept of a harness
   with submodules.
2. **Cross-engineer sync doesn't exist.** Papercusp is a
   single-engineer-per-install tool today. The retired webapp's
   Zero layer was intra-install only. The substrate to let two
   engineers share a feature queue must be built.
3. **"Done" doesn't mean anything across engineers.** If Bob
   marks F-042 done before pushing, Alice sees "done" with no
   commits. Status must couple to a verifiable git ref.

v2 addresses all three with the hybrid sync model, the
create-harness UI, the Cupboard, the trust model, and
`completion_ref`.

## Goals / non-goals

### Goals

- The four papercup repos are top-level harnesses in a workspace
  named `papercusp-workspace`; papercup's 9 `libs/*` submodules
  register as sub-harness nodes sharing papercup's queue.
- Create-harness UI ships with four entry points: new local
  directory (converts to git), GitHub URL (clones), existing local
  git repo (walks submodules), harness link (joins a shared
  harness).
- Shared harnesses can be **private**, **shared-private**
  (link-only join), or **shared-public** (auto-listed on the
  Cupboard).
- A Cupboard navbar item lists public shared harnesses, reusing
  marketplace UI.
- Cross-engineer collaborative state is correct and visible:
  document-shaped state via git, the live minority (queue status,
  presence) via Hyperbee at sub-second latency.
- Status couples to a verifiable git ref (`completion_ref`); "done"
  requires the commit be confirmed at the harness's canonical
  remote.
- Trust is per-harness, opt-in, local-only.

### Non-goals

- Replacing GitHub (canonical remote for code + PRs).
- Mobile UI for create-harness or cupboard.
- Cross-workspace sync (sync is per-harness).
- Real-time co-editing of plan/spec documents.
- Replacing Discord with built-in chat.
- A built-in code-review surface.
- Cross-engineer agent-to-agent messaging in v1 (the messaging
  tables stay LOCAL — see §7).

### What "done" looks like

- A `papercusp-workspace` workspace exists; papercup is brought in
  via the existing-repo entry point; the harness tree shows
  papercup + 9 `libs/*` sub-harness nodes.
- A second engineer joins the same shared harness via a harness
  link, sees the same feature queue + issues + decisions, and
  watches status changes land in under a second.
- Marking F-042 done shows pending-verification on peers until
  their machine confirms the commit at the canonical remote via
  `git ls-remote`, then flips to confirmed-done.
- The Cupboard lists every public harness; "Install" takes a
  harness link, clones, registers, joins the swarm.

## Decided-first gate — repo structure (resolves Q-7 / Q-8)

**Decision: the four papercup repos stay separate top-level
harnesses. No monorepo. No umbrella superproject.** (D-002.)

Consequences for the rest of the plan:

- There are four independent top-level harnesses: `papercup`,
  `papercusp-desktop`, the rust port, `papercup-rust-mobile`. Each
  has its own queue, its own shared/private state, its own
  Hyperswarm topic if shared.
- The §2 submodule classifier is **still required** — papercup
  itself has 9 `libs/*` git submodules that register as
  sub-harness nodes under the `papercup` harness.
- There is no cross-repo unified queue. If the team wants to see
  all four repos' queues together, that is a **UI-level grouping**
  (a "project" view that lists sibling harnesses), not a data-model
  merge. The grouping is cosmetic and out of scope for v1.
- This keeps each repo's git history independent — no invasive
  submodule-ification of the three app repos.

## Design

### §1 The workspace / harness / sub-harness model

Three nouns:

- **Workspace** = one engineer's local install. Holds the embedded
  PG, the operator UI, all per-engineer state. NEVER synced across
  engineers. The dogfood workspace is named `papercusp-workspace`.
- **Harness** = one project, anchored to one git repository. Slug-
  identified; `harness_<slug>` PG schema; a `.harness/` directory
  committed to the repo root holds shared config + the git-synced
  collaborative state (§7). A harness is **private**,
  **shared-private**, or **shared-public** (§4).
- **Sub-harness** = a code-location node for a git submodule.
  Shares the parent harness's queue + decisions; its code lives in
  a separate repo. No independent queue — features tag the
  sub-harness as a *component* axis on the parent's queue.

Sharing is per-harness, never per-workspace. A workspace holds a
mix of private and shared harnesses.

The harness `.harness/` directory is the on-disk home of all
git-synced shared state. Its layout:

```
.harness/
  config.json        — slug, state (private/shared-*), discord ptr,
                        peer-mirror opt-in, parent_slug for subs
  shared.json         — present only when shared: topic key,
                        author pubkeys, "shared since"
  hooks/post-commit   — peer-mirror push hook (when opted in)
  state/              — one file per row of every GIT-bucket table
    decisions/<id>.json
    summaries/<id>.json
    tests/<id>.json
    ... (one subdir per GIT-bucket table — see §7.3)
```

`.harness/state/` is the git-as-sync surface. The fs-watcher
mirrors it into PG; PG is a cache (D-001).

### §2 Nested-git classifier — four cases

When the create-harness flow walks an existing repo it encounters
four structurally different things. v1 enumerated three; the
fourth (review fix) is the common case and was missing.

1. **Submodule** — `.git` is a *file* reading
   `gitdir: ../.git/modules/<name>`. → register as a **sub-harness
   node**; shares the parent's queue; path-qualified slug
   (`papercup/libs/sync`).
2. **Worktree** — `.git` is a *file* reading
   `gitdir: <parent>/.git/worktrees/<name>`. → **skip.** A worktree
   is a phase/branch checkout, already modeled by the phases
   system.
3. **Standalone nested repo** — `.git` is a *directory* in a
   subfolder that is not a submodule. → prompt the user: register
   as a separate top-level harness, or skip.
4. **Plain directory (no nested `.git`)** — an ordinary subfolder,
   even one under `libs/`. → **not a harness of any kind**; it is
   just part of the parent repo. (papercup's `libs/` has 17 entries
   but only 9 are submodules; the other 8 — `flags`, `sse`,
   `host-platform`, `marketplace-public-ui`, `test-config`,
   `papercusp-export-state`, `papercusp-publish-auth`, and one
   more — are plain in-repo directories and produce no nodes.)

Plus:

5. **Tree root owns the queue.** A sub-harness node carries
   component identity + metadata, not its own queue. The root
   harness owns features + issues + decisions.
6. **Slugs are path-qualified for sub-harnesses**
   (`<parent>/<relative-path>`).

`parent_slug` already exists in the codebase (`harness/projects.ts`,
`execute-action.ts`, `autoloop.ts`, `all-kpis.ts`). §1–§2 build on
that; the implementing agent should read the live `parent_slug`
usage rather than reinvent it.

### §3 Create-harness UI — four entry points

`POST /api/harness/projects` exists
(`apps/operator/lib/endpoint-route/routes/harness/projects.ts` —
`defineTool` POST, takes `{slug, path}`, dup-slug → 409, calls
`scaffoldHarnessSchema`). **It rejects a non-existent path** — so
it covers only Entry 3. Entries 1, 2, 4 each need new backend.
The wizard lives on the main harnesses list page (today the route
is only reachable from the dev page).

**Entry 1 — New local directory (not yet git).**
Pick a parent directory + name. Backend (new): create the
subdirectory, `git init`, write `.gitignore` + `.harness/config.json`,
make a first commit, then register via the existing route. Optional
prompt to add a remote.
Acceptance: target subdir is empty/new; `git init` produces
`.git/`; first commit exists; harness appears in the list.

**Entry 2 — GitHub URL (clone).**
Paste a URL + optional name. Backend (new): `git clone` with auth
surfaced via the existing GitHub OAuth integration; on success
continue as Entry 3 from the clone.
Acceptance: clone succeeds; auth failures are legible;
`.gitmodules` honored by the Entry 3 walk.

**Entry 3 — Existing local git repository.**
Pick a directory with a `.git/`. Backend: the submodule walker —
read top-level `.gitmodules`, classify each nested `.git` via §2,
recurse into submodules, register the root then each sub-harness
node with a path-qualified slug, write `.harness/config.json`.
This is the one entry the existing route already partly serves.
Acceptance: walk terminates (cycle detection); every `.gitmodules`
entry is registered or explicitly skipped; worktrees are not
registered.

**Entry 4 — Harness link (join a shared harness).**
A harness link:

```
papercusp://harness/<slug>?topic=<32-byte-hex>&remote=<url>&pub=<author-pubkey-hex>
```

Backend (new): parse + validate; clone `<remote>` to a chosen
directory; read `.harness/shared.json` from the clone and confirm
its topic key + author pubkey match the link (defense against
malicious links); provision the harness schema; join the
Hyperswarm topic; bootstrap the local Hyperbee replica from peers;
project into PG; surface a "joined-via-link" badge until the user
trusts the author.
Acceptance: malformed link → clean error, no partial state;
`shared.json` mismatch → reject; replication progress is visible.

### §4 Private / shared-private / shared-public

| State | Sync | Discovery |
|---|---|---|
| **private** | none — local only | none |
| **shared-private** | git-as-sync + Hyperbee (§6) over Hyperswarm | link only |
| **shared-public** | same as shared-private | auto-listed on the Cupboard |

Transitions:

- **private → shared-private**: the wizard (§5).
- **shared-private ↔ shared-public**: a single config flip; updates
  / removes the Cupboard listing. The topic key does not change, so
  existing joiners keep access either way.
- **shared-* → private**: a config flip; existing peers keep their
  replicas (un-sharing is one-way in v1 — see Q-3).

State lives in `.harness/config.json` (committed).

### §5 Share-this-harness wizard

Converting private → shared-private, five steps:

1. **Confirm git remote.** Sharing requires a canonical remote. If
   absent, prompt to add one and `git push --set-upstream`.
2. **Generate Hyperswarm topic key.** A fresh 32-byte random key →
   `.harness/shared.json` (committed).
3. **Generate author keypair.** A fresh Ed25519 keypair = this
   engineer's identity for this harness. Public key →
   `.harness/shared.json`; secret → the workspace keystore (LOCAL).
4. **Seed the shared surfaces.** Serialize current GIT-bucket rows
   into `.harness/state/` files and commit; seed the local Hyperbee
   replica from current HYPERBEE-bucket rows.
5. **Write `.harness/shared.json` + commit.** Emit the harness link.

Output: a harness link to share via Discord / email / QR.

### §6 The hybrid sync model

#### §6.1 The principle

A table's sync mechanism is chosen by two questions:

1. **Does it need to be shared across engineers at all?** If no →
   LOCAL (or SECURITY if it must never leave the machine).
2. **If shared: does cross-engineer latency need to be sub-second?**
   - **No** — document-shaped, slow-changing, append-mostly →
     **GIT**: one file per row under `.harness/state/`, committed,
     propagated by git (peer-mirror or GitHub).
   - **Yes** — high write-frequency, the UI must reflect a peer's
     change within ~1s → **HYPERBEE**: CRDT log over Hyperswarm,
     projected into PG.

The naming of a table is irrelevant. `harness_proposals_shared`
and the whole `papercup_shared.*` schema carry "shared" from an
older multi-agent-within-one-install design; that word does not
make them part of the cross-engineer shared set. Each table below
is classified by current use (§7).

#### §6.2 GIT-as-sync — the bulk

Every GIT-bucket table becomes a directory of files under
`.harness/state/<table>/`, one JSON file per row, filename = row
id. Mechanism:

- **Write**: a write verb updates the PG row *and* writes the
  matching `.harness/state/` file in the same operation; the file
  write is what makes it shared.
- **Commit**: file changes are committed — debounced into a commit
  every N seconds (default 15s) so a burst of writes is one commit,
  not dozens. Commit message is generated (`harness: update 3
  decisions, 1 summary`).
- **Propagate**: the commit rides git — the Hyperdrive peer-mirror
  (§12) for sub-5s engineer-to-engineer, and `git push` to the
  canonical remote for durability.
- **Receive**: the existing `harness-fs-watcher` (chokidar) already
  mirrors `.harness/` file changes into PG. A peer's `git fetch`
  lands new `.harness/state/` files; the watcher projects them into
  PG; the reactivity layer (§11) lights up the UI.
- **Conflict**: two engineers editing *different* rows touch
  different files — no conflict. Two editing the *same* row's file
  is a real semantic conflict, surfaced as a normal git merge
  conflict for a human to resolve. This is a feature: divergent
  decisions should not silently merge.

Cost accepted: git history gains `harness: update …` commits.
Mitigated by the 15s debounce and by keeping high-frequency tables
*out* of GIT (they go to HYPERBEE). `git log` of real code is kept
readable because `.harness/state/` churn is visually distinct and
can be path-filtered.

#### §6.3 Hyperbee — the live minority

The HYPERBEE bucket is deliberately tiny (§7.2 — five tables).
These change too fast for a commit-per-change and need sub-second
cross-engineer latency. Mechanism:

- Per-harness Hyperbee (a sorted KV store over a Hypercore log),
  keyed by domain id.
- Each engineer writes their own Hypercore (single-writer rule);
  **Autobase** merges the N writers into one logical view.
- A `harness-sync` process projects Hyperbee → PG on every applied
  block and emits a `pg_notify` for the reactivity layer.
- Local writes go to the engineer's own Hyperbee first, project to
  local PG immediately (~10ms), and replicate to peers over
  Hyperswarm (~150–800ms on the mesh).

#### §6.4 Merge semantics — honest about LWW

The Hyperbee merge is **last-writer-wins per field**, tie-broken
by `(operation_timestamp, author_pubkey)`. It is **not** a
semantic CRDT. This is acceptable for the five HYPERBEE tables
because:

- Their fields are small scalars (a status enum, a flag, a
  presence heartbeat). LWW on a scalar is the correct merge.
- The genuinely-additive surfaces (`harness_feature_notes`,
  `harness_feature_prs`) are append-keyed by note/PR id — two
  engineers adding notes write *different* keys, so there is no
  field to clobber.
- The one real risk is two engineers flipping the *same* feature's
  *status* within the replication window. The UI surfaces this:
  when a projected status change overwrites a local change made
  <30s earlier, a "status was changed by <peer>" toast fires so
  the clobber is visible, not silent.

If, after dogfooding, status clobbers prove common, the upgrade
path is a real per-field CRDT for `harness_features_consolidated.
status` only — scoped, not a rewrite.

#### §6.5 The sync-policy registry — not a schema move

The bucket is a **per-table sync policy**, not a PG schema. We do
NOT move 130+ tables between schemas. Instead a single registry —
`SYNC_POLICY: Record<TableName, 'local'|'git'|'hyperbee'|'security'>`
— is the source of truth, consumed by:

- the share-this-harness wizard (what to seed),
- the GIT-as-sync file writer (which tables get `.harness/state/`
  files),
- the `harness-sync` Hyperbee projector (which tables it owns),
- a startup assertion that every table in the schema has exactly
  one policy entry (so a new migration that adds a table fails
  loudly until it is classified).

PG schemas stay as they are (`harness_shared`, `papercup_shared`,
`papercusp_auth`, `audit`, `{{SCHEMA}}`).

### §7 Full table classification

Built from how each table is used, verified against
`libs/papercusp/libs/db/sql/*` and `apps/operator/lib/ensure-schema.ts`.
~155 tables. Every table gets exactly one bucket. The implementing
agent must re-diff this against the live schema before coding (a
table may have been added since this draft).

#### §7.1 The four buckets

- **HYPERBEE** — shared, live, sub-second. CRDT over Hyperswarm.
- **GIT** — shared, document-shaped. One file per row in
  `.harness/state/`, committed.
- **LOCAL** — per-engineer, never synced. PG is source of truth.
- **SECURITY** — never synced, never even in the shareable set;
  credentials, tokens, sessions, auth.

#### §7.2 HYPERBEE — the live minority (5 tables)

| Table | Why HYPERBEE |
|---|---|
| `harness_shared.harness_features_consolidated` | The feature queue + status. The core shared live surface — a peer's status flip must show in <1s. |
| `harness_shared.harness_issues_consolidated` | The issue queue + status. Same reasoning as features. |
| `harness_shared.harness_feature_notes` | Notes shown live on feature cards; append-keyed by note id (no clobber). |
| `harness_shared.harness_feature_prs` | PR links surfacing live as PRs open; append-keyed by PR id. |
| `harness_shared.coord_presence` | Who is online / active. Presence is inherently live and high-churn. |

#### §7.3 GIT — document-shaped shared state

One file per row under `.harness/state/<table>/`.

| Table | Why GIT |
|---|---|
| `harness_shared.harness_decisions` | Project decisions. Append-mostly, document-shaped, low-frequency. |
| `harness_shared.harness_summaries` | Summaries. Document-shaped. |
| `harness_shared.harness_design_artifacts` | Design artifacts. Document-shaped. |
| `harness_shared.harness_text_artifacts` | Text artifacts. Document-shaped. |
| `harness_shared.harness_tests` | Test definitions / acceptance criteria. Slow-changing. |
| `harness_shared.harness_phases` | Phase definitions. Slow-changing project structure. |
| `harness_shared.harness_promotions` | Promotion records. Append-only. |
| `harness_shared.harness_lanes` | Lane definitions. Slow-changing. |
| `harness_shared.harness_checkpoints` | Checkpoint records. Append-only. |
| `harness_shared.harness_chunk_plans` | Scoper-produced chunk plans. Document-shaped; sub-second sync not needed. |
| `harness_shared.harness_escalations` | Escalations to the human supervisor. Low-frequency, document-shaped (carries a body embedding). Borderline — could move to HYPERBEE if live team-escalation visibility is wanted (see Q-4). |
| `harness_shared.harness_proposals_shared` | Proposal documents. **Possibly legacy** — the proposals hero bar was removed (Q-2). If confirmed dead, drop the table; if used, GIT. |
| `harness_shared.llm_test_fixtures` | Shared test fixtures. Document-shaped definitions. |
| `harness_shared.llm_test_claims` | Test claims. Shared test knowledge. |
| `harness_shared.llm_test_findings` | Test findings. Shared test knowledge. |
| `harness_shared.goals` | Project-level goals. Slow-changing, shared (Q-5 assumes no per-agent personal goals). |
| `harness_shared.harness_expert_feedback` | Curated expert feedback — shared project knowledge. |
| `harness_shared.harness_expert_turns` | Expert interaction records. Borderline (transcript-shaped); GIT as shared expert knowledge, but could be LOCAL if treated as per-engineer telemetry. |
| `harness_shared.identity_files` | Agent identity / persona definitions. Shared config. |
| `harness_shared.org_charter` | Org-overlay charter. **Conditional** — GIT only if the org overlay is active (Q-6); else LOCAL/unused. |
| `harness_shared.org_decisions` | Org-overlay decisions. Conditional (as above). |
| `harness_shared.org_departments` | Org-overlay departments. Conditional. |
| `harness_shared.org_inbox` | Org-overlay inbox. Conditional. |
| `harness_shared.org_notes` | Org-overlay notes. Conditional. |
| `harness_shared.org_outbox` | Org-overlay outbox. Conditional. |
| `harness_shared.org_projects` | Org-overlay projects. Conditional. |

Note: the project **spec** (`SPEC.md` and structure docs) is
already a file in the repo — inherently GIT, no table needed.
`project_spec_revisions` is its derived projection → LOCAL (§7.4).

#### §7.4 LOCAL — per-engineer, never synced

The bulk. PG is source of truth; nothing leaves the machine.

**Agent runs / spawns / telemetry:**

| Table | Why LOCAL |
|---|---|
| `harness_shared.agent_runs_consolidated` | Agent run records — my agents' executions on my machine. |
| `harness_shared.spawned_agents` | Spawn records — per-engineer. |
| `harness_shared.tool_invocations` | Tool-call telemetry — per-engineer. |
| `harness_shared.route_invocations` | Route-call telemetry — per-engineer. |
| `harness_shared.audit_log` | This workspace's audit trail. |
| `harness_shared.adaptive_telemetry` | Telemetry synthesis — per-engineer. |
| `harness_shared.telemetry_reports` | Telemetry reports — per-engineer. |
| `harness_shared.telemetry_reports_archive` | Archived telemetry. |
| `harness_shared.prompt_compositions` | Assembled-prompt cache/telemetry. |
| `harness_shared.llm_test_runs` | LLM-test *run results* — per-engineer (fixtures/claims/findings are GIT; runs are not). |
| `audit.action_executions` | Action-execution audit — per-engineer. |
| `audit.operator_actions` | Operator-action audit — per-engineer. |

**Plans (user-confirmed LOCAL):**

| Table | Why LOCAL |
|---|---|
| `harness_shared.plan_revisions` | Plan revision spine — plans are per-engineer. |
| `harness_shared.plan_runs` | Plan-agent launches — per-engineer. |
| `harness_shared.plan_run_turns` | Plan-agent transcripts — per-engineer. |
| `harness_shared.harness_plan_review` | Plan review state — per-engineer. |
| `harness_shared.harness_brainstorm` | Brainstorm precursor to plans — per-engineer (Q-1). |

**Operator config / UI / scanner state (all per-engineer):**

| Table | Why LOCAL |
|---|---|
| `harness_shared.operator_agent_config` | Per-engineer agent config. |
| `harness_shared.operator_settings` | Per-engineer operator settings. |
| `harness_shared.operator_preferences` | Per-engineer preferences. |
| `harness_shared.operator_user_profile` | Per-engineer profile. |
| `harness_shared.operator_prompt_user` | Per-engineer prompt overrides. |
| `harness_shared.operator_voice_prefs` | Per-engineer voice prefs. |
| `harness_shared.operator_agent_config` | Per-engineer. |
| `harness_shared.operator_budget` | Per-engineer spend budget. |
| `harness_shared.operator_budget_tiers` | Per-engineer budget tiers. |
| `harness_shared.operator_rate_limit` | Per-engineer rate limiting. |
| `harness_shared.operator_stt_spend` | Per-engineer voice spend. |
| `harness_shared.operator_tts_spend` | Per-engineer voice spend. |
| `harness_shared.operator_continue_chains` | Per-engineer chat continuation state. |
| `harness_shared.operator_conversations` | Per-engineer operator chat. |
| `harness_shared.operator_turns` | Per-engineer operator chat turns (carries embeddings). |
| `harness_shared.operator_dismissed_cards` | Per-engineer dismissed UI cards. |
| `harness_shared.operator_first_run` | Per-engineer first-run flag. |
| `harness_shared.operator_paused` | Per-engineer pause state. |
| `harness_shared.operator_idle_snapshot` | Per-engineer idle snapshot. |
| `harness_shared.operator_last_scan` | Per-engineer scan cursor. |
| `harness_shared.operator_scans` | Per-engineer scan results. |
| `harness_shared.operator_scan_locks` | Per-engineer scan locks. |
| `harness_shared.operator_scanner_session` | Per-engineer scanner session. |
| `harness_shared.operator_standing_candidates` | Per-engineer standing-proposal candidates. |
| `harness_shared.operator_oracle_memory` | Per-engineer oracle memory. |
| `harness_shared.operator_oracle_prompt` | Per-engineer oracle prompt. |
| `harness_shared.memory_feedback` | Per-engineer memory feedback. |
| `harness_shared.harness_dock_layouts` | Per-engineer dock/panel layout (UI state). |
| `harness_shared.harness_phase_last_used` | Per-engineer last-used phase (UI state). |
| `harness_shared.ui_clients` | Per-engineer UI client registry. |
| `harness_shared.ui_intents` | Per-engineer UI control intents. |
| `harness_shared.user_actions` | Per-engineer UI action log. |
| `harness_shared.toast_log` | Per-engineer error-toast history. |
| `harness_shared.user_preferences` | Per-engineer preferences (not secret, just personal). |
| `harness_shared.setup_wizard_state` | Per-engineer setup progress. |
| `harness_shared.routines` | Per-engineer scheduled routines. |
| `harness_shared.delegate_inbox` | Per-engineer delegate inbox. |
| `harness_shared.pending_events` | Per-engineer event queue (operational). |
| `harness_shared.pending_reviews` | Per-engineer approval-gate state (the *shared* fact is the feature status, not the gate). |

**Harness operational / derived state (per-engineer machine):**

| Table | Why LOCAL |
|---|---|
| `harness_shared.harness_registry` | The registry of harnesses in *this* workspace. |
| `harness_shared.projects` | This workspace's project list. |
| `harness_shared.harness_status` | Live status of the harness on this machine (dev server up/down etc.). |
| `harness_shared.harness_health` | Health of the harness on this machine. |
| `harness_shared.harness_git_log` | Cached git log — derivable from the repo. |
| `harness_shared.harness_hook_logs` | Git-hook execution logs — per-engineer. |
| `harness_shared.harness_smoke_test` | Smoke-test results — per-engineer. |
| `harness_shared.harness_project_files` | File index — derivable from the working tree. |
| `harness_shared.harness_branch_actions` | Branch-operation log — per-engineer git ops. |
| `harness_shared.harness_feature_debug_notes` | Debugger agent's working notes — per-engineer scratch (the *outcome* — a real issue or status — is what gets shared). |
| `harness_shared.harness_pending_issues` | Scanner/agent candidate issues before triage — per-engineer precursor; promotion to `harness_issues_consolidated` is the shared act (resolves Q-1 as LOCAL). |
| `harness_shared.harness_screenshots` | Screenshots — heavy, per-engineer. |
| `harness_shared.harness_snapshots_consolidated` | Snapshots — heavy, point-in-time, per-engineer (underlying state already syncs). |
| `harness_shared.snapshot_features` | Snapshot contents — per-engineer. |
| `harness_shared.harness_archives` | Archived harness state — per-engineer. |
| `harness_shared.project_spec_revisions` | Derived projection of `SPEC.md` git history — rebuildable, per-engineer. |
| `harness_shared.provision_state` | Machine provisioning state — per-engineer. |
| `harness_shared.provision_audit_log` | Provisioning audit — per-engineer. |

**Plugins / mobile / backup (per-engineer):**

| Table | Why LOCAL |
|---|---|
| `harness_shared.hidden_plugins` | Per-engineer hidden-plugin prefs. |
| `harness_shared.plugin_configs` | Per-engineer plugin config (encrypted at rest). |
| `harness_shared.plugin_enables` | Per-engineer plugin enablement. |
| `harness_shared.plugin_kv` | Per-plugin KV store — per-engineer (Q-7: a plugin wanting shared keys is a future per-plugin opt-in). |
| `harness_shared.plugin_reload_state` | Per-engineer plugin reload state. |
| `harness_shared.mobile_devices` | Per-engineer paired mobile devices. |
| `harness_shared.mobile_push_tokens` | Per-engineer push tokens. |
| `harness_shared.backup_events` | Per-engineer backup events. |
| `harness_shared.backup_snapshots` | Per-engineer backup snapshots. |
| `harness_shared.workspace_backup_settings` | Per-engineer backup settings. |

**Cross-agent messaging (currently intra-workspace — LOCAL):**

| Table | Why LOCAL |
|---|---|
| `papercup_shared.messages` | Agent-to-agent messages *within one workspace* (rust-port coord). "shared" in the schema name predates the cross-engineer model. Cross-engineer messaging is a non-goal for v1. |
| `papercup_shared.message_recipients` | Recipients of the above. |
| `papercup_shared.message_comments` | Comments on the above. |
| `papercup_shared.briefings` | Intra-workspace agent briefings. |
| `papercup_shared.directive_summaries` | Intra-workspace directive summaries. |

#### §7.5 SECURITY — never synced, never in the shareable set

| Table | Why SECURITY |
|---|---|
| `papercusp_auth.users` | Auth user records. |
| `papercusp_auth.sessions` | Auth sessions. |
| `papercusp_auth.magic_link_requests` | Magic-link requests. |
| `harness_shared.users` | User records. |
| `harness_shared.user_sessions` | User sessions. |
| `harness_shared.auth_audit_log` | Authentication audit log. |
| `harness_shared.auth_rate_limit` | Auth rate-limit counters. |
| `harness_shared.cooldown_marks` | Auth cooldown marks. |
| `harness_shared.oauth_nonces` | OAuth nonces. |
| `harness_shared.token_index` | Token index. |
| `harness_shared.system_principals` | System principals / identities. |
| `harness_shared.operator_credentials` | Operator credentials. |
| `harness_shared.operator_secrets` | Operator secrets. |
| `harness_shared.operator_marketplace_token` | Marketplace token. |
| `harness_shared.operator_publish_credentials` | Publish credentials. |
| `harness_shared.operator_voice_credentials` | Voice-provider credentials. |
| `harness_shared.operator_search_provider_credentials` | Search-provider credentials. |
| `harness_shared.operator_trust_store` | Operator trust store. |
| `harness_shared.pi_sessions` | Power-interface sessions. |
| `harness_shared.power_user_sessions` | Power-user sessions. |
| `harness_shared.mobile_pair_tokens` | Mobile-pairing tokens. |
| `harness_shared.spawn_sig_verification_failures` | Spawn-signature verification failures (security audit). |
| `harness_shared.plugin_capability_grants` | Plugin capability grants — a privilege table. |

#### §7.6 Legacy per-harness template + conditional tables

**`{{SCHEMA}}.*` — the per-harness template (`002-per-harness-template.sql`).**
The per-harness schema is legacy; canonical data lives in the
`harness_shared.*_consolidated` tables. Migration `032` already
replaced four with views.

| Table | Disposition |
|---|---|
| `{{SCHEMA}}.harness_features` | VIEW → `harness_features_consolidated` (HYPERBEE). |
| `{{SCHEMA}}.harness_issues` | VIEW → `harness_issues_consolidated` (HYPERBEE). |
| `{{SCHEMA}}.agent_runs` | VIEW → `agent_runs_consolidated` (LOCAL). |
| `{{SCHEMA}}.harness_snapshots` | VIEW → `harness_snapshots_consolidated` (LOCAL). |
| `{{SCHEMA}}.feature_audit` | Real legacy table → LOCAL. |
| `{{SCHEMA}}.agent_chats` | Real legacy table → LOCAL. |
| `{{SCHEMA}}.executed_actions` | Real legacy table → LOCAL. |
| `{{SCHEMA}}.messages` | Real legacy table → LOCAL. |
| `{{SCHEMA}}.supervisor_notes` | Real legacy table → LOCAL. |
| `{{SCHEMA}}.directive_summaries` | Real legacy table → LOCAL. |
| `{{SCHEMA}}.config_token` | Real legacy table → SECURITY (a token). |

The implementing agent should confirm whether the per-harness
template still scaffolds for new harnesses at all; if not, the
`SYNC_POLICY` registry can omit `{{SCHEMA}}.*` and the template
becomes dead code to delete.

**Conditional / plugin-created tables (not in core schema):**

| Table | Disposition |
|---|---|
| `plugin_jira_sync.links` | Created by the Jira plugin. GIT if the plugin is in use and the team wants shared issue links; else absent. |
| `plugin_linear_sync.links` | Created by the Linear plugin. As above. |
| mem0 pgvector collections | Created by mem0. LOCAL (per-engineer memory store). |

**Classification summary:** HYPERBEE 5 · GIT ~20 (7 of them
org-overlay-conditional) · LOCAL ~95 · SECURITY ~23 · legacy
`{{SCHEMA}}` 11. Every new migration must add a `SYNC_POLICY`
entry or the startup assertion (§6.5) fails.

### §8 Cupboard — public harness directory

A new top-level navbar item, "Cupboard", reusing the marketplace
UI (card grid, search, filters), backed by a new
`papercusp-cupboard` registry modeled on the existing
`papercusp-registry` (template marketplace, shipped 2026-05-10).

Pipeline:

1. On a harness flipping to `shared-public`, the operator POSTs
   public metadata (slug, name, description, topic key, remote
   URL, author pubkey, tags) to the cupboard registry.
2. The registry validates, dedups by topic key (re-publish updates
   the same listing), indexes it.
3. The Cupboard navbar item fetches the index, renders cards.
4. "Install" prefills a harness link from the listing → Entry 4
   of the create-harness wizard.

The registry holds **discovery metadata only** — never live state.
Joining fetches live state from peers. Flipping back to
`shared-private` delists; existing joiners keep access.

### §9 Discord integration — link-out + deep-link

Option 3 of the original brainstorm. Iframe (option 1) is **dead**
— Discord serves `x-frame-options: DENY` on `/app/*`, verified.
Bot-driven channel creation (option 2) rejected — bot token +
`MANAGE_CHANNELS` + a server dependency.

Storage: `.harness/config.json` carries an optional `discord`
field:

```json
{
  "discord": {
    "guildId": "...",
    "channelId": "...",
    "webhookUrl": "..."
  }
}
```

UI:

- A **user-gesture** button (harness detail + menu) fires
  `discord://discord.com/channels/<guildId>/<channelId>`; the
  Discord desktop client intercepts the scheme. Never fired
  automatically (focus-stealing). Browser-Discord fallback: open
  the `https://discord.com/channels/...` URL in a tab.
- If `webhookUrl` is set, the operator posts activity events (PR
  opened, escalation raised, done-after-review) to the channel —
  outbound only, no bot, no server.

Before building the webhook poster, check for an existing
outbound-notification surface in the operator and extend it
rather than adding a parallel one.

Not integrated: no bot, no auto-create channel, no inbound
Discord (slash commands / message ingest), no Discord-to-user ID
linking.

### §10 P2P transport

```
+------------------------------------------+
|  PG projection / UI reactivity   (§11)   |
+------------------------------------------+
|  Hyperbee CRDT  — 5 live tables  (§6.3)  |
|  git-as-sync    — ~20 tables     (§6.2)  |
|  Hyperdrive     — peer-mirror    (§12)   |
+------------------------------------------+
|  Hyperswarm (HyperDHT + holepunching)    |
+------------------------------------------+
|  WireGuard mesh (Defguard) — already up  |
+------------------------------------------+
```

One Hyperswarm node per workspace, multiplexing every shared
harness's topic. On boot: join `topicKey` for each shared harness;
the Hyperbee replicator and the Hyperdrive replicator ride the
same connection (protomux). On the WireGuard mesh, peers reach
each other directly; Hyperswarm still uses the public DHT for
*discovery* but data flows over the mesh. Off-mesh peers take the
standard hole-punching path. No central relay, ever.

### §11 Reactivity

~70% already exists. The gap is the producer side.

Already shipped: `libs/sync` (`SyncProvider` + `useSyncQuery`),
`@restart/sse` (152 tests), TanStack Query 5.75,
`harness-fs-watcher` (chokidar `.harness/` → PG mirror, 60s
reconcile), `workspace-listener.ts` (refcounted PG `LISTEN`).
Missing: a generic "row changed → notify" emitter.

To build:

1. `emit_change_notify()` PL/pgSQL trigger function — on
   `INSERT`/`UPDATE`/`DELETE` emit
   `pg_notify('reactive_<schema>_<table>', {op,id,ts})`.
2. Attach it to every reactive table (HYPERBEE + GIT projections
   and the LOCAL tables the UI shows).
3. One `/api/sync/stream` SSE endpoint per workspace — `LISTEN`s
   on all `reactive_*` channels, fans out to subscribed clients
   via the existing SSEAdapter multiplex.
4. `useSyncQuery` already invalidates on inbound deltas — no
   client change.

Plus two migrations: move plans-admin (`RevisionsPanel`,
`AgentsPanel`, `RunDetailPanel`, `PlanDetail`) off `useAsyncJson` +
30s polling onto `useSyncQuery`; and drop the legacy
`@rocicorp/zero` dependency + Zero WS adapter once the SSE path
covers it.

Real PG only — `embedded-postgres-server` (PG18, `wal_level=logical`
already on); pglite is legacy (`papercusp-desktop` `main.rs:49`).
No pglite branch.

### §12 Git / Hyperswarm / Hyperdrive — Path B (peer-mirror)

GitHub stays the canonical remote. The Hyperdrive peer-mirror is
an additive engineer-to-engineer fast path for code *and* for the
GIT-bucket `.harness/state/` files.

**Opt-in, off by default (review fix F).** v1 made the peer-mirror
broadcast every commit by default — dangerous, because a
replicated pack is on peers' disks permanently and `git filter-repo`
can't recall it. v2: the peer-mirror is **disabled until the
engineer enables it per-harness** in `.harness/config.json`:

```json
{ "peerMirror": { "enabled": false } }
```

Enabling it is a conscious act. Once on, all branches matching the
harness's branch pattern mirror — no per-branch friction.

Mechanism (when enabled):

1. **Per-peer bare mirror** at
   `~/.papercusp-workspaces/<ws-id>/peer-mirrors/<harness-slug>.git`
   — a normal bare repo, never `gc`'d, never pushed to GitHub.
2. **Post-commit hook** (`.harness/hooks/post-commit`, symlinked
   into `.git/hooks/`): `git push --quiet file://<mirror> HEAD`
   for branches matching the pattern (~50ms, local).
3. **Hyperdrive** wraps the bare-mirror directory, replicating
   pack files + refs over the harness's Hyperswarm topic. Each
   engineer publishes their drive key as one Hyperbee row keyed by
   author pubkey.
4. **Peer auto-fetch**: when a peer's `completion_ref` change
   (§13) references a commit Alice lacks, her operator looks up
   the author's drive key, Hyperdrive replicates the pack, and a
   `git fetch file://<peer-mirror> ...` lands it locally (~100ms).
5. **Fallback**: peer offline or Hyperdrive replication >5s →
   `git fetch origin` via GitHub. Same result, slower.

UI: "Bob shipped F-042 to his mirror — view diff / check out /
open in editor".

### §13 Trust model + status coherence

#### §13.1 Per-harness trust list

A LOCAL-only table `trusted_authors(harness_slug, author_pubkey,
trusted_at, trusted_by_user_id)` — **never synced**. New table;
classified LOCAL in `SYNC_POLICY`.

- A row arriving from an untrusted author lands in a "Pending
  review" panel, not the main queue, with a "Trust <author>"
  button.
- The orchestrator gates feature pickup on trust — an agent won't
  claim a feature from an untrusted pubkey.
- Trust is a one-way local gesture in v1; un-trusting is a manual
  config flip.

#### §13.2 `completion_ref`

A `completion_ref jsonb` column on `harness_features_consolidated`:

```json
{
  "remote": "...",
  "branch": "feature/F-042",
  "commit_sha": "abc123",
  "pr_url": "..."
}
```

Status flow:

- `in_progress` → `pending_done`: the engineer marks the work
  ready; `completion_ref` is set; the UI shows "pending
  verification".
- `pending_done` → `done`: gated on the commit being confirmed at
  `completion_ref.remote`.

**Verification is a background poll, not on-read (review fix G).**
`git ls-remote` on every feature-list read would be slow and
GitHub-rate-limited. Instead: a background job polls
`git ls-remote` for each `pending_done` feature, caches the result
+ `done_at_remote_ts` on the row, and feature-list reads serve
from cache. Poll interval ~30–60s; a manual "check now" button
exists for impatience.

## Scope

**In scope:** create-harness UI (4 entry points) + submodule
classifier + sub-harness registration; shared-harness state
machine + share wizard; the `SYNC_POLICY` registry + startup
assertion; git-as-sync (`.harness/state/` file-per-row +
fs-watcher projection); Hyperswarm + Hyperbee for the 5 live
tables + Autobase; `emit_change_notify` + multiplexed SSE +
plans-admin migration off polling; Hyperdrive peer-mirror
(opt-in); Cupboard + `papercusp-cupboard` registry; Discord
deep-link + optional webhook; trust model; `completion_ref` +
background verification.

**Out of scope:** mobile UI; replacing GitHub or PR review;
real-time co-edit of plan/spec; inbound Discord; cross-engineer
agent messaging; live presence beyond status + `coord_presence`;
cross-workspace sync; topic-key rotation on un-share; a cross-repo
unified queue (the 4 repos stay separate — any all-repos view is a
cosmetic UI grouping, deferred).

Phase sizing: **S** ≈ 1–3 days · **M** ≈ 1 week · **L** ≈ 2–3
weeks. This is 4–5 execution plans' worth of work; split after
review.

## Phase 0 — Foundations + spike  (M)

Prove the substrate before committing. **Named fallback: if this
phase fails on packaging or Autobase stability, the entire
HYPERBEE bucket falls back to GIT — the 5 live tables become
file-per-row too, accepting ~3–5s latency instead of <1s. Nothing
else in the plan changes.**

- **P-001** `todo` Spike: a Hyperswarm node inside the operator's
  Node process; two workspace instances on the WireGuard mesh
  discover each other on a known topic in <2s.
- **P-002** `todo` Spike: write/read a Hyperbee; verify Autobase
  merges two writers into a consistent view.
- **P-003** `todo` Spike: replicate a small bare git repo via
  Hyperdrive between two workspaces; `git fetch file://<mirror>`
  resolves a peer's commit.
- **P-004** `todo` Confirm `@holepunchto/*` (hyperswarm, hyperbee,
  hyperdrive, autobase — native deps UDX + sodium-native) bundle
  cleanly into the operator Node build *and* the Tauri desktop
  bundle. This is the highest packaging risk.
- **P-005** `todo` Write the spike findings doc; if P-004 fails,
  invoke the fallback and rebaseline phases 6–7.

## Phase 1 — Create-harness UI  (L)

Four entry points. Entry 3 reuses the existing route; 1/2/4 need
new backend.

- **P-006** `todo` New `app/admin/harnesses/new` wizard route +
  4-card entry-point chooser; "Create Harness" affordance on the
  main harnesses list.
- **P-007** `todo` Entry 3 (existing repo): the submodule walker —
  read `.gitmodules`, classify via §2's four cases, recurse,
  register root + sub-harness nodes with path-qualified slugs,
  write `.harness/config.json`. blocked-by: P-006
- **P-008** `todo` Entry 1 (new local dir): new backend — create
  dir, `git init`, scaffold `.harness/config.json` + `.gitignore`,
  first commit, register. blocked-by: P-006
- **P-009** `todo` Entry 2 (GitHub URL): new backend — `git clone`
  with GitHub-OAuth auth surfacing, then continue as Entry 3.
  blocked-by: P-007
- **P-010** `todo` Entry 4 (harness link): parser + validator +
  clone + `.harness/shared.json` verification. (Swarm join is
  wired in Phase 6.) blocked-by: P-006
- **P-011** `todo` Verify: bring the papercup checkout in via
  Entry 3; the tree shows papercup + 9 `libs/*` sub-harness nodes,
  the other 8 `libs/*` dirs produce none. blocked-by: P-007

## Phase 2 — completion_ref + trust scaffold  (M)

Data-model pieces, validatable single-engineer before P2P.

- **P-012** `todo` Migration: `completion_ref jsonb` on
  `harness_features_consolidated` (null default).
- **P-013** `todo` Feature write verbs accept + validate a
  `completion_ref` payload.
- **P-014** `todo` Background verification job: poll `git ls-remote`
  for `pending_done` features, cache result + `done_at_remote_ts`;
  reads serve from cache; manual "check now". blocked-by: P-013
- **P-015** `todo` `pending_done` → `done` gate driven by the
  cached verification. blocked-by: P-014
- **P-016** `todo` `trusted_authors` table (LOCAL) + `trust:list` /
  `trust:add` / `trust:remove` verbs; `SYNC_POLICY` entry.
- **P-017** `todo` UI: feature-row verification badge (pending /
  verified / failed); Pending-review panel for untrusted-author
  rows. blocked-by: P-015, P-016

## Phase 3 — Reactivity producer side  (M)

Independently shippable; lights up the whole UI.

- **P-018** `todo` `emit_change_notify()` PL/pgSQL trigger
  function + per-table attach helper.
- **P-019** `todo` Attach to reactive tables (HYPERBEE/GIT
  projections + UI-facing LOCAL tables). blocked-by: P-018
- **P-020** `todo` `/api/sync/stream` SSE endpoint — per-workspace
  `LISTEN` on `reactive_*`, per-client subscription, SSEAdapter
  multiplex. blocked-by: P-019
- **P-021** `todo` Migrate plans-admin (`RevisionsPanel`,
  `AgentsPanel`, `RunDetailPanel`, `PlanDetail`) off `useAsyncJson`
  + 30s polling onto `useSyncQuery`; delete the intervals.
  blocked-by: P-020
- **P-022** `todo` Drop `@rocicorp/zero` dep + Zero WS adapter.
  blocked-by: P-021
- **P-023** `todo` Verify: two tabs on one harness; a write in one
  lands in the other in <1s. blocked-by: P-021

## Phase 4 — Dogfood papercup, single-engineer  (S)

**The payoff, pulled forward.** No P2P needed — papercup runs as a
harness in `papercusp-workspace` on one machine.

- **P-024** `todo` Create the `papercusp-workspace` workspace via
  the desktop client.
- **P-025** `todo` Bring papercup in via Entry 3; verify the
  harness tree. blocked-by: P-011, P-024
- **P-026** `todo` Seed a starter feature queue from current
  PLAN.md / agent-coordination plans. blocked-by: P-025
- **P-027** `todo` Run a first single-engineer exercise: file a
  feature, scoper → worker → validator, status flips
  `in_progress` → `pending_done` → `done` after the commit is
  pushed. blocked-by: P-026, P-017, P-023

## Phase 5 — git-as-sync (the GIT bucket)  (M)

The bulk of cross-engineer state, shareable with no Holepunch yet.

- **P-028** `todo` The `SYNC_POLICY` registry (§6.5) + startup
  assertion that every table has exactly one policy.
- **P-029** `todo` `.harness/state/` file-per-row writer — GIT-bucket
  write verbs write the row file alongside the PG row.
  blocked-by: P-028
- **P-030** `todo` Debounced auto-commit of `.harness/state/`
  (15s window, generated message). blocked-by: P-029
- **P-031** `todo` Extend `harness-fs-watcher` to project
  `.harness/state/` files into PG on inbound `git fetch`.
  blocked-by: P-029
- **P-032** `todo` Share-this-harness wizard (§5) — topic key +
  Ed25519 keypair + seed `.harness/state/` + `.harness/shared.json`
  + emit harness link. blocked-by: P-030
- **P-033** `todo` Private ↔ shared-private ↔ shared-public state
  machine in `.harness/config.json`. blocked-by: P-032
- **P-034** `todo` Verify: two checkouts of one harness; a
  decision written in one appears in the other after `git pull`.
  blocked-by: P-031

## Phase 6 — Hyperswarm + Hyperbee (the 5 live tables)  (L)

The riskiest phase; de-risked by Phase 0.

- **P-035** `todo` `harness-sync` subprocess — one Hyperswarm node
  per workspace. blocked-by: P-005
- **P-036** `todo` Per-harness Hyperbee schema for the 5 HYPERBEE
  tables; Autobase multi-writer wrapper. blocked-by: P-035
- **P-037** `todo` Hyperbee → PG projection + `pg_notify` emit.
  blocked-by: P-036
- **P-038** `todo` HYPERBEE-bucket write path: write own Hyperbee,
  project to local PG, replicate over Hyperswarm. blocked-by: P-037
- **P-039** `todo` Schema-version handling for HYPERBEE table-shape
  changes. blocked-by: P-037
- **P-040** `todo` LWW clobber surfacing — "status changed by
  <peer>" toast (§6.4). blocked-by: P-038
- **P-041** `todo` Wire Entry 4 (P-010) to join the swarm after
  clone. blocked-by: P-038
- **P-042** `todo` Verify: two workspaces on the mesh; a status
  flip on one lands on the other in <1s. blocked-by: P-041

## Phase 7 — Hyperdrive peer-mirror (Path B)  (M)

- **P-043** `todo` Per-shared-harness bare-mirror init; opt-in
  `peerMirror.enabled` in `.harness/config.json` (default off).
- **P-044** `todo` Post-commit hook install (symlinked) + branch
  pattern gate. blocked-by: P-043
- **P-045** `todo` Hyperdrive wrap of the bare mirror; replicate
  over the harness topic; publish drive key via Hyperbee.
  blocked-by: P-044, P-036
- **P-046** `todo` Peer auto-fetch on `completion_ref` change;
  GitHub fallback on >5s timeout. blocked-by: P-045
- **P-047** `todo` UI: "peer shipped F-NNN — view diff / check out
  / open in editor". blocked-by: P-046
- **P-048** `todo` Verify: two mesh-connected engineers; one
  commits on a `feature/*` branch; the other reaches it via
  `git log` in <3s with neither pushing to GitHub. blocked-by: P-046

## Phase 8 — Cupboard  (M)

- **P-049** `todo` `papercusp-cupboard` registry — repo + systemd
  unit + publish/index endpoints (model on `papercusp-registry`).
- **P-050** `todo` Operator publish flow on `shared-public` flip →
  POST metadata; delist on flip back. blocked-by: P-049, P-033
- **P-051** `todo` "Cupboard" navbar item + card-grid UI (reuse
  marketplace components). blocked-by: P-049
- **P-052** `todo` "Install" on a card → harness-link prefill →
  Entry 4. blocked-by: P-051, P-010
- **P-053** `todo` Verify: flip a harness public; it appears on
  the Cupboard; install on a second workspace. blocked-by: P-052

## Phase 9 — Discord  (S)

- **P-054** `todo` `discord` field in `.harness/config.json` +
  per-harness Discord settings panel.
- **P-055** `todo` "Open Discord channel" gesture → `discord://`
  URI with HTTPS fallback. blocked-by: P-054
- **P-056** `todo` Outbound webhook poster (extend any existing
  notification surface) — PR opened / escalation / done-after-review.
  blocked-by: P-054
- **P-057** `todo` Verify: configure a test channel; trigger each
  event class; observe in Discord. blocked-by: P-056

## Phase 10 — Multi-engineer dogfood + verification  (M)

- **P-058** `todo` Share the papercup harness (P-032); a second
  engineer joins via harness link + mesh enrollment + trust.
  blocked-by: P-042, P-034
- **P-059** `todo` Onboarding doc for joining engineers.
- **P-060** `todo` Unit coverage for the §2 classifier (4 cases +
  cycle detection).
- **P-061** `todo` Integration coverage: GIT-as-sync round-trip
  and Hyperbee → PG projection round-trip.
- **P-062** `todo` Integration coverage: Hyperdrive peer-mirror
  (commit on one peer, `git log` on another).
- **P-063** `todo` Playwright e2e for the create-harness wizard
  (all four entry points in temp dirs).
- **P-064** `todo` Performance: local-write → peer-PG latency
  (<1s target) and peer-mirror fetch (<3s on mesh).
- **P-065** `todo` Multi-engineer exercise: both engineers file +
  pick up features on the shared papercup queue; trust gate +
  `completion_ref` verification both exercised. blocked-by: P-058

## Decisions

### D-001 — PG is a cache; committed inputs reproduce it
Git history + Hyperbee logs are the source of truth; PG is a
projection. `embedded-pg-data/` is never committed (106M binary,
PG-version-locked). A fresh clone rebuilds PG: schema from
migrations + `ensure-schema.ts`; GIT rows from `.harness/state/`;
HYPERBEE rows from replication; LOCAL rows fresh.

### D-002 — The four papercup repos stay separate
No monorepo, no umbrella superproject (resolves Q-7/Q-8 of v1).
Four independent top-level harnesses. The §2 submodule classifier
is still needed for papercup's own 9 `libs/*` submodules. Any
all-repos view is a cosmetic UI grouping (D-022), not a data
merge.

### D-003 — Harness is the unit of sharing; workspace is personal
Sharing is per-harness. The workspace (`papercusp-workspace` for
the dogfood) holds per-engineer state and never syncs.

### D-004 — Sub-harness = submodule; four-case classifier
The harness tree mirrors the git submodule tree. Submodule →
sub-harness node; worktree → skip; standalone nested repo →
separate harness; plain directory → not a harness. Root owns the
queue; slugs path-qualified.

### D-005 — Hybrid sync: git-as-sync bulk, Hyperbee live minority
Most shared collaborative state is document-shaped and syncs via
git (one file per row in `.harness/state/`). Only 5 genuinely-live
tables sync via Hyperbee CRDT. This corrects v1, which routed all
37 shared tables through Hyperbee. Rationale: §6.1.

### D-006 — Tables classified by use, not name
`harness_proposals_shared` and the `papercup_shared.*` schema
carry "shared" from an older within-one-install design; that does
not place them in the cross-engineer shared set. Every table is
classified in §7 by current use. Full list there.

### D-007 — Sync policy is a per-table registry, not a schema move
A `SYNC_POLICY` map (table → local/git/hyperbee/security) is the
source of truth. No tables move between PG schemas. A startup
assertion fails if any table lacks a policy entry.

### D-008 — The Hyperbee merge is last-writer-wins, scoped honestly
Not a semantic CRDT — LWW per field, tie-broken by (timestamp,
pubkey). Acceptable because the 5 HYPERBEE tables hold small
scalars or append-keyed rows. The one real risk (concurrent
same-feature status flips) is surfaced with a clobber toast, not
hidden. Upgrade path: a real per-field CRDT for the status field
only, if dogfooding shows it is needed.

### D-009 — Path B peer-mirror, opt-in and off by default
Hyperdrive peer-mirrors propagate code + `.harness/state/` files
engineer-to-engineer. GitHub stays canonical. The mirror is
disabled until enabled per-harness — a replicated pack is
permanent on peers' disks, so broadcasting must be a conscious
act. Corrects v1's broadcast-by-default.

### D-010 — `completion_ref` couples status to a git fact
A feature's `done` state requires its commit confirmed at the
canonical remote. Verification is a background poll with cached
results — never a per-read `git ls-remote`.

### D-011 — Trust is per-harness, opt-in, local-only
`trusted_authors` is LOCAL, never synced. Untrusted authors' rows
quarantine in a Pending-review panel; the orchestrator gates
feature pickup on trust.

### D-012 — Discord: deep-link + optional webhook
`discord://` URI on user gesture, HTTPS fallback, optional
outbound webhook. No bot, no auto-create channel, no inbound
integration. Iframe is dead (`x-frame-options: DENY`, verified).

### D-013 — Cupboard via a registry, not peer discovery
Public-harness discovery is a small server-backed registry
(modeled on the template marketplace). Live state still flows
P2P; the registry holds only metadata pointers. A deliberate,
scoped compromise on "no server" — discovery is server-shaped.

### D-014 — Reactivity via `pg_notify` triggers + LISTEN + SSE
`emit_change_notify()` on reactive tables; one per-workspace SSE
endpoint multiplexes `reactive_*` channels; `useSyncQuery`
invalidates on the client.

### D-015 — Real PG only; drop Zero and pglite
`embedded-postgres-server` (PG18) is the backend; pglite is
legacy. `@rocicorp/zero` + the Zero WS adapter are removed once
the SSE path covers them.

### D-016 — Dogfooding is pulled forward
Single-engineer dogfooding of papercup starts at Phase 4 — after
create-harness + completion_ref + reactivity — not after all P2P
infrastructure. P2P, Cupboard, and Discord layer on while already
dogfooding.

### D-017 — Plans LOCAL, spec SHARED (amends prior D-008)
`plan_*` tables are per-engineer LOCAL. The spec (`SPEC.md`) is a
file in the repo, shared via git. This **amends** D-008 of
`plan-agent-launch-2026-05-21` (plans workspace-scoped +
cross-harness) — that decision mostly stands; v2 only adds
optional harness-anchor metadata. It is not a supersession.

### D-018 — Phase 0 has a named fallback
If the Holepunch spike fails on packaging or Autobase stability,
the HYPERBEE bucket collapses into GIT — the 5 live tables become
file-per-row, accepting ~3–5s latency. The rest of the plan is
unaffected. There is always a shippable plan.

### D-019 — Holepunch over Spock and centralized stores
Holepunch wins 9/11 dimensions vs Spock (sleeping laptops, NAT,
conflict resolution, DDL replication, packaging, topology, auth,
lock-in, shape). Centralized engines (Zero, PowerSync,
ElectricSQL, Triplit) are rejected on the no-server stance.
DoltgreSQL is rejected — it breaks pgvector, LISTEN/NOTIFY, and
the PL/pgSQL migrations.

### D-020 — IPFS, Radicle, Fossil, git-bug ruled out
All surveyed. IPFS: too heavy for a near-zero blob surface.
Radicle: a whole-stack sovereignty swap, no current trigger.
Fossil: its collab-in-the-repo idea is what `.harness/state/`
already does; adopting Fossil forfeits git's ecosystem. git-bug:
same idea in opaque storage vs human-diffable files.

### D-021 — Harness link format
`papercusp://harness/<slug>?topic=<32-byte-hex>&remote=<url>&pub=<pubkey-hex>`.
The cloned repo's `.harness/shared.json` must match the link's
topic + pubkey, defending against malicious links.

### D-022 — A cross-repo unified queue is cosmetic UI, deferred
With the four repos separate (D-002), there is no shared data
model across them. A combined "all four queues" view, if wanted,
is a read-only UI grouping over sibling harnesses — out of scope
for v1.

## Open questions

### Q-1 — `harness_brainstorm` / `harness_pending_issues` LOCAL?
v2 classifies both LOCAL (brainstorm = personal plan precursor;
pending_issues = per-engineer scanner findings, promoted to the
shared issue queue on triage). Confirm this matches intent, or
move either to GIT if they are meant to be collaborative.

### Q-2 — Is `harness_proposals_shared` legacy?
The proposals hero bar was removed. If the table is dead, drop it
entirely; if still written, it stays GIT. Needs a code check
during Phase 5.

### Q-3 — Is topic-key rotation on un-share ever needed?
v1/v2 make un-sharing one-way (existing peers keep access).
Revoking peers would require topic-key rotation + everyone
re-joining. Is there a real use case, or is one-way fine
permanently?

### Q-4 — `harness_escalations` GIT or HYPERBEE?
Classified GIT (document-shaped, low-frequency). If the team wants
a peer's escalation to surface in <1s, it moves to HYPERBEE — a
6th live table. Decide based on whether escalations are urgent
enough to warrant it.

### Q-5 — `org_*` tables — is the org overlay active?
The 7 `org_*` tables are classified GIT *conditionally*. If the
org overlay is not in use, they are dormant and the `SYNC_POLICY`
entry can be LOCAL/unused. Confirm overlay status.

### Q-6 — `goals` — project-level only?
Classified GIT (project-level shared). Confirm there is no
per-agent personal-goal use that would need a LOCAL split.

### Q-7 — `plugin_kv` — per-plugin shared opt-in later?
Classified LOCAL. A plugin may eventually want some keys shared
(config) and others local (auth). Out of scope for v1; flagged so
the registry can grow a per-plugin-key policy later.

### Q-8 — Cupboard moderation?
Anyone can flip a harness public and list it. For early dogfood
the listings are all us, so no moderation surface. Eventually a
report/delist surface is needed — when?

### Q-9 — Per-engineer or per-machine identity?
The §5 keypair is per-(workspace, harness). An engineer on two
machines gets two pubkeys for one harness. Mint one per-engineer
identity copied across machines, or accept per-machine? Per-machine
is simpler; per-engineer is cleaner for trust lists.

### Q-10 — Discord webhook payload shape?
Match GitHub's webhook payload format (so Discord's existing
GitHub-webhook rendering applies) or a custom format? GitHub-shaped
is recommended.

### Q-11 — Bare-mirror storage location?
v2 puts mirrors in the workspace dir
(`~/.papercusp-workspaces/<ws-id>/peer-mirrors/`). A per-engineer
shared mirror dir (cross-workspace) avoids duplicate mirrors if
one harness lives in two workspaces. Workspace-scoped is simpler;
confirm it is acceptable.

### Q-12 — Is the `{{SCHEMA}}` per-harness template still live?
If new harnesses no longer scaffold the per-harness template
(everything is in `harness_shared.*_consolidated`), the 11
`{{SCHEMA}}.*` tables and `002-per-harness-template.sql` are dead
code to delete. Confirm during Phase 5.
