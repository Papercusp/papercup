---
title: Papercusp dogfooding — shared harnesses, P2P sync, cupboard
slug: papercusp-dogfood-2026-05-22
status: superseded
created: 2026-05-22
updated: 2026-05-22
owner: avi@storewolf.com
superseded_by: papercusp-dogfood-v2-2026-05-22
---

> **Superseded by [`papercusp-dogfood-v2-2026-05-22`](./papercusp-dogfood-v2-2026-05-22.md)**
> after a code-verified review. v2 adopts the hybrid sync model
> (git-as-sync for the bulk, Hyperbee for a 5-table live minority),
> carries a full table-by-table classification, resolves the
> repo-structure question (4 repos stay separate), and pulls
> dogfooding forward. This v1 is kept for history only.

# Papercusp dogfooding — shared harnesses, P2P sync, cupboard

## Now

**State:** **draft.** First-draft plan covering the full
dogfood-of-Papercusp project: bring the four papercup repos
(papercup, papercusp-desktop, the rust port, papercup-rust-mobile)
into the harness system as a tree of shared harnesses, build the
create-harness UI, integrate Discord, ship the Cupboard for public
shared harnesses, and stand up cross-engineer P2P sync (Hyperbee
for live collab state, Hyperdrive for peer-mirror git, Hyperswarm
for transport — "Path B").

This plan supersedes D-008 of `plan-agent-launch-2026-05-21` (plans
were workspace-scoped + harness-unaware); plans become a per-engineer
local concept anchored to a harness, while the *spec* and the
collab queue become shared via the harness repo + Hyperbee CRDT.

No code has been written yet. Path B was confirmed (peer-mirror via
Hyperdrive, not just auto-fetch); 19 commits from the prior plan
(`9fcda6b5`…`f01ef6c7`) remain local on this checkout, never pushed.

**Next action:** review-and-revise this draft; collapse the open
questions; then split into phases for execution in subsequent plans.

## Background

Papercusp has reached the point where it can manage its own
development. Today it doesn't: the engineers building it work in
ordinary git/GitHub flow, and Papercusp itself is built *outside* of
Papercusp tooling. The goal of this arc is to fix that — bring the
four papercup repos into the harness system, build the missing
collaboration substrate, and run the project's own queue through
Papercusp from now on.

Three problems block dogfooding today:

**1. The four papercup repos aren't harnesses.** There is no
harness-create UI at all (the backend route exists, only registered
on the dev page), no concept of a harness with submodules, and no
way to express "papercup root + 9 libs/* submodules" as one project
with one shared queue. Sheets is a harness; papercup is not.

**2. Cross-engineer sync doesn't exist.** Today Papercusp is a
single-engineer-per-install tool. There is no way for two engineers
working on the same project to see each other's feature queue,
issues, decisions, or status. The retired webapp's Zero layer was
intra-install sync (desktop ↔ browser on the same embedded PG); it
never crossed engineers and is now ripped out. The dogfood project
needs that substrate built.

**3. "Done" doesn't mean anything across engineers.** If Bob marks
F-042 done locally before pushing, Alice's view says "done" but she
has no commits to look at. Status needs to couple to a verifiable
git ref, and the team needs to know which engineer's branch holds
the work-in-progress code without polling GitHub.

The plan addresses all three: harness-create UI with four entry
points (new directory / GitHub URL / existing repo / harness link),
shared-harness model with private + public variants, the Cupboard
as a public discovery page, the full P2P sync stack (Hyperbee for
collab state, Hyperdrive peer-mirrors for code, Hyperswarm for
transport), reactivity wiring (`pg_notify` triggers → LISTEN → SSE
→ `useSyncQuery`), trust model, and status-with-git-refs
(`completion_ref`).

## Goals / non-goals

### Goals

- Papercusp's own four-repo project is a tree of harnesses in
  Papercusp, with the team's feature queue, issues, decisions, and
  status visible across engineers.
- Create-harness UI ships with four entry points covering: brand-new
  project, existing git repo on disk, GitHub URL, harness link
  (someone else's shared-harness identifier).
- Shared harnesses can be marked **private** (link-only access) or
  **public** (auto-listed on the Cupboard). Public listing is a
  product feature, not just a config bit.
- A Cupboard page (top-level navbar item) lists all public shared
  harnesses, reusing the marketplace UI patterns.
- Cross-engineer reactivity is sub-second for collab state (status
  flips, new features, decisions land on peers' screens in <1s) and
  <5s for code (peer-mirror via Hyperdrive eliminates the GitHub
  round-trip on engineer-to-engineer code propagation).
- Status couples to a verifiable git ref via a `completion_ref`
  column synced through Hyperbee; "done" requires the commit be
  present at the harness's canonical remote.
- Trust is per-harness, opt-in, local-only — untrusted contributors'
  changes are visible but quarantined until a local "trust" gesture.
- Plans stay **local** per engineer (workspace-scoped); the spec
  and the harness collab data stay **shared** (in the harness repo
  + Hyperbee CRDT respectively).

### Non-goals

- Replacing GitHub. GitHub remains the canonical remote for code
  and PRs. Hyperdrive peer-mirrors are an additive performance +
  resilience layer, not a substitute.
- A mobile build of the cupboard or create-harness flow. Desktop +
  web operator only in v1; mobile is downstream.
- Cross-workspace sync. A workspace is one engineer's desk; sync is
  per-harness, not per-workspace.
- Real-time co-editing of plan or spec documents. Plans are local;
  spec edits go through git like any other file. Live co-edit is
  not on the table.
- Replacing Discord with a built-in chat. Discord stays the team's
  chat tool; Papercusp integrates via link-out + deep-link, not
  embed.
- A built-in code review surface. PRs stay on GitHub.
- IPFS / Radicle / Fossil / git-bug / DoltgreSQL — all surveyed and
  ruled out (see §Background-decisions in the prior session's
  notes; rationale repeated under Decisions below).

### What "done" looks like

- I can create a "Papercusp" workspace, point it at the existing
  `/home/marsh-office/papercupai-workspace/papercup` checkout via
  the existing-repo flow, and see a harness tree with the root +
  9 libs/* submodules registered.
- A second engineer can install a harness link for the same shared
  harness on their machine, see the same feature queue + issues +
  decisions, and watch my status changes land on their screen in
  under a second.
- When I mark F-042 done, their UI shows it pending-confirmation
  until their machine has fetched my commit; once `git ls-remote`
  confirms the commit at the harness's canonical remote, the status
  flips to a confirmed-done state.
- The Cupboard navbar item lists every harness that's been marked
  public; clicking one offers a "install on my machine" flow that
  takes the harness link, clones the underlying repo (if listed),
  registers the harness, and joins the Hyperswarm topic.

## Design

### §1 The workspace / harness / sharing model

Three nouns, cleanly separated:

- **Workspace** = one engineer's local install. Holds the embedded
  PG, the operator UI, all per-engineer state (plans, agent runs,
  telemetry, drafts). NEVER synced across engineers. Disposable —
  if the embedded PG dies, the workspace rebuilds from its
  harnesses' committed state + local config. One workspace per
  install today; could be multiple later for hard isolation.

- **Harness** = one project under management, anchored to one git
  repository on disk. Identified by a slug. Lives at the
  `harness_<slug>` schema in PG; its on-disk root has a `.harness/`
  directory committed to the repo (config + shared state).
  A harness can be **private** (no sharing), **shared-private**
  (P2P-synced among engineers with the link), or **shared-public**
  (auto-listed on the Cupboard).

- **Sub-harness** = a code-location node inside a parent harness,
  corresponding to a git submodule. Shares the parent's queue +
  decisions + collab data; its code lives in a separate repo. Sub-
  harnesses don't have their own feature queue — features tag the
  sub-harness as a *component* axis on the parent's queue (see §6).

Sharing happens **at the harness level, not the workspace level**.
A workspace can hold a mix of private + shared-private + shared-
public harnesses, each with its own sync surface.

Cross-harness data within one workspace stays local (no engineer
needs my "papercup feature queue" colliding with my "personal
sandbox feature queue"). Within one harness, the queue is shared
across every engineer who's joined it.

### §2 Three classes of nested git directory — the classifier

When the create-harness flow walks an existing repo, it encounters
three structurally different "nested `.git`"s. The classifier:

1. **Submodule** — `.git` is a *file* whose contents are
   `gitdir: ../.git/modules/<name>`. Registered as a **sub-harness
   node** under the parent. Shares the parent's queue. Slug is
   path-qualified (e.g. `papercup/libs/sync`).

2. **Worktree** — `.git` is a *file* whose contents are
   `gitdir: <parent>/.git/worktrees/<name>`. NOT a new harness — a
   worktree is a phase / experimental branch checkout of the parent
   repo. Already covered by the existing phases system
   (staging/testing/production). The walk skips these.

3. **Standalone** — `.git` is a *directory*. A separate repository
   that happens to live nested in the filesystem. Registered as its
   own top-level harness (separate slug, separate queue).

Two additional rules complete the classifier:

4. **Tree root carries the queue.** A submodule's harness node
   holds metadata + component-tag identity, not its own queue. The
   parent owns features + issues + decisions. This is what makes
   "one unified queue across papercup + libs/*" work.

5. **Slugs are path-qualified for sub-harnesses.** Top-level slug
   is the repo's chosen slug (e.g. `papercup`); sub-harnesses are
   `<parent>/<relative-path>` (e.g. `papercup/libs/sync`,
   `papercup/libs/papergrid`).

### §3 Create-harness UI — four entry points

The route `POST /api/harness/projects` already exists (takes
`{ slug, path }`, calls `existsSync`, scaffolds the schema). Today
it's only callable from the dev page. The new UI lives on the
operator main surface — a "Create Harness" button on the harnesses
list page — and offers four entry points in a single wizard.

**Entry 1 — New local directory (not yet a git repo).**

User picks a target parent directory + names the project. The flow
creates the subdirectory, runs `git init`, writes `.gitignore` +
`.harness/config.json` (slug + scaffolding metadata), and registers
the harness. Optionally prompts to add a remote (skip / GitHub URL /
"set up later").

Acceptance:
- Empty target subdirectory does not already exist.
- `git init` succeeds and produces `.git/`.
- A first commit is created (`.harness/config.json` + `.gitignore`).
- The harness schema is provisioned and the harness appears in the
  list.

**Entry 2 — GitHub URL (clone).**

User pastes a GitHub URL + optional name override. The flow runs
`git clone <url> <target>` (with auth surfaced via the existing
GitHub OAuth integration if the repo is private), then proceeds as
Entry 3 from the freshly-cloned directory.

Acceptance:
- Clone succeeds; permissions surfaced clearly on auth failure.
- `.gitmodules` (if present) is honored by the submodule walk.
- Harness slug defaults to the repo name; user can override.

**Entry 3 — Existing local git repository.**

User picks a directory that already has a `.git/`. The flow:

1. Reads the repo's top-level `.gitmodules` (if any) to enumerate
   submodules.
2. For each entry, classifies via §2's rules — submodule, worktree,
   or standalone. Worktrees are skipped. Submodules are queued for
   sub-harness registration. Standalone nested repos are surfaced
   for user confirmation ("This isn't a submodule — register as a
   separate harness, or skip?").
3. Walks recursively into each submodule's directory to discover
   nested submodules.
4. Registers the root harness; then registers each submodule as a
   sub-harness node under the root with a path-qualified slug.
5. Writes `.harness/config.json` to the root (committed).

Acceptance:
- The walk terminates (cycle detection on `.gitmodules`).
- Every submodule listed in any `.gitmodules` is either registered
  as a sub-harness or explicitly skipped by the user.
- Worktrees of the same repo are not registered as harnesses.

**Entry 4 — Harness link (join a shared harness).**

A harness link is a single URL-safe identifier of the form:

```
papercusp://harness/<slug>?topic=<32-byte-hex>&remote=<url>&pub=<author-pubkey-hex>
```

The flow:

1. Parses the link. Validates `topic` (the Hyperswarm topic key for
   this harness's CRDT), `remote` (the canonical git remote), and
   `pub` (the author's public key, for trust-list initialization).
2. Asks the user where on disk to clone the underlying repo.
3. Runs `git clone <remote> <target>`.
4. Reads `.harness/shared.json` from the clone to confirm the topic
   key matches (defense against malicious links).
5. Joins the Hyperswarm topic via the operator's Hyperswarm process,
   bootstraps the local Hyperbee replica from the live peers,
   provisions the harness schema, and projects the CRDT state into
   PG.
6. Surfaces the harness in the list, with a "joined-via-link" badge
   until the user explicitly trusts the harness's author.

Acceptance:
- Invalid / malformed link → clear error, no partial state.
- `.harness/shared.json` mismatch → reject, no schema provision.
- First-replication progress is visible in the UI.
- After replication, the local PG holds the same feature/issue rows
  as the peers.

### §4 Private vs shared, private vs public

**Three states** for a harness:

| State | Sync | Discovery |
|---|---|---|
| **private** | No P2P. Local-only. | None — only the owner sees it. |
| **shared-private** | Hyperbee CRDT + Hyperdrive peer-mirror over Hyperswarm. | Link-only. Anyone with the harness link can join. |
| **shared-public** | Same as shared-private. | Listed on the Cupboard automatically. |

State transitions:

- **private → shared-private**: a wizard (see §5). One-way for v1;
  un-sharing a harness is a manual `state = private` flip in
  config + ask peers to remove their replicas (no automatic
  rollback). Acceptable for v1 since this is rare.
- **shared-private → shared-public**: a single config flip; updates
  the Cupboard listing via the existing registry pipeline (see §7).
- **shared-public → shared-private**: a single config flip; removes
  the Cupboard listing. Existing joiners keep their access (the
  topic key doesn't change).

The state is stored in `.harness/config.json` and committed; flipping
it is a git commit, which propagates via either GitHub or Hyperdrive
peer-mirror.

### §5 Share-this-harness wizard

Converting a private harness to shared-private is a 5-step wizard:

1. **Confirm git remote.** Sharing requires a canonical git remote
   (private peer-mirror is per-engineer, not authoritative). If
   the harness has no remote, prompt to add one (GitHub URL +
   `git push --set-upstream`).
2. **Generate Hyperswarm topic key.** A fresh 32-byte random key
   becomes the Hyperswarm topic for this harness's CRDT. Stored in
   `.harness/shared.json` (committed).
3. **Generate author keypair.** A fresh Ed25519 keypair becomes
   this engineer's identity for this harness. The public key is
   written to `.harness/shared.json` (committed); the secret stays
   in the workspace's local keystore.
4. **Seed Hyperbee.** The current harness state (features, issues,
   decisions, etc. — the rows categorized as HOLEPUNCH in §6) is
   serialized into the local Hyperbee replica, ready to replicate
   to peers when they join.
5. **Write `.harness/shared.json` and commit.** The config carries:
   topic key, author pubkey, "shared since" timestamp, public
   (true/false), optional Discord channel pointer (see §8). Other
   engineers receive this via `git pull`.

Output: a harness link the engineer can share via Discord / email /
QR code. Anyone with the link can join.

### §6 Table categorization — what syncs, what stays local

We have ~180 tables; sync is per-table. Three buckets:

**HOLEPUNCH (~37 unconditional + 9 conditional)** — replicated via
Hyperbee CRDT, projected into PG on each peer:

- Feature/issue queue: `harness_features_consolidated`,
  `harness_issues_consolidated`, `harness_feature_notes`,
  `harness_feature_prs`, `harness_chunk_plans`,
  `feature_audit_consolidated`.
- Project agreements: `harness_decisions`,
  `harness_proposals_shared`, `harness_escalations`,
  `harness_summaries`, `harness_design_artifacts`,
  `harness_text_artifacts`, `harness_tests`, `llm_test_*`
  fixtures/claims/findings.
- Project structure: `harness_phases`, `harness_promotions`,
  `harness_lanes`, `harness_checkpoints`, `harness_branch_actions`,
  `harness_snapshots*`.
- Cross-agent: `papercup_shared.messages/briefings/directives/etc.`,
  `{{SCHEMA}}.messages/directive_summaries/supervisor_notes`.
- Presence: `coord_presence`.
- Misc: `harness_experts/skills/snapshots`, `goals`,
  `snapshot_features`.

Conditional: 7 `org_*` tables (if org-overlay used); 2 plugin links
(`plugin_jira_sync.links`, `plugin_linear_sync.links`).

**LOCAL (~120 tables)** — never synced, per-engineer:

- All `plan_*` tables (`plan_revisions`, `plan_runs`,
  `plan_run_turns`, `harness_plan_review`, `harness_brainstorm`).
  Plans stay personal (user-confirmed).
- `project_spec_revisions` — rebuilt from `SPEC.md` git history on
  first boot; no need to sync the projection.
- All operational tables: agent runs, telemetry, personal config,
  UI state, plugin state, mobile, backups, voice.

**SECURITY (~22 tables, NEVER shared)**:

- All `papercusp_auth.*`.
- `users`, `user_sessions`, `user_preferences`.
- `auth_audit_log`, `auth_rate_limit`, `cooldown_marks`.
- `oauth_nonces`, `token_index`, `system_principals`.
- `power_user_sessions`, `pi_sessions`, `mobile_pair_tokens`,
  `spawn_sig_verification_failures`.
- All `operator_*credentials*`, `secrets`, `marketplace_token`,
  `publish_credentials`, `voice_credentials`,
  `search_provider_credentials`, `trust_store`.
- `jti_used`, `plugin_capability_grants`.

### §7 Cupboard — public harness directory

A new top-level navbar item, "Cupboard", reusing the marketplace
UI patterns (grid of cards, search, filters by language /
keywords / activity). Backed by a new `papercusp-cupboard`
registry, modeled on the existing `papercusp-registry` (template
marketplace pipeline shipped 2026-05-10).

**Pipeline**:

1. When a harness flips to `state: shared-public`, the operator
   POSTs the harness's public metadata (slug, name, description,
   topic key, remote URL, author pubkey, tags) to the cupboard
   registry.
2. The registry validates the submission, deduplicates by topic
   key (a re-publish updates the same listing), and adds it to
   the public index.
3. The Cupboard navbar item fetches the index and renders the
   cards.
4. Clicking "Install" surfaces a harness link prefilled from the
   listing → user picks a target directory → joins like Entry 4
   of §3.

**What is NOT in the registry**: the live state. The registry
holds discovery metadata only (a pointer); joining the harness
fetches the live state from peers via Hyperswarm.

**Listing visibility**: a harness can flip `state: shared-public`
→ `shared-private` to delist; new joins stop appearing in the
Cupboard but existing joiners keep their access.

### §8 Discord integration

Three options surveyed; **option 3 (link-out + deep-link)**
chosen.

**Iframe (option 1) is dead.** Discord serves `x-frame-options:
DENY` on `/app/*`; verified. Cannot embed in any pane.

**Auto-create channel on harness creation (option 2) was
rejected.** Requires a bot token, bot install with
`MANAGE_CHANNELS`, server dependency we've been avoiding.
Heavy for what it gives.

**Link-out + deep-link (option 3) — adopted.**

Storage: `.harness/config.json` carries an optional
`discord` field:

```json
{
  "discord": {
    "guildId": "1234567890",
    "channelId": "9876543210",
    "webhookUrl": "https://discord.com/api/webhooks/..."  // optional
  }
}
```

UI surfaces:

- **Switch-to-harness gesture** (explicit button or menu item, NOT
  on auto-switch) → fires
  `discord://discord.com/channels/<guildId>/<channelId>`. The
  Discord desktop client intercepts the URI scheme and focuses the
  channel.
- **Caveats**:
  - Focus-stealing on every fire — must be a user gesture, never
    automatic on harness switch.
  - Desktop-only — browser Discord ignores the scheme. Fallback:
    open the HTTPS URL `https://discord.com/channels/<guildId>/<channelId>`
    in a new tab.
  - No bot required. No `MANAGE_CHANNELS`. No server.

**Webhook augmentation (optional)**: if
`discord.webhookUrl` is set, the operator posts activity events
(new PR opened, escalation raised, status flipped to "done after
review") to the channel. Outbound only, single direction,
zero infrastructure beyond Discord's webhook URLs.

What is explicitly NOT integrated:

- No bot.
- No auto-create channel.
- No inbound Discord → Papercusp (no slash commands, no message
  ingest).
- No Discord ID linking to Papercusp users.

### §9 P2P sync — technical implementation

The sync stack has three layers, all over Hyperswarm transport:

```
+------------------------------------+
|   PG projection / UI reactivity    |  ← §10
+------------------------------------+
|   Hyperbee CRDT (collab state)     |  ← §9.1  — HOLEPUNCH rows
|   Hyperdrive (peer-mirror git)     |  ← §11   — code propagation
+------------------------------------+
|   Hyperswarm (DHT + holepunching)  |  ← §9.2  — transport
+------------------------------------+
|   WireGuard mesh (Defguard)        |  ← already deployed
+------------------------------------+
```

#### §9.1 Hyperbee for collab state

The 37+ HOLEPUNCH tables (§6) are NOT replicated row-for-row.
They're projected from a single Hyperbee per harness, keyed by
domain object id.

**Why Hyperbee, not raw Hypercore**: rows are key-value with range
queries (list all features by status, fetch one by id). Hyperbee
gives us a sorted key-value B-tree over a Hypercore log.

**Multi-writer**: each engineer maintains their own Hyperbee
(single-writer per `hypercore` is a hard rule); they're merged via
**Autobase** into a logically-shared view. Conflicts resolve via
operation timestamps + author pubkey tie-break.

**Key schema per harness**:

```
features/<feature_id>          → feature row
features/by-status/<status>/<feature_id>  → status index
issues/<issue_id>              → issue row
decisions/<decision_id>        → decision row
notes/<feature_id>/<note_id>   → feature note row
... etc per HOLEPUNCH table
schema-version                 → integer; bump on table-shape change
```

**PG projection**: a per-workspace `harness-sync` process maintains
the projection. On Hyperbee block apply:

1. Decode the operation (insert / update / delete + key + value).
2. Apply to the corresponding PG row inside a transaction.
3. Emit a `pg_notify` so the reactivity layer (§10) picks it up.

The projection is **eventually consistent**: a peer that's been
offline for hours catches up by replicating missed Hyperbee blocks
on reconnect; PG fills in via the same projection pipeline. PG is
a *cache* of the Hyperbee state, not the source of truth.

**Local writes**: when an engineer's operator writes a HOLEPUNCH
row (e.g. they mark F-042 done), the write path is:

1. Operator writes the row to its OWN Hyperbee (the engineer's
   single-writer log).
2. The PG projection picks up the change (same Hyperbee → PG
   pipeline as remote writes), so the UI sees it immediately.
3. Hypercore append automatically replicates over Hyperswarm to
   any peer currently swarming the topic key.
4. Autobase reconciles the new block into the shared view on
   every peer.

Latency: local-write to local-PG ~10ms (Hyperbee write + projection
roundtrip); local-write to peer-PG ~150-800ms on the mesh
(Hyperswarm propagation + projection).

**Schema migrations**: when a HOLEPUNCH table changes shape
(e.g. adds a column), bump `schema-version`. The projection
handles old + new shapes. Peers running older operators see new-
shape ops as no-ops on unknown fields; old-shape ops continue to
project under the new schema with defaults. The graceful path is
the same as adding a nullable column in a normal migration.

#### §9.2 Hyperswarm transport

One Hyperswarm process per workspace (NOT per harness — Hyperswarm
multiplexes many topics over one DHT presence). On boot:

1. The workspace boots its single Hyperswarm node.
2. For each `shared-private` or `shared-public` harness, the
   operator calls `swarm.join(topicKey)`.
3. Hyperswarm uses HyperDHT + UDP hole-punching to find peers
   sharing that topic.
4. Once connected, the Hyperbee + Hyperdrive replicators ride the
   same connection (multiplexed via the protomux layer Holepunch
   uses).

**Transport over WireGuard mesh**: the Defguard mesh (from mobile-
pairing work) is already up. Engineers on the mesh see each other
as same-LAN peers, so Hyperswarm's hole-punching is unnecessary
for in-mesh communication. Hyperswarm still uses the public DHT
for *discovery*, but the actual data flows over the mesh's direct
TCP/UDP path.

**Engineers off the mesh** still work — they take the standard
Hyperswarm hole-punching path. The mesh is a performance + privacy
enhancement, not a requirement.

#### §9.3 Why not the alternatives

(Summarized; full survey in the session history.)

- **Centralized (Zero, PowerSync, ElectricSQL, Triplit)**: rejected
  on the local-first principle and the "no server" stance.
- **Postgres-native replication (Spock, pglogical)**: loses on 9/11
  dimensions — sleeping laptops, NAT, conflict resolution, DDL
  replication. Wins only on "less app code"; paid back in
  operations.
- **DoltgreSQL**: breaks pgvector (semantic search + mem0 die),
  LISTEN/NOTIFY (locks subsystem dies), and our PL/pgSQL
  migrations.
- **Yjs/Automerge over WebSocket relay**: would need a relay
  server. Defeats the "no server" goal.
- **Automerge over Iroh / iroh-blobs**: viable alternative to
  Hyperswarm; Iroh is younger but cleaner. Chose Holepunch for
  ecosystem maturity (Hyperbee/Autobase are real, iroh-docs is
  newer). Revisit if Holepunch operations bite.
- **IPFS / Radicle / git-bug / Fossil**: all surveyed. Either dead,
  wrong tool, or value-system swap (sovereign hosting) not a
  problem-solver.

### §10 Reactivity — how the UI stays live

About 70% of this is already shipped. The gap is the producer
side (change-notify triggers) and one migration (plans-admin).

#### §10.1 What already exists

- **`libs/sync`**: `SyncProvider` + `useSyncQuery` hook; subscribes
  components to typed channels and invalidates TanStack Query
  caches on inbound deltas. Used today for harness-data sync
  intra-install (`SSEAdapter` is the live transport line).
- **`@restart/sse`** (152 tests): the unified SSE library. Producers
  + consumers on operator already migrated. Carries typed event
  envelopes.
- **TanStack Query 5.75**: cache + invalidation + background
  refetch. Component-level subscription via `useQuery`.
- **`harness-fs-watcher`**: chokidar process that mirrors `.harness/`
  + spec/plans file changes into PG with a 60s reconciliation
  sweep.
- **`workspace-listener.ts`**: a refcounted PG `LISTEN` per
  workspace on `ch_coord_<wsId>` channel; backs the locks
  subsystem.
- **`pg_notify`** at the schema level: the only existing emit is
  `009-workspace-scoping.sql:155` (`pending_events_inserted`).
  Domain triggers exist but don't emit notifications.

#### §10.2 The producer-side gap

Today there's no automatic "row changed → notify channel". Writes
just update tables. The reactivity-pipe ends there.

Fix:

1. Add a generic `emit_change_notify()` PL/pgSQL trigger function.
   On any `INSERT`/`UPDATE`/`DELETE` on a reactive table, emit
   `pg_notify('reactive_<schema>_<table>', json_payload)` with
   `{ op, schema, table, id, ts }`.
2. Attach the trigger to every HOLEPUNCH-projected table
   (the projection writes are what fire it) and to the LOCAL
   reactive tables the UI cares about.
3. One SSE endpoint per workspace, `/api/sync/stream`, LISTENs on
   all `reactive_*` channels and fans out to subscribed clients
   (multiplexed via the SSEAdapter's existing channel mechanism).
4. `useSyncQuery` already invalidates on incoming deltas; no
   client-side changes required.

#### §10.3 Plans-admin polling migration

The `plans-admin` UI (built in the prior plan) currently uses
`useAsyncJson` + 30s polling — an inconsistency I introduced. The
rest of the operator is on `useSyncQuery`.

Migration:

1. Tag the `plan_revisions`, `plan_runs`, `plan_run_turns` tables
   as reactive (attach `emit_change_notify`).
2. Replace `useAsyncJson` calls in `RevisionsPanel`, `AgentsPanel`,
   `RunDetailPanel`, `PlanDetail` with `useSyncQuery` against the
   matching channels.
3. Delete the 30s polling intervals.
4. Verify deltas land in <1s on local writes.

#### §10.4 Removing the Zero adapter

The webapp is retired; Zero is legacy. The `@rocicorp/zero`
dependency + Zero WS adapter code can be dropped after the
`useSyncQuery`/SSE path covers everything Zero covered. (Most of
it already does — see "ssE typed events" memory.)

### §11 Git / Hyperswarm / Hyperdrive integration — Path B

Path B (confirmed): Hyperdrive peer-mirrors of git for engineer-
to-engineer code propagation. GitHub remains canonical remote;
Hyperdrive is additive.

#### §11.1 Per-peer bare-mirror repo

On each engineer's machine, for each shared harness, the operator
maintains a bare git repository at:

```
~/.papercusp-workspaces/<ws-id>/peer-mirrors/<harness-slug>.git
```

The bare mirror is never `gc`'d (preserves all engineers' commits
forever) and is never `push`'d to GitHub (one-direction sink). It
is a normal git repository — `git fetch`/`git log`/`git show` all
work against it.

#### §11.2 Post-commit hook → bare mirror

In the working tree of each shared harness, a `post-commit` hook
installed by the create-harness flow:

```bash
#!/bin/sh
exec git push --quiet \
  file://"$HOME/.papercusp-workspaces/<ws-id>/peer-mirrors/<harness-slug>.git" \
  HEAD
```

Cost: ~50ms per commit (local file: push, no network).

The hook is installed via `.harness/hooks/post-commit` (a real file
in the worktree) symlinked to `.git/hooks/post-commit`. Engineers
who clone the repo get the hook automatically if the create-harness
flow installs the symlink — covered by Entry 3 + Entry 4 of §3.

#### §11.3 Hyperdrive replication of the bare mirror

The bare mirror directory is wrapped in a Hyperdrive, watched for
changes, and replicated to peers over the same Hyperswarm topic
the harness's Hyperbee uses (multiplexed on the topic via Holepunch
protomux).

Files in the bare mirror that get replicated:

- `objects/pack/*.pack`, `objects/pack/*.idx` (pack files — most
  commits live here after `git push` packs them).
- `objects/<ab>/<cd>...` (loose objects — newly written, pre-pack).
- `refs/heads/*`, `refs/tags/*`, `packed-refs`.
- `HEAD`.

Skipped (regenerable on each peer):

- `hooks/` (peer has their own).
- `info/` (cache).
- `logs/` (reflog, not authoritative).

The Hyperdrive is single-writer (the engineer's). To see another
engineer's mirror, the peer needs to swarm THEIR Hyperdrive key.
That key is announced via Hyperbee: each engineer publishes their
peer-mirror's drive key as a Hyperbee row keyed by author pubkey.

#### §11.4 Peer's `git fetch` from peer-mirrors

When Alice's operator sees Bob's status flip to "done" on F-042
via Hyperbee (sub-second), AND the corresponding `completion_ref`
points to a commit Alice doesn't have:

1. Alice's operator looks up Bob's peer-mirror Hyperdrive key
   (from Hyperbee).
2. Hyperdrive replicates the pack containing the missing commit
   from Bob's mirror to Alice's local Hyperdrive replica
   (~200-800ms on mesh).
3. Alice's operator runs `git fetch
   file://<bob-mirror-path>/<harness-slug>.git
   refs/heads/feature/F-042:refs/remotes/bob/feature/F-042`.
   ~100ms (file URL, no network).
4. Alice's main repo now has the commit; her UI flips F-042 from
   "pending Bob's code" to "code available; review locally" — or,
   if her trust list includes Bob and policy allows auto-fetch,
   automatically checks out to a `bob/F-042` branch for inspection.

Step 4 is the new affordance the dogfood UI surfaces: "Bob just
shipped F-042 to his mirror — view diff / check out locally / open
in editor".

#### §11.5 Fallback to GitHub

When the peer who owns the commit is offline OR Hyperdrive
replication times out (>5s, configurable), the operator falls back
to `git fetch origin` to pick up the commit via GitHub. The UX is
identical from the user's standpoint — slower path, same result.

#### §11.6 Visibility semantics

`git commit` immediately replicates to peers via Hyperdrive. This
is a semantic shift from "commit = private, push = public" to
"commit = peer-visible, push = canonical". Implications:

- WIP branches you weren't planning to share are visible to peers.
  Mitigation: a `wip/*` branch prefix convention that the
  post-commit hook skips (e.g. only branches matching
  `feature/*`, `fix/*`, `chore/*` push to the mirror).
- Accidental secret commits propagate to peers immediately. Same
  mitigation pattern git already requires — `git filter-repo` +
  coordinate with peers to drop the replicated objects.

The opt-out is the branch convention; the configuration lives in
`.harness/config.json`:

```json
{
  "peerMirror": {
    "enabled": true,
    "branchPattern": "^(feature|fix|chore|docs|refactor|test)/"
  }
}
```

A branch not matching the pattern does NOT mirror. Default pattern
is broad; engineers can tighten.

### §12 Trust model + status coherence

Two related sub-systems: who you trust, and what "done" means.

#### §12.1 Per-harness trust list

A local-only table `trusted_authors(harness_slug, author_pubkey,
trusted_at, trusted_by_user_id)`. **NEVER synced** — your trust
list is yours.

UI surfaces:

- When a feature row arrives from an untrusted author, it lands in
  a "Pending review" panel rather than the main queue. The row
  carries a "Trust <author>" button → trusts the pubkey for this
  harness.
- The orchestrator's feature-pickup logic gates on trust: an agent
  on my workspace won't claim a feature authored by an untrusted
  pubkey.
- A trust gesture is one-way for v1; un-trusting an author is a
  manual config flip.

The author pubkey is the same key minted by §5 step 3.

#### §12.2 `completion_ref` column

Every HOLEPUNCH-projected feature row carries a `completion_ref`
field:

```json
{
  "remote": "https://github.com/papercupai/papercup.git",
  "branch": "feature/F-042",
  "commit_sha": "abc123...",
  "pr_url": "https://github.com/papercupai/papercup/pull/123"
}
```

Status transitions:

- `in_progress` → `pending_done`: the engineer marks the work
  ready. `completion_ref` is set (commit_sha + branch); status is
  visible as "pending verification".
- `pending_done` → `done`: gated on `git ls-remote
  <completion_ref.remote> <completion_ref.branch>` returning a
  commit_sha that matches `completion_ref.commit_sha`. The
  operator does this check on read; an unverified `pending_done`
  never flips to `done` automatically.
- A separate `done_at_remote_ts` records when the verification
  first succeeded.

This pattern matches what Linear / Jira / GitHub Issues do: the
status is a label that points at a verifiable git fact, not a
free-floating claim.

## Scope

**In scope**

- The full create-harness UI (four entry points), including a new
  navigable "Create Harness" surface on the main harness list.
- The submodule walk + classifier (§2) and sub-harness registration.
- Shared-harness state machine (private / shared-private / shared-
  public) and the share-this-harness wizard.
- Hyperswarm process per workspace; Hyperbee per shared harness;
  Autobase for multi-writer merging.
- `emit_change_notify` trigger + multiplexed SSE endpoint; plans-
  admin migration off polling onto `useSyncQuery`.
- Peer-mirror bare-git pipeline: per-harness bare repo, post-commit
  hook, Hyperdrive replication, peer's auto-fetch on
  `completion_ref` change.
- The Cupboard navbar item + `papercusp-cupboard` registry.
- Discord deep-link gesture + optional outbound webhook.
- Trust model: `trusted_authors` table + Pending-review panel +
  trust-gesture UI + orchestrator gate.
- `completion_ref` column on `harness_features_consolidated` +
  verification gate on status flips.

**Out of scope**

- Mobile UI for any of the above. Desktop + web operator only in v1.
- Replacing GitHub or PR review.
- Real-time co-edit of plan / spec documents.
- Inbound Discord (slash commands, message ingest).
- Live presence beyond status flips (no per-cursor presence, no
  "Bob is viewing this plan" indicator in v1).
- Cross-workspace sync.
- A "leave harness" UI that revokes existing peers' access (would
  require topic-key rotation; v1 is one-way).

## Phase 0 — Foundations + spike

Before we commit to the full pipeline, prove the substrate works.

- **D-0.1** Spike: stand up a Hyperswarm node in the operator's
  Node process. Two workspace instances on the same WireGuard mesh
  should discover each other via a known topic key in <2s.
- **D-0.2** Spike: write + read against a Hyperbee. Verify
  Autobase merges two writers' logs into a consistent view.
- **D-0.3** Spike: replicate a small bare git repo via Hyperdrive
  between two workspaces; verify a `git fetch
  file://<replicated-mirror>` resolves a commit written on peer 1
  from peer 2.
- **D-0.4** Decision: confirm packaging — `@holepunchto/hyperswarm`,
  `@holepunchto/hyperbee`, `@holepunchto/hyperdrive`,
  `@holepunchto/autobase` all install cleanly in the operator's
  Node + Tauri bundle.
- **D-0.5** Document the spike findings; rebaseline phase 1+
  estimates if anything was wrong.

## Phase 1 — Create-harness UI shell (no sharing yet)

Ship the four-entry-point UI against the existing
`POST /api/harness/projects` route, with the submodule walk +
classifier for Entry 3. Sharing wiring lands in phase 4.

- **D-1.1** New `app/admin/harnesses/new` route + wizard component:
  step 1 picks entry-point (4-card chooser).
- **D-1.2** Entry 1 (new local dir): `git init` + first commit +
  scaffold `.harness/config.json` + register.
- **D-1.3** Entry 2 (GitHub URL): `git clone` with auth surfacing
  via existing GitHub OAuth; on success continue as Entry 3.
- **D-1.4** Entry 3 (existing local repo): the submodule walker.
  Reads `.gitmodules`, classifies each nested `.git`, recurses,
  registers root + sub-harnesses, prompts on standalone-nested
  ambiguities.
- **D-1.5** Entry 4 (harness link): parser + validator + clone +
  `.harness/shared.json` verification. (Joining the swarm itself
  lands in phase 4 once the swarm exists.)
- **D-1.6** Top-level "Create Harness" affordance on the
  harnesses list (currently dev-page-only).
- **D-1.7** Manual verification: bring the
  `/home/marsh-office/papercupai-workspace/papercup` checkout in
  as a harness via Entry 3 and observe the tree (root + 9 libs/*).

## Phase 2 — `completion_ref` + trust scaffold

Land the data-model pieces of the collab model before turning on
P2P sync; this lets us validate the UI + verification logic
locally first.

- **D-2.1** Add `completion_ref jsonb` column to
  `harness_features_consolidated` via migration. Backfill is null
  by default.
- **D-2.2** Update `features:update`-style verbs to accept
  `completion_ref` payload + validate shape.
- **D-2.3** Implement the `pending_done` → `done` verification
  gate: `git ls-remote` check inside the read path; surface
  `verified_done` vs `pending_done` in the API.
- **D-2.4** Add `trusted_authors` table to `harness_local`
  (LOCAL-only schema). Verbs: `trust:list`, `trust:add`,
  `trust:remove`.
- **D-2.5** UI: feature row carries a "verification badge"
  (pending / verified-at-remote / failed). Pending-review panel
  for rows authored by untrusted pubkeys.
- **D-2.6** Manual verification: mark a local-only test feature
  done with a fake `completion_ref`; observe pending state; push
  the commit; observe flip to verified.

## Phase 3 — Reactivity producer side

Close the §10.2 gap so the UI sees writes within 1s, without
polling.

- **D-3.1** `emit_change_notify()` PL/pgSQL trigger function +
  per-table attach helper.
- **D-3.2** Attach to all HOLEPUNCH-tagged tables + the LOCAL
  reactive tables (plan_*, run_*, etc.).
- **D-3.3** New `/api/sync/stream` SSE endpoint: per-workspace
  LISTEN on `reactive_*` channels; per-client subscription filter;
  multiplex via SSEAdapter.
- **D-3.4** Plans-admin migration: replace `useAsyncJson` + 30s
  polling with `useSyncQuery` in `RevisionsPanel`, `AgentsPanel`,
  `RunDetailPanel`, `PlanDetail`.
- **D-3.5** Drop `@rocicorp/zero` dep + Zero WS adapter code.
- **D-3.6** Manual verification: open two browser tabs on the same
  harness; write in one; observe the other update in <1s.

## Phase 4 — Hyperswarm + Hyperbee (collab state sync)

Cross-engineer sync of HOLEPUNCH rows.

- **D-4.1** New `harness-sync` subprocess: spawns one Hyperswarm
  node per workspace.
- **D-4.2** Per-harness Hyperbee schema (§9.1 key layout) +
  PG-projection pipeline.
- **D-4.3** Autobase wrapper merging N writers into one logical
  view per harness.
- **D-4.4** Share-this-harness wizard (§5): generate topic key +
  Ed25519 keypair, seed Hyperbee from current PG state, write
  `.harness/shared.json`, commit.
- **D-4.5** Wire Entry 4 of phase 1 to actually join the swarm
  after clone.
- **D-4.6** Schema-version handling for table-shape changes.
- **D-4.7** Manual verification: two workspaces on the mesh; one
  shares a harness, the other joins via link; status flip on one
  appears on the other in <1s.

## Phase 5 — Hyperdrive peer-mirror (Path B code sync)

Code propagation engineer-to-engineer.

- **D-5.1** Per-shared-harness bare-mirror init in the workspace
  data dir.
- **D-5.2** Post-commit hook install (`.harness/hooks/post-commit`
  symlinked to `.git/hooks/post-commit`); branch-pattern gate.
- **D-5.3** Hyperdrive wrap of the bare-mirror directory; replicate
  over the same Hyperswarm topic.
- **D-5.4** Publish peer's drive key via Hyperbee (one row per
  author pubkey).
- **D-5.5** Auto-fetch on `completion_ref` change: look up the
  author's drive key, replicate the pack, `git fetch` from the
  file URL.
- **D-5.6** UI: "Bob shipped F-042 to his mirror — view diff /
  check out / open in editor" affordances.
- **D-5.7** GitHub fallback on Hyperdrive timeout.
- **D-5.8** Manual verification: two engineers, mesh-connected;
  one commits on a `feature/*` branch; the other sees the commit
  reachable via `git log` within 3s WITHOUT either side pushing
  to GitHub.

## Phase 6 — Cupboard

Public discovery for shared-public harnesses.

- **D-6.1** New `papercusp-cupboard` registry (modeled on the
  template marketplace pipeline): repo + systemd unit + publish
  + index endpoints.
- **D-6.2** Operator publish flow on `state: shared-public` flip
  → POST harness metadata to the registry.
- **D-6.3** New "Cupboard" top-level navbar item + card grid UI
  (reuse marketplace components).
- **D-6.4** "Install" flow on a Cupboard card → harness link
  prefill → Entry 4 of the create-harness wizard.
- **D-6.5** Delist on `shared-public` → `shared-private` flip.
- **D-6.6** Manual verification: flip a shared harness to public;
  see it appear on the Cupboard; install on a second workspace
  from the listing.

## Phase 7 — Discord integration

- **D-7.1** Schema: `discord` field in `.harness/config.json`.
- **D-7.2** UI: per-harness Discord settings panel (guild + channel
  + optional webhook URL).
- **D-7.3** "Open Discord channel" gesture (button on harness
  detail + menu item) → fires the `discord://` URI; HTTPS
  fallback for browser Discord.
- **D-7.4** Outbound webhook poster: on PR opened, escalation
  raised, done-after-review status flip, POST a formatted message
  to the webhook URL.
- **D-7.5** Manual verification: configure a test channel; trigger
  each event class; observe the message appear in Discord.

## Phase 8 — Bring papercup into Papercusp (the actual dogfood)

The proof.

- **D-8.1** Create a "Papercusp" workspace via the desktop client.
- **D-8.2** Use Entry 3 to bring the
  `/home/marsh-office/papercupai-workspace/papercup` repo in as a
  harness; verify the tree.
- **D-8.3** Set up the shared-private config; generate the link.
- **D-8.4** Push the 19 unpushed commits from
  `plan-agent-launch-2026-05-21` to `origin/main` (gated on
  explicit user go-ahead, per the standing rule).
- **D-8.5** Backfill a starter feature queue from current
  PLAN.md / agent-coordination plans.
- **D-8.6** Document onboarding steps for the next engineer to
  join (harness link, mesh enrollment, trust list).
- **D-8.7** Run a first end-to-end exercise: file a feature on
  the papercup harness, scoper picks it up, ship via a worker
  agent, status flips through `pending_done` → `done` after the
  commit is pushed.

## Phase 9 — Verification

- **D-9.1** Unit coverage for the submodule classifier (each of
  the 5 rules + cycle detection).
- **D-9.2** Integration coverage for the Hyperbee → PG projection
  (write on one peer, read on another).
- **D-9.3** Integration coverage for the Hyperdrive peer-mirror
  pipeline (commit on one peer, `git log` confirms on another).
- **D-9.4** Playwright e2e for the create-harness wizard (each
  of the four entry points in a temp dir).
- **D-9.5** Manual exercise of the trust + completion-ref gating
  (untrusted author lands in pending; verification gate refuses
  flip until commit is at remote).
- **D-9.6** Performance: measure local-write → peer-PG latency
  (target <1s) and peer-mirror-fetch latency (target <3s on
  mesh).

## Decisions

### D-001 — Harness is the unit of sharing; workspace stays personal

A workspace is one engineer's desk. Multiple harnesses, each with
its own sharing state. Cross-workspace sync is out of scope — it's
not a real need.

This supersedes the earlier "shared workspace dir" idea I floated;
that put everyone's plans + telemetry into the shared scope, which
is wrong.

### D-002 — PG is a cache, never the source of truth

Committed inputs (git history + Hyperbee logs) reproduce PG. No
PGDATA in git. `embedded-pg-data/` stays in `.gitignore`
permanently. On fresh clone: schema from migrations + `ensure-
schema.ts` + `scaffoldHarnessSchema()`; HOLEPUNCH rows from
Hyperbee replication; LOCAL rows fresh per engineer.

### D-003 — Plans are LOCAL, spec is SHARED

User-confirmed. `plan_*` tables stay per-engineer. The spec
(`SPEC.md` + project structure docs) lives in git, in the harness
repo, syncs via either GitHub or the peer-mirror.

This supersedes D-008 of `plan-agent-launch-2026-05-21`, which
made plans workspace-scoped + harness-unaware. Plans become a
LOCAL-per-engineer concept that may optionally be anchored to a
harness via metadata, but their content never replicates.

### D-004 — Sharing unit = harness, sub-harness = submodule

The harness tree mirrors the git submodule tree. Tree root carries
the queue + plans + schema; submodules register as code-location
nodes sharing the root's queue. Slugs are path-qualified.

Discovered: papercup already has 9 submodules in `.gitmodules`
and the registry already has a `parent_slug` notion. This
formalizes what's half-built.

### D-005 — Five-rule classifier for nested git directories

Submodule (sub-harness), worktree (skip), standalone (separate
harness), root owns queue, slugs path-qualified. See §2.

### D-006 — Hyperbee + Autobase for HOLEPUNCH state

Not raw Hypercore (need range queries). Not Yjs/Automerge with a
WS relay (no relay server allowed). Not centralized (no server
allowed). Hyperbee per harness, multi-writer via Autobase,
projected into PG.

### D-007 — Hyperswarm transport over WireGuard mesh

One Hyperswarm node per workspace; multiplexes many harness
topics. WireGuard mesh (Defguard) provides the LAN-equivalent
path; Hyperswarm's hole-punching covers off-mesh peers. No
central relay.

### D-008 — Path B for code propagation (Hyperdrive peer-mirrors)

Per-engineer bare-git mirror; post-commit hook pushes locally to
the mirror; Hyperdrive replicates the mirror; peer auto-fetches
on `completion_ref` change. GitHub stays canonical remote.
Hyperdrive is additive, not a substitute.

Trade-off accepted: commit becomes peer-visible (not just push).
Mitigated by a branch-pattern gate (`feature/*`, `fix/*`, etc.) so
exploratory branches don't replicate by default.

This was the alternative to Path A (auto-fetch from GitHub on
status-flip notification). Path A is ~5s latency; Path B is <1s.
User chose Path B explicitly.

### D-009 — `completion_ref` couples status to a git fact

Every feature carries a `completion_ref` JSON column pointing at
a verifiable commit at the harness's canonical remote. Status
flip to `done` is gated on `git ls-remote` confirmation. Same
shape Linear / Jira / GitHub Issues use.

### D-010 — Trust is per-harness, opt-in, local-only

`trusted_authors` is a LOCAL table, never synced. Untrusted
contributors' rows land in a "Pending review" panel. Trust is a
local gesture; the orchestrator gates feature pickup on trust.

### D-011 — Public Cupboard via a registry, not a peer index

Discovery (who's sharing what publicly) is a small server-backed
service modeled on the template marketplace. Live state still
flows P2P; the registry only holds metadata pointers.

Compromise on the "no server" goal, accepted because discovery
is inherently a server-shaped problem and the alternative
(P2P discovery of public harnesses) is meaningfully harder for
no real upside.

### D-012 — Discord integration via deep-link + optional webhook

`discord://` URI scheme on user gesture; HTTPS fallback for
browser Discord; optional outbound webhook for activity events.
No bot, no auto-create channel, no inbound integration.

### D-013 — Iframe Discord is dead

Verified: `x-frame-options: DENY` on `/app/*`. Not a temporary
state; Discord won't reverse this. Option 1 of the original
Discord-integration brainstorm is permanently off the table.

### D-014 — Reactivity via `pg_notify` triggers + LISTEN + SSE

`emit_change_notify()` PL/pgSQL trigger function attached to all
reactive tables; one SSE endpoint per workspace LISTENs on
`reactive_*` channels and multiplexes to subscribed clients;
existing `useSyncQuery` handles invalidation on the client.

### D-015 — Plans-admin migrates off polling

Plans-admin's `useAsyncJson` + 30s polling was an inconsistency
introduced in the prior plan. Migrate to `useSyncQuery` once the
producer-side trigger pipeline lands.

### D-016 — Drop Zero entirely

The webapp is retired; Zero is legacy. After the SSE + producer
pipeline covers what Zero covered, drop `@rocicorp/zero` +
adapter code.

### D-017 — IPFS, Radicle, Fossil, git-bug, DoltgreSQL all ruled out

All surveyed; recorded for the record.

- IPFS: too heavy for the near-zero blob-storage surface we have.
  If/when blob storage is needed, Hyperdrive rides the stack we're
  already adopting.
- Radicle: real but a whole-stack swap (sovereign hosting). None
  of its three triggers (no-GitHub-account contributors, GitHub
  failure pain, cryptographic accountability as a security
  feature) apply now.
- Fossil: Fossil's collab-in-the-repo idea is what we're already
  doing with `.harness/` + Hyperbee; adopting Fossil itself would
  forfeit git's ecosystem.
- git-bug: same idea as Fossil's tickets, on git refs. Opaque
  storage vs our human-diffable markdown files. Skip.
- DoltgreSQL: breaks pgvector + LISTEN/NOTIFY + our PL/pgSQL
  migrations.

### D-018 — Spock vs Holepunch

Holepunch wins on 9/11 dimensions: sleeping laptops, NAT, conflict
resolution (CRDT vs LWW), schema migrations (DDL replication),
packaging, topology, auth, lock-in, battle-tested-for-shape.
Spock wins only on "less app code" — paid back in operations.

### D-019 — Real PG18, not pglite

Confirmed via `papercusp-desktop/src-tauri/src/main.rs:49`:
`embedded-postgres-server` is preferred, pglite is legacy. Drop
the pglite branch from the reactivity proposal and any new code.
PG triggers + LISTEN/NOTIFY is the only path.

### D-020 — Visibility semantics shift acknowledged

Path B changes "commit = private" to "commit = peer-visible".
Mitigated by branch-pattern gate. Surface this in onboarding docs;
do not silently change behavior.

### D-021 — Public vs shared-private is a single config flip

State machine: private / shared-private / shared-public. Both
directions of the shared-private ↔ shared-public flip are
trivial (just updates the registry listing). Private →
shared-private requires the wizard. shared-private → private is
manual + asks peers to remove their replicas (one-way for v1).

### D-022 — Harness link format

`papercusp://harness/<slug>?topic=<32-byte-hex>&remote=<url>&pub=<author-pubkey-hex>`.
URI scheme allows mobile / Discord / email-link interception.
`.harness/shared.json` in the cloned repo MUST match the link's
topic + pub, defending against malicious links.

### D-023 — Branch-pattern gate for peer-mirror push

Default pattern is broad (`^(feature|fix|chore|docs|refactor|test)/`).
Anything outside doesn't mirror. Configurable per-harness in
`.harness/config.json`.

## Open questions

### Q-1 — `harness_pending_issues`: LOCAL inbox or HOLEPUNCH team triage?

Two readings: a personal "things I might file later" buffer
(LOCAL), or a shared "stuff the team hasn't triaged" queue
(HOLEPUNCH). The schema doesn't tell us which.

### Q-2 — `harness_brainstorm`: LOCAL precursor or HOLEPUNCH shared session?

Same ambiguity. Brainstorms today look private-author-scoped, but
a shared brainstorm session is a plausible team feature.

### Q-3 — `{{SCHEMA}}.harness_proposals` — legacy?

The proposals hero bar was removed; is this table dead, or still
in use by some surface I missed?

### Q-4 — `plugin_kv`: per-plugin sharing choice?

A plugin might want some of its keys shared (config) and others
local (auth state). Should `plugin_kv` carry a per-row sharing
flag, or split into two tables?

### Q-5 — `org_*` tables: only if org-overlay is active?

Seven tables exist; the overlay isn't always present. Default
LOCAL until the overlay is wired up?

### Q-6 — `goals`: project-level shared, or per-agent personal?

Assumed project-level shared. Confirm no per-agent personal-goal
use exists.

### Q-7 — Are the 4 papercup repos genuinely independent, or could they collapse to a monorepo?

If they could collapse: the entire sub-harness / submodule story
simplifies (one harness, one repo, branch-based work). Worth a
hard look before building the multi-repo machinery.

### Q-8 — Umbrella superproject?

Alternative to "four separate harnesses linked by harness link":
add `papercusp-desktop`, the rust port, and `papercup-rust-mobile`
as submodules of papercup. Then the entire four-repo project is
one harness with one queue. Trade-off: invasive to the four
repos' git history; rejects the current independence.

### Q-9 — Per-engineer vs per-machine identity?

The §5 step 3 keypair is per-(workspace, harness). If an engineer
has two machines, they have two pubkeys for the same harness.
Should we mint a single per-engineer identity and copy it across
machines? Adds key-management surface for marginal benefit.

### Q-10 — Bare-mirror storage location

`~/.papercusp-workspaces/<ws-id>/peer-mirrors/<harness-slug>.git`
puts mirrors inside the workspace dir. Alternative: a shared
mirror dir per engineer (cross-workspace). The workspace-scoped
choice is simpler but means duplicate mirrors if the same
harness lives in two workspaces.

### Q-11 — Branch-pattern gate default

Proposed: `^(feature|fix|chore|docs|refactor|test)/`. Is this the
right set? Should `wip/*` be excluded explicitly? Is `main`
included (probably yes — pushing main to peer-mirror is fine
since main is canonical)?

### Q-12 — Topic-key rotation on un-share

V1 says un-sharing is one-way (existing peers keep access). Is
there a use case where un-sharing must actually revoke peers? If
so, that's a topic-key rotation + everyone re-joining, which is
disruptive.

### Q-13 — Cupboard moderation

If anyone can flip a harness to `shared-public`, anyone can list
on the Cupboard. Do we need a moderation surface (report listing,
admin delist)? For early dogfood the answer is "no, the listings
will be us", but eventually yes.

### Q-14 — Discord webhook payload format

Off-the-shelf or custom? GitHub's webhook payloads are a good
template; matching them lets the user reuse Discord's existing
GitHub webhook UI rendering.
