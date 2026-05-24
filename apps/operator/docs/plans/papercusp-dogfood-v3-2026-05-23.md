---
title: Papercusp dogfooding v3 — collaboration-first, user branches, PR workflow
slug: papercusp-dogfood-v3-2026-05-23
status: superseded
created: 2026-05-23
updated: 2026-05-23
owner: avi@storewolf.com
supersedes: papercusp-dogfood-v2-2026-05-22
---

> **Superseded by [`papercusp-dogfood-v4-2026-05-23`](./papercusp-dogfood-v4-2026-05-23.md)** — v4 incorporates the second round of multi-agent review (GitHub-Gist attestation for identity, deterministic Autobase merge-order arbitration, auto-approve + auto-merge as independent toggles, deferred issue-collab schema, `github_user_id` everywhere, bulk PR poll spec, `state: private` Phase 4, `pr_reviewer_settings` identity unification, `current_worker` derived, peer-mirror conflict-escalation, vditor for markdown authoring).


# Papercusp dogfooding v3 — collaboration-first, user branches, PR workflow

## Now

**State:** **draft (v3).** Supersedes
`papercusp-dogfood-v2-2026-05-22` after a vision refinement:
collaboration is treated as the **core experience**, not a sync
layer over a single-user model. Concretely:

- **Each contributor gets a long-lived `user/<handle>` git
  branch** + a worktree of that branch as their working directory.
  Branches are GitHub-pushed; the branch is the unit of in-progress
  work isolation.
- **Features stay in PG (HYPERBEE-synced); not on branches.**
  v2 had me about to put feature files on user branches — that
  was wrong. Features are PG-canonical, Hyperbee-synced rows. The
  branch carries code only.
- **Queue and working state are Hyperbee rows pointing at
  features.** Pulling a feature into your queue is a pointer,
  not a copy.
- **The orchestrator picks features no one else is working on**
  (orchestrator-claim arbitrated by Hypercore sequence, no central
  lock).
- **GitHub is required** for shared harnesses (PR + permissions
  surface). Behind a `PrHost` abstraction so GitLab/Gitea drop in
  later; v1 implements GitHub only.
- **PR lifecycle**: agent ships code on your branch → PR opens to
  main → auto-approved if PR author's pubkey is on a `pr-review`
  role-holder's trust list, else manual review → merge flips the
  feature's status to `shipped`.
- **Trust is deliberate.** No "trust anyone" toggle. A
  `pr-review` role-holder maintains their own trust list (LOCAL,
  never synced).
- **Sync-with-main is a UI gesture** (status indicator + button +
  auto-rebase-on-push). One worktree per harness — main is a
  virtual view.

**Next action:** review-and-revise this draft, then split into
per-phase execution plans.

## What changed from v2

| v2 | v3 |
|---|---|
| Joining = clone + join swarm + provision schema. | + create `user/<github-handle>` branch on GitHub, switch worktree to it, write a Contributor row to Hyperbee. |
| Features sync via Hyperbee (PG canonical). Unchanged. | Unchanged — but the row gains `created_by_pubkey`, `queue_pointers`, `working_users[]`, and the merge path stamps `completion_ref`. |
| HYPERBEE bucket = 5 tables. | HYPERBEE bucket = 7 tables (+ `contributors`, + `feature_queue` pointer rows on the feature row itself or a new table — see §7). |
| Orchestrator picks features from a local queue. | Orchestrator picks features whose `working_users` is empty, via a distributed Hypercore-sequence claim. |
| `completion_ref` is verification-only. | `completion_ref` is verification + the merge surface (auto-set on PR merge). |
| GitHub optional. | **GitHub required** for shared harnesses, behind a `PrHost` abstraction. |
| Trust = `trusted_authors`, used by the orchestrator's feature-pickup gate. | Trust = `trusted_authors`, used by the orchestrator's gate **and** by the `pr-review` role's auto-approve gate. UI to add/remove is a deliberate dropdown — no "trust anyone" toggle. |
| Harness sidebar has the standard tabs. | + **Features tab** (cross-user dedup'd feature list) + **Contributors tab**. |
| Avatar from… unspecified. | GitHub avatar if linked; deterministic identicon from pubkey otherwise. |
| Two-tier "Members vs Contributors". | One tier — **Contributors** — covers anyone who joined. The act of joining is the contribution-of-intent. |

Mechanical fixes also folded: workspace-named `papercusp-workspace`
(v2 already); D-/P- ID hygiene preserved.

## Background

Papercusp's value proposition is **a tool for a team of humans + a
team of agents to ship software together**. v2 treated that as
"each engineer has their own Papercusp; we sync state between
them." v3 treats it as "the harness is a shared project with
contributors; each contributor has their own branch + worktree;
PRs are how code moves between contributors and main."

The substrate is the same as v2 — Hyperbee CRDT for the live
collaborative minority, git-as-sync (file-per-row in
`.harness/state/`) for the document-shaped bulk, Hyperdrive
peer-mirror for fast engineer-to-engineer code propagation,
Hyperswarm for transport, GitHub for canonical remote + PR
surface. v3 reorganizes the *experience* on top of that
substrate around contributors + branches + PRs.

## Goals / non-goals

### Goals

- Collaboration is the default, not a feature flag. Joining a
  shared harness immediately makes you a Contributor with a branch
  and a worktree.
- Features have one canonical source — PG row — and one canonical
  sync mechanism — Hyperbee. There is exactly one F-042 across
  every engineer; no per-branch divergence.
- Pulling a feature into your queue is a one-click pointer write,
  not a file copy.
- The orchestrator on any engineer's machine picks features that
  no one is currently working on, with first-claim-wins
  arbitration that needs no central authority.
- Working on a feature flows: code in your branch's worktree → PR
  to main → trust-gated auto-approve OR manual review → merge →
  feature row flips to `shipped` with a stamped `completion_ref`.
- Trust is deliberate; the act of approving someone else's work to
  land on main requires an explicit trust gesture per
  (reviewer, harness, contributor).
- Onboarding a new engineer is: paste harness link → GitHub
  OAuth → clone + branch + join swarm → ready. <2 minutes.

### Non-goals

- Replacing GitHub. PRs, branch protection, the merge button stay
  on GitHub for v1.
- Real-time co-edit of code. Two engineers can't simultaneously
  edit the same file in the same branch; that's what branches
  exist to prevent.
- Cross-engineer agent-to-agent messaging (unchanged from v2).
- Mobile UI for create-harness, contributors, or PR review.
- A built-in code review UI that competes with GitHub's. We deep-
  link to GitHub for the actual PR diff and review form.
- Inbound Discord; cross-workspace sync; topic-key rotation on
  un-share (v2 non-goals carry forward).
- "Trust anyone" auto-approve — strictly off the table.

### What "done" looks like

- A `papercusp-workspace` workspace exists; papercup is brought in
  via the existing-repo entry point; the harness tree shows
  papercup + 9 `libs/*` sub-harness nodes.
- The first engineer flips the harness to shared-private,
  generates a link, sends it to a teammate.
- The teammate pastes the link; the wizard force-links their
  GitHub account; their `user/<handle>` branch is created on
  GitHub; their worktree opens to that branch; they appear in
  the Contributors tab on both machines within a second.
- The first engineer files a feature; the teammate pulls it into
  their queue with one click; their pubkey appears as a queue
  member on the feature row.
- The teammate's orchestrator picks up the feature (no one else
  is working on it), generates code in their worktree, pushes the
  branch, opens a PR to main.
- The first engineer holds the `pr-review` role and has added the
  teammate to their per-harness trust list. The PR auto-approves
  and merges. The feature row flips to `shipped` with a stamped
  `completion_ref`.

## Decided-first gate (carried from v2)

**The four papercup repos stay separate top-level harnesses. No
monorepo. No umbrella superproject.** (Resolves Q-7/Q-8 of v1.)

A cross-repo "all four queues" view is a cosmetic UI grouping
over sibling harnesses, deferred from v1 scope.

The §2 classifier is still needed for papercup's own 9 `libs/*`
submodules.

## Design

### §0 The collaboration model

The thread through every decision: **what does it mean to be a
contributor to a harness?**

#### §0.1 Identity

Each contributor has two ids:

- **Pubkey** (Ed25519, minted on first join of a shared harness;
  one keypair per (workspace, harness) — see Q-9 v2). The pubkey
  is the primary id. It signs Hyperbee writes; it appears on
  feature rows as `created_by_pubkey`; trust lists key off it.
- **GitHub login** (force-linked on join — §3). Drives the
  `user/<handle>` branch name, the avatar, and authority on the
  GitHub remote. The login is *derived* identity; the pubkey is
  *root* identity.

If GitHub is unavailable (rare — only when an account hasn't
linked yet) the avatar falls back to a deterministic identicon
generated from the pubkey. The Contributors tab never has a
blank-avatar row.

#### §0.2 The workspace and the user-branch

Each contributor has, per shared harness:

- A **`user/<github-handle>` git branch** on the canonical GitHub
  remote.
- A **worktree** on disk at the harness's working directory,
  checked out to `user/<github-handle>`. This is the only
  worktree per harness. Main is accessed via the sync gesture
  (§0.5) — never as a second physical checkout.
- A **Contributors row** in Hyperbee (one per (harness, pubkey),
  carrying `pubkey`, `github_login`, `joined_ts`, `display_name`).

When the orchestrator runs in this engineer's workspace, all
code-writing happens in this worktree, on this branch.

#### §0.3 Where features live — PG / Hyperbee, never branches

Features are PG-canonical rows in
`harness_shared.harness_features_consolidated`, synced via
Hyperbee. **No feature file is written to git**, ever. The branch
holds code; features live alongside.

A feature row carries:

- `id` (the F-042 identifier)
- `title`, `description`, `acceptance`
- `status` enum: `todo` / `in_queue` / `working` / `pending_done`
  / `done` / `shipped` / `deprecated`
- `created_by_pubkey` — the user who filed it (immutable)
- `working_users[]` — pubkeys currently working on it (today
  always size 0 or 1 per the orchestrator's gate, but the data
  model is plural for future expansion)
- `current_worker` — the one pubkey actively writing code (when
  multiple `working_users` exist later); equals
  `working_users[0]` in the size-1 case
- `completion_ref` — `{ remote, branch, commit_sha, pr_url }`
  stamped on PR merge (v2's design carried forward)
- `done_at_remote_ts`, `shipped_at_ts`

Queue membership is a sibling Hyperbee table — `feature_queue` —
keyed by `(feature_id, pubkey)`. Pulling F-042 into your queue
writes one row; un-queuing deletes it. The Features tab
deduplicates by `feature_id` and renders the queue members as
avatars under each card.

#### §0.4 The four-state machine

```
   filed                                                    merged
     │                                                        │
     ▼      pull into queue       set active / orchestrator    ▼
  ┌─────┐  ──────────────────►  ┌─────────┐  ──────────►  ┌────────┐
  │ todo│                       │in_queue │                │working │
  └─────┘                       └─────────┘                └────────┘
     ▲                              ▲                          │
     │                              │ unqueue                  │ ship: PR open
     │                              ◄────────                  ▼
     │                                                    ┌───────────┐
     │                                                    │pending_done│
     │                                                    └───────────┘
     │                                                          │
     │                                                          ▼
     └── deprecate ◄──── any state                          ┌────────┐
                                                            │ shipped│
                                                            └────────┘
```

- `todo` — filed; not in anyone's queue.
- `in_queue` — at least one user has it in their queue.
- `working` — at least one user has `working_users` membership.
- `pending_done` — the worker opened a PR; awaiting trust-gated
  review and merge.
- `shipped` — the PR merged; `completion_ref` confirms commit at
  the canonical remote (v2 §13's verification gate runs as
  background poll).
- `done` (terminal but pre-shipped) — not used in the
  collaborative flow; reserved for features completed without a
  PR (e.g. spec change with no code).

#### §0.5 Sync-with-main — UI gesture trio

Three small surfaces, no new substrate:

1. **Status indicator** on the harness sidebar: "behind main by N
   commits, ahead by M." Refreshes on `git fetch` (which the
   operator runs in the background every ~30s).
2. **"Sync with main" button** — click runs
   `git fetch origin main && git rebase origin/main`; surfaces
   conflicts inline; aborts cleanly on conflict, prompting the
   user to resolve.
3. **Auto-rebase on push** — when an agent finishes a chunk and
   is about to `git push user/<handle>`, the operator runs a
   pre-push rebase against `origin/main`. If clean, push. If
   conflict, hold the push, surface the conflict for resolution,
   never silently force-push.

No background rebase. Conflicts always come to the user.

#### §0.6 The distributed orchestrator-claim

When an orchestrator on any engineer's machine considers a
feature for pickup, it must answer one question: **is anyone
else already working on this?**

Mechanism — Hypercore-sequence first-claim-wins:

1. The orchestrator reads the feature row from its local PG
   projection of Hyperbee. If `working_users` is non-empty, skip.
2. Otherwise, the orchestrator appends a *claim* entry to its
   own Hypercore writer for the harness: `{ kind: 'claim',
   feature_id: 'F-042', ts: ... }`. This is the act of "I am
   going to work on this."
3. The claim replicates over Hyperswarm to peers. Autobase
   merges every writer's claims by their Hypercore sequence
   (`writer_pubkey, seq`), producing a totally-ordered view.
4. When the merged view is applied, the orchestrator's PG sees
   `working_users` updated to include its pubkey. If two
   orchestrators raced, both claims are in the merged view in
   sequence order — the first claim's writer becomes
   `current_worker`; the second claim's writer harmlessly joins
   `working_users` (or, in v1's size-1 default, gets dropped
   from the merge and re-tries).
5. If the orchestrator's own claim "lost" the merge, its claim
   step retries with a different feature.

No central lock, no distributed consensus protocol. The
Hypercore append-only log + Autobase's deterministic merge IS
the arbiter. Latency: ~100ms–1s on the mesh; the worst case is
the orchestrator picks a feature, the claim lands second, and
it has to backtrack — cheap.

### §1 Workspace / harness / sub-harness / user-branch

The four-noun model (one new from v2):

- **Workspace** — one engineer's local install
  (`papercusp-workspace` for the dogfood). Per-engineer state.
  Never synced. Holds embedded PG, the operator UI, and the
  on-disk roots of each harness.
- **Harness** — one project, anchored to one git repository.
  Slug-identified; `.harness/` directory carries shared config +
  the git-synced collaborative state.
- **Sub-harness** — a code-location node for a git submodule
  inside a parent harness. No independent queue.
- **User-branch** — *new in v3*. For each shared harness a
  contributor has joined, there exists a `user/<handle>` branch
  on the canonical remote and a worktree of that branch on the
  engineer's disk. The user-branch is the unit of in-progress
  code isolation.

`.harness/` is unchanged from v2:

```
.harness/
  config.json        — slug, state, discord ptr, peer-mirror,
                        prHost driver + repo, parent_slug
  shared.json        — present only when shared: topic key,
                        author pubkey, prHost remote
  hooks/post-commit  — peer-mirror push hook (when opted in)
  state/             — one file per row of every GIT-bucket
                        table (decisions/summaries/tests/...).
                        Features are NOT in here (§0.3).
```

### §2 Nested-git classifier — four cases

When the create-harness flow walks an existing repo, every nested
`.git` or sub-directory falls into exactly one case:

1. **Submodule** — `.git` is a *file* reading
   `gitdir: ../.git/modules/<name>`. → register as a **sub-harness
   node**; shares the parent's queue; path-qualified slug
   (`papercup/libs/sync`).
2. **Worktree** — `.git` is a *file* reading
   `gitdir: <parent>/.git/worktrees/<name>`. → **skip.** A worktree
   is a phase/branch checkout; already modeled by the phases
   system. (In v3 the only worktree we create is the user-branch
   worktree, which is intentional and registered separately, not
   as a sub-harness.)
3. **Standalone nested repo** — `.git` is a *directory* in a
   subfolder that is not a submodule. → prompt the user: register
   as a separate top-level harness, or skip.
4. **Plain directory (no nested `.git`)** — an ordinary subfolder,
   even one under `libs/`. → **not a harness of any kind**; it is
   just part of the parent repo. (papercup's `libs/` has 17
   entries; only the 9 in `.gitmodules` are submodules.)

Plus the two rules from v2:

5. **Tree root owns the queue.** Sub-harness nodes carry component
   identity, not their own queue.
6. **Slugs are path-qualified for sub-harnesses**
   (`<parent>/<relative-path>`).

`parent_slug` already exists in
`apps/operator/lib/endpoint-route/routes/harness/projects.ts` and
related code; build on it, don't reinvent.

### §3 Create-harness UI — four entry points, GitHub-required for shared

Four entries, with one new requirement for the shared paths:

> **GitHub OAuth is required to join (Entry 4) or share (§5) a
> harness.** It is *not* required for private-only harnesses
> (Entries 1–3 with `state: private`). The wizard surfaces the
> link-GitHub gesture at exactly the moment it becomes necessary
> — never on first open.

The GitHub integration sits behind a `PrHost` abstraction:

```ts
interface PrHost {
  driver: 'github';            // future: 'gitlab' | 'gitea' | 'forgejo'
  cloneUrl(repo: string): string;
  ensureBranch(repo: string, branch: string): Promise<void>;
  openPullRequest(repo: string, opts: PrOptions): Promise<{ url, number }>;
  pullRequestStatus(repo: string, n: number): Promise<PrStatus>;
  approvePullRequest(repo: string, n: number): Promise<void>;
  mergePullRequest(repo: string, n: number): Promise<{ commit_sha }>;
  avatarUrl(login: string): string;
}
```

v1 ships `driver: 'github'` only. `prHost` config lives in
`.harness/config.json`:

```json
{
  "prHost": {
    "driver": "github",
    "owner": "papercupai",
    "repo": "papercup"
  }
}
```

#### Entry 1 — New local directory (not yet git). [private only initially]

Pick a parent directory + name. Backend (new): create the
subdirectory, `git init`, write `.gitignore` +
`.harness/config.json`, first commit, register. The harness is
**private** at creation; flipping to shared-private later runs the
share wizard (§5), which is when GitHub linking + remote push
happens.

#### Entry 2 — GitHub URL (clone).

Paste a URL + optional name. Backend (new): `git clone` with auth
surfaced via the existing GitHub OAuth integration. The harness
defaults to **private**; share wizard required to flip it shared.
The PrHost config is pre-populated from the URL.

#### Entry 3 — Existing local git repository.

Pick a directory with `.git/`. Walk per §2, register root +
sub-harness nodes, write `.harness/config.json`. Default
**private**. If `git remote get-url origin` resolves to a GitHub
URL, pre-populate the PrHost config; otherwise leave it null
until share-time.

#### Entry 4 — Harness link (join a shared harness). [GitHub required]

Harness link format (carried from v2 with `host` added):

```
papercusp://harness/<slug>?topic=<32-byte-hex>&remote=<url>&pub=<author-pubkey-hex>&host=github
```

Wizard flow:

1. Parse + validate the link.
2. **GitHub OAuth gate.** If the user hasn't linked GitHub yet,
   force the link now. Reject join if they decline.
3. Pick a target directory on disk.
4. `git clone <remote> <target>`.
5. Read `.harness/shared.json` from the clone; confirm topic +
   author pubkey + host driver match the link.
6. Provision the harness schema.
7. **Create the user-branch:**
   `git checkout -b user/<github-handle>`,
   `git push --set-upstream origin user/<github-handle>`. The
   working tree is now on this branch.
8. Mint or load the local Ed25519 pubkey for this (workspace,
   harness).
9. Write a Contributors row to the local Hyperbee writer:
   `{ pubkey, github_login, joined_ts, display_name }`.
10. Join the Hyperswarm topic; bootstrap the local Hyperbee
    replica from live peers; project into PG.
11. Display the "joined-via-link" badge until a `pr-review`
    role-holder adds this pubkey to their trust list.

Acceptance:

- Malformed link → clean error, no partial state.
- `.harness/shared.json` mismatch → reject; no schema provision.
- GitHub OAuth refusal → reject; no clone.
- Branch creation failure (e.g. someone else already pushed a
  `user/<same-handle>` branch — which shouldn't happen because
  GitHub logins are unique, but defensively) → surface clearly.
- Replication progress is visible.

### §4 Private / shared-private / shared-public

| State | Sync | Discovery | GitHub required |
|---|---|---|---|
| **private** | none — local only | none | no |
| **shared-private** | git-as-sync + Hyperbee (§6) over Hyperswarm; user-branch workflow | link only | **yes** (share wizard forces link) |
| **shared-public** | same as shared-private | auto-listed on the Cupboard | **yes** |

Transitions same as v2: private → shared-private via wizard;
shared-private ↔ shared-public is a config flip;
shared-* → private is one-way (existing peers retain access).

State lives in `.harness/config.json` (committed).

### §5 Share-this-harness wizard

Six steps (one added vs. v2 — GitHub linking):

1. **GitHub OAuth gate.** If not linked, force the link.
2. **Confirm git remote.** Sharing requires a canonical remote.
   If absent, prompt to create on GitHub via the linked account
   and `git push --set-upstream`.
3. **Generate Hyperswarm topic key.** Fresh 32-byte random →
   `.harness/shared.json` (committed).
4. **Generate author keypair.** Fresh Ed25519 → public key into
   `.harness/shared.json`; secret into the workspace keystore
   (LOCAL).
5. **Seed the shared surfaces.** Serialize current GIT-bucket rows
   into `.harness/state/` files and commit; seed the local
   Hyperbee writer with current HYPERBEE-bucket rows (incl. a
   Contributors row for the sharer themselves).
6. **Create your own user-branch.**
   `git checkout -b user/<github-handle>`,
   `git push --set-upstream origin user/<github-handle>`.
7. **Write `.harness/shared.json` and commit.** Emit the harness
   link.

Output: a harness link to share via Discord / email / QR.

### §6 The hybrid sync model

Unchanged from v2 in principle; one rule sharpened (features are
PG/Hyperbee-only, never git).

#### §6.1 Principle

A table's sync mechanism is chosen by two questions:

1. **Does it need to be shared across engineers at all?** If no →
   LOCAL (or SECURITY if it must never leave the machine).
2. **If shared: does cross-engineer latency need to be sub-second?**
   - **No** — document-shaped, slow-changing, append-mostly →
     **GIT**: one file per row under `.harness/state/`.
   - **Yes** — high write-frequency, peer change must reflect in
     ~1s → **HYPERBEE**: CRDT log over Hyperswarm, projected
     into PG.

The naming of a table is irrelevant. Classify by use.

#### §6.2 GIT-as-sync

Every GIT-bucket table → a directory of files under
`.harness/state/<table>/`, one JSON file per row, filename = row
id. Carried from v2 §6.2: write-to-file + 15s commit debounce +
fs-watcher inbound projection + visible merge conflicts on
same-row edits.

**Explicit non-rule in v3**: features are NOT a GIT-bucket table.
There is no `.harness/state/features/` directory. See §7.2.

#### §6.3 Hyperbee — the live minority

Per-harness Hyperbee, keyed by domain id, Autobase-merged across
contributors, projected to PG with a `pg_notify` emit (the
reactivity layer, §11, lights up the UI).

#### §6.4 LWW honesty — same scope as v2

The merge is last-writer-wins per field, tie-broken by
`(operation_timestamp, author_pubkey)`. Acceptable for the
HYPERBEE tables because their fields are small scalars or
append-keyed rows. The genuine collision risk is two engineers
flipping the same feature's status within the replication window
— surfaced with a clobber toast, never silent.

The orchestrator-claim flow (§0.6) is the one place where LWW is
load-bearing: the Hypercore-sequence-order of claims is the
arbiter. Even there, the merge is deterministic per peer because
the merge function is deterministic — the same sequence of writes
produces the same view on every peer.

#### §6.5 Sync-policy registry — unchanged

A `SYNC_POLICY: Record<TableName, 'local'|'git'|'hyperbee'|'security'>`
is the single source of truth; startup asserts every table is
classified.

### §7 Table classification — deltas from v2

The full v2 §7 list still applies; v3 adds and reclassifies as
follows.

#### §7.1 HYPERBEE — grows from 5 tables to 7

v2 had 5; v3 adds `contributors` and `feature_queue`.

| Table | Why HYPERBEE | Change vs v2 |
|---|---|---|
| `harness_shared.harness_features_consolidated` | Feature queue + status. The core shared live surface. | **Schema additions**: `created_by_pubkey TEXT NOT NULL`, `working_users TEXT[] NOT NULL DEFAULT '{}'`, `current_worker TEXT NULL`. (`completion_ref` was already added in v2 Phase 2.) |
| `harness_shared.harness_issues_consolidated` | Issue queue + status. | Same schema additions as features (parallelism). |
| `harness_shared.harness_feature_notes` | Notes shown live on feature cards. | Unchanged. |
| `harness_shared.harness_feature_prs` | PR links surfacing live. | Unchanged. |
| `harness_shared.coord_presence` | Who is online / active. | Unchanged. |
| `harness_shared.contributors` | **NEW.** One row per (harness, pubkey). Joining writes one; never deleted, only marked-inactive on un-share. Drives the Contributors tab. | New table. |
| `harness_shared.feature_queue` | **NEW.** One row per (feature_id, pubkey). Pulling F-042 into your queue writes one row; un-queuing deletes. Renders as avatars under each feature card. | New table. |

Schema sketch for the two new tables:

```sql
CREATE TABLE IF NOT EXISTS harness_shared.contributors (
  harness_slug TEXT NOT NULL,
  pubkey       TEXT NOT NULL,
  github_login TEXT NULL,
  display_name TEXT NULL,
  joined_ts    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  inactive_at  TIMESTAMPTZ NULL,
  PRIMARY KEY (harness_slug, pubkey)
);

CREATE TABLE IF NOT EXISTS harness_shared.feature_queue (
  harness_slug TEXT NOT NULL,
  feature_id   TEXT NOT NULL,
  pubkey       TEXT NOT NULL,
  added_ts     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (harness_slug, feature_id, pubkey)
);
```

Both project from Hyperbee; both LISTEN-emit on
`reactive_harness_shared_<table>` for the reactivity layer.

#### §7.2 Features are NOT in GIT

This is the rule that pulls a thread through the whole design.
The reasons are repeated here because someone implementing will
think to put them in git:

- **PG is canonical.** Features are queried, joined, and indexed
  in PG (e.g. by status, by `created_by_pubkey`, by
  queue-membership). A files-on-disk source would need a
  parallel index store.
- **Hyperbee is the sync.** Hyperbee replicates rows in <1s
  cross-engineer with no debounce window; git-as-sync has a 15s
  commit debounce.
- **No file means no git history.** A feature's history lives in
  Hyperbee's append-only log + the operator UI's audit trail.
  Acceptable.
- **No file means no merge conflict on features.** Two engineers
  filing different features write different rows; two engineers
  editing the *same* feature's row is resolved by LWW + clobber
  toast (§6.4). No human-edited JSON merge.
- **A leaving engineer's features persist.** Hypercore append-only
  log means even if their writer goes offline forever, every
  peer still has their feature rows. No "ghost contributor with
  branches still holding feature definitions" problem.

#### §7.3 GIT — same list as v2

All v2 GIT-bucket tables stay GIT. No changes:

- `harness_shared.harness_decisions`
- `harness_shared.harness_summaries`
- `harness_shared.harness_design_artifacts`
- `harness_shared.harness_text_artifacts`
- `harness_shared.harness_tests`
- `harness_shared.harness_phases`
- `harness_shared.harness_promotions`
- `harness_shared.harness_lanes`
- `harness_shared.harness_checkpoints`
- `harness_shared.harness_chunk_plans`
- `harness_shared.harness_escalations`
- `harness_shared.harness_proposals_shared` (possibly legacy)
- `harness_shared.llm_test_fixtures`
- `harness_shared.llm_test_claims`
- `harness_shared.llm_test_findings`
- `harness_shared.goals`
- `harness_shared.harness_expert_feedback`
- `harness_shared.harness_expert_turns` (borderline)
- `harness_shared.identity_files`
- `harness_shared.org_*` (7 conditional tables, only if org overlay active)

#### §7.4 LOCAL — same list as v2

Unchanged. The full list from v2 §7.4 applies. ~95 tables, all
per-engineer operational state, never synced.

#### §7.5 SECURITY — same list as v2

Unchanged. The full list from v2 §7.5 applies. ~23 tables.

#### §7.6 Legacy `{{SCHEMA}}` and conditional plugin tables

Unchanged from v2 §7.6.

#### §7.7 Trust list table

The trust list lives at `harness_shared.trusted_authors`,
classified **LOCAL** (never synced):

```sql
CREATE TABLE IF NOT EXISTS harness_shared.trusted_authors (
  harness_slug   TEXT NOT NULL,
  trusted_pubkey TEXT NOT NULL,
  trusted_by_user_id UUID NOT NULL,
  trusted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note           TEXT NULL,
  PRIMARY KEY (harness_slug, trusted_pubkey, trusted_by_user_id)
);
```

One row per (harness, trusted-pubkey, reviewer). Each reviewer
maintains their own list. **No row is ever written that means
"trust anyone."** Every row is a deliberate per-pubkey grant.

#### §7.8 `pr-review` role

Stored as a single boolean flag per (workspace, harness, user):

```sql
CREATE TABLE IF NOT EXISTS harness_shared.pr_reviewer_settings (
  harness_slug TEXT NOT NULL,
  user_id      UUID NOT NULL,
  has_role     BOOLEAN NOT NULL DEFAULT FALSE,
  auto_review  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_ts   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (harness_slug, user_id)
);
```

Classified **LOCAL**. Held by each engineer in their own PG —
the role is a personal opt-in ("am I reviewing PRs for this
harness right now?"). Multiple engineers can independently hold
the role; they each maintain their own trust list.

### §8 PR lifecycle

The end-to-end flow for "agent ships a feature on my branch →
code lands on main." Where this differs from a normal GitHub PR
flow is the trust-list-gated auto-approve.

#### §8.1 Open

When the orchestrator (or the user manually) decides a feature is
ready:

1. Agent commits all relevant changes to the worktree (still on
   `user/<handle>` branch).
2. Pre-push rebase against `origin/main` (§0.5). If conflict →
   hold push, surface to user, abort the PR-open flow.
3. `git push user/<handle>` — Hyperdrive peer-mirror replicates
   alongside (when opted in, §12).
4. `PrHost.openPullRequest()` opens a PR from
   `user/<handle>` → `main` with a templated body that includes
   `closes F-042` so GitHub will auto-close on merge.
5. Operator writes a `harness_feature_prs` row (HYPERBEE-synced)
   carrying `{ feature_id, pr_url, pr_number, author_pubkey,
   opened_ts }`.
6. Feature status flips to `pending_done`.

#### §8.2 Review — auto-approve path

For each PR-reviewer in this workspace's `pr_reviewer_settings`
with `has_role = true AND auto_review = true`:

1. Look up the PR author's pubkey (via the GitHub-login →
   contributor pubkey map in `contributors`).
2. Check `trusted_authors` for a `(harness_slug, trusted_pubkey,
   trusted_by_user_id = me)` row.
3. **If trusted**: call `PrHost.approvePullRequest()` to record an
   approval. If GitHub branch-protection requires N approvals,
   accumulate auto-approvals across reviewers until the threshold
   is met. **Never merge automatically** — merge is always a
   human gesture (or a separate explicit auto-merge toggle, off
   by default).
4. **If not trusted**: do nothing. The PR sits in the
   manual-review queue.

Crucially: auto-approve checks `trusted_pubkey`, not GitHub
login. A pubkey change (key rotation, new device) requires a
fresh trust gesture.

#### §8.3 Review — manual path

A PR not auto-approved appears in the PR tab (§9.4). Clicking
opens a deep-link to GitHub's PR review UI — we do NOT build a
review UI of our own (non-goal). The reviewer reviews on GitHub,
clicks Approve there, and the PR is unblocked from the GitHub
side.

The Papercusp UI shows GitHub's review state alongside the
Papercusp feature state — same surface, two pieces of data.

#### §8.4 Merge

Merging happens on GitHub. The operator polls (or webhook-listens
if configured) `PrHost.pullRequestStatus` and detects the merge.
On merge:

1. The merged commit's SHA is captured from
   `PrHost.mergePullRequest`'s return.
2. The feature row stamps:
   - `completion_ref = { remote, branch: 'main', commit_sha, pr_url }`
   - `status = 'shipped'` (skipping `done` for the collaborative
     flow — `done` is reserved for code-less completions).
   - `shipped_at_ts = NOW()`.
3. The `working_users` array is cleared.
4. The corresponding `feature_queue` rows for all users are
   deleted (the feature is shipped; no one's queue contains
   shipped features).
5. The `done_at_remote_ts` verification job (§13) confirms the
   commit at the canonical remote on next poll, marking the
   feature confirmed-shipped.

#### §8.5 Manual ship without PR (rare)

A feature can be marked `shipped` directly without a PR (e.g. a
documentation feature that was completed by editing files
already on main). The UI requires a `completion_ref.commit_sha`
to be supplied manually; the verification poll still runs.

### §9 Harness sidebar tabs

Three new tabs join the standard surface.

#### §9.1 Features tab

A unified, deduplicated list of every feature on the harness,
regardless of which user filed it. One card per feature, showing:

- `id`, `title`, `status` pill
- The creator's avatar (top-left)
- Queue-members' avatars (a horizontal stack, max 5 + "+N more")
- The current worker's avatar (highlighted, with a "working"
  indicator) when `working_users` is non-empty
- A "+ Add to my queue" button when the feature isn't in your
  queue; an "- Remove from queue" when it is
- A "Start working" button when it's in your queue and
  `working_users` is empty
- Status-derived secondary actions ("View PR" when
  `pending_done`; "View shipped commit" when `shipped`)

Filter chips: `status`, `creator`, `in my queue only`,
`working now`. URL-backed via nuqs.

The Features tab is the primary collaboration surface.

#### §9.2 Contributors tab

Lists every row in `contributors` for this harness. One card per
contributor, showing:

- GitHub avatar (or identicon fallback)
- `display_name` or `github_login`
- "Joined N days ago"
- Activity rollup: features filed, features in queue, features
  shipped (computed)
- Trust state from the viewer's perspective: untrusted (default),
  trusted-by-me, trusted-by-some-reviewer (when a different
  reviewer trusts them — informational)
- "Add to my trust list" / "Remove from my trust list" button —
  only enabled when the viewer holds the `pr-review` role for
  this harness

Sort: most recent first, with role-holders pinned to the top.

#### §9.3 Trust dropdown — UI for trusted_authors

The "Add to my trust list" button on a Contributor card opens a
small dropdown:

- Free-text note input ("why are you trusting this contributor")
- "Add to trust list" confirm button

There is **no "Trust anyone" toggle in this dropdown or anywhere
else in the UI** (D-014, security-critical). Bulk-trust does not
exist; every trust is per-pubkey.

Removing a contributor from the trust list is a one-click action
on the same dropdown.

#### §9.4 PR tab

Visible only to users with `has_role = true` (set in their
personal `pr_reviewer_settings`). Lists open PRs against `main`
across all `user/*` branches in this harness:

- One row per open PR
- PR title, author avatar + name, opened-when, GitHub status
  (checks passing/failing, approvals)
- Papercusp status: `auto-approved by you` /
  `awaiting your manual review` / `merged elsewhere`
- "Open on GitHub" deep-link (primary action)
- An `auto-review on/off` toggle at the top, mirroring
  `pr_reviewer_settings.auto_review`

When auto-review is on and a new PR matches the trust list,
the row shows `auto-approved by you ✓` once the
`PrHost.approvePullRequest` returns.

### §10 Cupboard — public harness directory

Unchanged from v2 §8 in mechanics; the listing now also surfaces
the contributors count (deduped across pubkeys), which makes the
Cupboard UI feel social rather than just a catalog.

- New top-level navbar item
- Backed by a `papercusp-cupboard` registry (model on
  `papercusp-registry`)
- On `shared-public` flip → POST metadata to the registry
- Cards show: name, description, language tags, contributor
  count, "last activity" timestamp
- "Install" → harness-link prefill → Entry 4 of §3 (the new
  GitHub-required join flow)

The registry holds discovery metadata only; live state and
contributors-list still flow via Hyperswarm.

### §11 Discord integration — unchanged

Carried from v2 §9 verbatim:

- `.harness/config.json` carries optional `discord` field with
  `guildId`, `channelId`, optional `webhookUrl`
- User-gesture button fires `discord://discord.com/channels/...`
  URI (Discord desktop intercepts); HTTPS fallback for browser
  Discord
- Optional outbound webhook posts activity events (PR opened,
  escalation raised, feature shipped) to the channel
- No bot, no auto-create channel, no inbound integration

### §12 P2P transport — unchanged from v2 §10

```
+--------------------------------------------+
|  PG projection / UI reactivity      (§13)  |
+--------------------------------------------+
|  Hyperbee CRDT  — 7 live tables    (§6.3)  |
|  git-as-sync    — ~20 tables        (§6.2) |
|  Hyperdrive     — peer-mirror      (§14)   |
+--------------------------------------------+
|  Hyperswarm (HyperDHT + holepunching)      |
+--------------------------------------------+
|  WireGuard mesh (Defguard) — already up    |
+--------------------------------------------+
```

One Hyperswarm node per workspace, multiplexing every shared
harness's topic. Holepunch npm modules only (`@holepunchto/*`);
NOT the Pear runtime (see D-015 footnote).

### §13 Reactivity — unchanged from v2 §11

`emit_change_notify()` PL/pgSQL trigger function on reactive
tables → `/api/sync/stream` SSE multiplexed by SSEAdapter →
`useSyncQuery` invalidates on the client. Plans-admin migrates
off polling; Zero dep dropped.

The new HYPERBEE tables (`contributors`, `feature_queue`,
`harness_features_consolidated`'s new columns,
`harness_feature_prs`) all participate — UI reactivity is the
default for everything they drive (Features tab, Contributors
tab, PR tab, working-now indicator).

### §14 Git / Hyperswarm / Hyperdrive — Path B (opt-in peer-mirror)

Carried from v2 §12. Peer-mirror is **opt-in per-harness**
(default off). Mechanism:

1. Per-shared-harness bare mirror at
   `~/.papercusp-workspaces/<ws-id>/peer-mirrors/<harness-slug>.git`,
   never `gc`'d.
2. Post-commit hook (`.harness/hooks/post-commit` symlinked to
   `.git/hooks/`) pushes to the bare mirror.
3. **Branch-pattern gate** still applies. Default:
   `^(user/|feature/|fix/|chore/|docs/|refactor/|test/)`
   — note v3 adds `user/` so personal branches mirror by default
   when the harness is opted in. `main` is NOT in the default
   pattern (no need; main pulls from GitHub anyway and changes
   slowly).
4. Hyperdrive wraps the bare mirror, replicating over the
   harness's Hyperswarm topic. Drive key announced via Hyperbee
   (one row per author pubkey).
5. Peer auto-fetch on `completion_ref` change, falling back to
   `git fetch origin` on Hyperdrive timeout >5s.

The user-branch fast path is the most felt benefit: when Bob
pushes to `user/bob`, Alice's operator can pull Bob's code in
~1s via Hyperdrive instead of round-tripping GitHub.

### §15 `completion_ref` + verification — unchanged from v2 §13

Background poll, never on-read. `git ls-remote` confirms the
`completion_ref.commit_sha` is at the canonical remote;
`done_at_remote_ts` caches the result; reads serve from cache;
manual "check now" button exists for impatience.

### §16 Sync-with-main UI gesture — the three surfaces

Drawn together for clarity (referenced from §0.5):

1. **Status indicator** (always visible in the harness sidebar):
   `feature/F-042 · behind main by 3, ahead by 5`. Updates on the
   30s background `git fetch`.
2. **"Sync with main" button** (in the same sidebar component):
   one click → `git fetch origin main && git rebase origin/main`.
   On conflict, the rebase aborts cleanly and surfaces an inline
   conflict-resolution UI; the user resolves and clicks "Continue
   rebase" or "Abort".
3. **Auto-rebase on push** (a setting, default ON for v3): before
   every `git push user/<handle>`, run a rebase against
   `origin/main` first. If clean, push. If conflict, hold the
   push, surface the conflict, NEVER force-push silently.

No background rebase. Rebase is always a foreground event with
explicit conflict surfacing.

### §17 Pear is not adopted in v1

Holepunch primitives (`@holepunchto/hyperswarm`,
`@holepunchto/hyperbee`, `@holepunchto/hyperdrive`,
`@holepunchto/autobase`) are used as npm modules inside the
existing Tauri/Node desktop runtime. The full **Pear** runtime
(Bare + `pear://` distribution + app shell) is parallel to
Tauri, not to Hyperbee — adopting it would require replacing
the entire desktop runtime, which v1 does not do.

Pear becomes interesting later for two specific scenarios — P2P
distribution of Papercusp itself (Keet model), and a serious
mobile build. Both are deliberate future projects.

## Scope

**In scope:** v2's full scope (create-harness UI + classifier +
sub-harness registration + share-this-harness wizard + state
machine + `SYNC_POLICY` registry + git-as-sync + Hyperswarm +
Hyperbee + Autobase + reactivity + Hyperdrive peer-mirror +
Cupboard + Discord + trust + `completion_ref`), **plus** the v3
collaboration layer: forced GitHub OAuth via `PrHost` abstraction,
user-branches + worktrees, contributors table + tab, feature-queue
pointer table, working_users + current_worker on features,
orchestrator-claim flow over Hypercore sequence, PR lifecycle
(open + auto-approve via trust list + manual review deep-link +
merge → shipped), `pr-review` role + per-user trust-list dropdown,
PR tab, sync-with-main UI gesture trio.

**Out of scope:** mobile UI; replacing GitHub or PR review;
real-time code co-edit; built-in PR review form (deep-link to
GitHub instead); inbound Discord; cross-engineer agent
messaging; cross-workspace sync; topic-key rotation on un-share;
"trust anyone" toggle (D-014); non-GitHub PrHost drivers in v1
(architecture supports them, implementation is GitHub only);
Pear runtime adoption (D-015); cross-repo unified queue (D-016).

Phase sizing: **S** ≈ 1–3 days · **M** ≈ 1 week · **L** ≈ 2–3
weeks. ~5 execution plans' worth of work; split after review.

## Phase 0 — Foundations + spike  (M)

Prove the substrate before committing. **Named fallback** (from
v2): if Phase 0 fails on packaging or Autobase stability, the
HYPERBEE bucket collapses into GIT — the 7 live tables become
file-per-row, accepting ~3–5s latency. v3-specific addition:
without Hyperbee the orchestrator-claim flow falls back to a
GitHub-side lock branch (`claims/F-042` ref-write race),
slower but workable.

- **P-001** `todo` Spike: Hyperswarm node in Node process; two
  workspace instances discover each other on a known topic in <2s.
- **P-002** `todo` Spike: write/read a Hyperbee; verify Autobase
  merges two writers into a consistent view.
- **P-003** `todo` Spike: replicate a small bare git repo via
  Hyperdrive between two workspaces; `git fetch file://<mirror>`
  resolves a peer's commit.
- **P-004** `todo` Confirm `@holepunchto/*` (hyperswarm, hyperbee,
  hyperdrive, autobase, with native deps UDX + sodium-native)
  bundle cleanly into operator Node + Tauri desktop bundle.
- **P-005** `todo` Spike: a two-writer Hyperbee race on a single
  key, verifying the merge view is deterministic on both peers
  (the orchestrator-claim flow's foundation).
- **P-006** `todo` Write findings doc; if P-004 fails, invoke the
  fallback and rebaseline phases 6–8.

## Phase 1 — Create-harness UI + GitHub PrHost  (L)

Four entry points + the GitHub `PrHost` driver, plus the
user-branch creation on Entry 4.

- **P-007** `todo` New `app/admin/harnesses/new` wizard route +
  4-card chooser; "Create Harness" affordance on the main list.
- **P-008** `todo` `PrHost` abstraction interface +
  GitHub driver implementation (cloneUrl / ensureBranch /
  openPullRequest / pullRequestStatus / approve / merge / avatar).
  blocked-by: P-007
- **P-009** `todo` GitHub OAuth gate UI + force-link flow at
  share/join time. Build on existing OAuth integration.
- **P-010** `todo` Entry 3 (existing repo): submodule walker
  (per §2's 4 cases + cycle detection); register root +
  sub-harnesses; write `.harness/config.json` incl. `prHost` block
  when origin is GitHub.
- **P-011** `todo` Entry 1 (new local dir): create dir, `git init`,
  scaffold, first commit, register. Default `state: private`.
  blocked-by: P-010
- **P-012** `todo` Entry 2 (GitHub URL): `git clone` with OAuth,
  then Entry 3 path. blocked-by: P-008, P-010
- **P-013** `todo` Entry 4 (harness link): the GitHub-gated,
  user-branch-creating join flow. Parse link → OAuth gate → clone
  → confirm `.harness/shared.json` → provision schema →
  `checkout -b user/<handle>` + `push --set-upstream` → mint
  pubkey → write Contributors Hyperbee row → join swarm →
  bootstrap. blocked-by: P-008, P-009
- **P-014** `todo` Verify: bring papercup in via Entry 3; tree
  shows papercup + 9 `libs/*` sub-harness nodes; other 8 `libs/*`
  dirs produce none. blocked-by: P-010

## Phase 2 — `completion_ref` + trust scaffold + sync-with-main  (M)

Data model + the sync UI trio (which is unblocking for
single-engineer dogfood in Phase 4).

- **P-015** `todo` Migration: `completion_ref jsonb` +
  `working_users text[]` + `current_worker text` +
  `created_by_pubkey text` on `harness_features_consolidated`.
  Same on `harness_issues_consolidated`.
- **P-016** `todo` Feature write verbs accept and validate the
  new columns.
- **P-017** `todo` Background verification job — poll
  `git ls-remote` for `pending_done` features; cache
  `done_at_remote_ts`. Manual "check now" button.
- **P-018** `todo` `pending_done` → `shipped` gate driven by
  cached verification. blocked-by: P-017
- **P-019** `todo` `trusted_authors` LOCAL table (§7.7) +
  `trust:list` / `trust:add` / `trust:remove` verbs +
  `SYNC_POLICY` entry.
- **P-020** `todo` `pr_reviewer_settings` LOCAL table (§7.8) +
  `pr-review:set-role` / `pr-review:set-auto` verbs.
- **P-021** `todo` Sync-with-main UI trio (§16): status indicator
  + button + auto-rebase-on-push (default ON), with foreground
  conflict surfacing.

## Phase 3 — Reactivity producer side  (M)

Independently shippable; unblocks all live UI surfaces.
Unchanged from v2 Phase 3, with the new HYPERBEE tables added.

- **P-022** `todo` `emit_change_notify()` PL/pgSQL trigger
  function + per-table attach helper.
- **P-023** `todo` Attach to reactive tables (the 7 HYPERBEE +
  GIT projections + UI-facing LOCAL tables, including the new
  `contributors`, `feature_queue`, `pr_reviewer_settings`).
- **P-024** `todo` `/api/sync/stream` SSE endpoint —
  per-workspace LISTEN on `reactive_*`, per-client subscription,
  SSEAdapter multiplex. blocked-by: P-023
- **P-025** `todo` Migrate plans-admin off `useAsyncJson` +
  polling onto `useSyncQuery`. blocked-by: P-024
- **P-026** `todo` Drop `@rocicorp/zero` dep + Zero WS adapter.
- **P-027** `todo` Verify: two tabs on one harness; a write in
  one lands in the other in <1s.

## Phase 4 — Dogfood papercup, single-engineer  (S)

The payoff, pulled forward from v2 — single-engineer doesn't
need P2P yet. v3 adds: even single-engineer uses the user-branch
+ PR workflow, mirroring how you'd do solo open-source work.

- **P-028** `todo` Create `papercusp-workspace` workspace.
- **P-029** `todo` Bring papercup in via Entry 3. blocked-by:
  P-014, P-028
- **P-030** `todo` Manually share-private to seed your own
  user-branch + Contributors row (so your worktree-on-user-branch
  workflow is live; the harness is shareable but you haven't
  shared the link yet). blocked-by: P-029, P-013
- **P-031** `todo` Seed a starter feature queue from current
  PLAN.md / agent-coordination plans. blocked-by: P-030
- **P-032** `todo` Single-engineer exercise: file a feature on
  the queue, manually start working, agents generate code on
  your `user/<handle>` branch, open a PR, manually approve +
  merge on GitHub, feature flips to `shipped` after verification.
  blocked-by: P-031, P-018, P-021

## Phase 5 — git-as-sync (the GIT bucket)  (M)

Unchanged from v2 Phase 5.

- **P-033** `todo` `SYNC_POLICY` registry + startup assertion.
- **P-034** `todo` `.harness/state/` file-per-row writer for
  GIT-bucket write verbs. blocked-by: P-033
- **P-035** `todo` Debounced auto-commit of `.harness/state/`
  (15s window). blocked-by: P-034
- **P-036** `todo` Extend `harness-fs-watcher` to project
  `.harness/state/` files into PG on inbound `git fetch`.
- **P-037** `todo` Share-this-harness wizard (§5) — six steps
  including GitHub OAuth gate, topic key, keypair, seed GIT and
  HYPERBEE, create user-branch, write `shared.json`.
  blocked-by: P-013, P-035
- **P-038** `todo` Private ↔ shared-private ↔ shared-public state
  machine. blocked-by: P-037
- **P-039** `todo` Verify: two clones of one harness; a decision
  written in one appears in the other after `git pull`.
  blocked-by: P-036

## Phase 6 — Hyperswarm + Hyperbee (7 live tables) + orchestrator-claim  (L)

The riskiest phase. De-risked by Phase 0.

- **P-040** `todo` `harness-sync` subprocess — one Hyperswarm
  node per workspace. blocked-by: P-006
- **P-041** `todo` Per-harness Hyperbee schemas for the 7
  HYPERBEE tables (incl. `contributors`, `feature_queue`);
  Autobase multi-writer wrapper. blocked-by: P-040
- **P-042** `todo` Hyperbee → PG projection + `pg_notify` emit
  for each HYPERBEE table. blocked-by: P-041
- **P-043** `todo` HYPERBEE write path: write own Hyperbee →
  project to local PG → replicate over Hyperswarm.
  blocked-by: P-042
- **P-044** `todo` Schema-version handling for HYPERBEE
  table-shape changes.
- **P-045** `todo` LWW clobber surfacing — "status changed by
  <peer>" toast for feature status.
- **P-046** `todo` **Orchestrator-claim flow** (§0.6): claim
  write to Hypercore on feature pickup; Autobase merge resolves
  contention; orchestrator handles "I lost the claim" with a
  re-pick. blocked-by: P-043
- **P-047** `todo` Wire Entry 4 (P-013) to join the swarm
  post-clone.
- **P-048** `todo` Verify: two workspaces on the mesh; a status
  flip on one lands on the other in <1s; two orchestrators
  racing on the same feature → only one claims.
  blocked-by: P-046

## Phase 7 — Hyperdrive peer-mirror (Path B)  (M)

Unchanged from v2 Phase 7.

- **P-049** `todo` Per-shared-harness bare-mirror init; opt-in
  `peerMirror.enabled` (default off).
- **P-050** `todo` Post-commit hook install (symlinked); branch
  pattern gate (defaults include `user/`).
- **P-051** `todo` Hyperdrive wrap of bare mirror; replicate over
  harness topic; publish drive key via Hyperbee.
- **P-052** `todo` Peer auto-fetch on `completion_ref` change;
  GitHub fallback on >5s timeout. blocked-by: P-051
- **P-053** `todo` UI: "peer shipped F-NNN — view diff / check
  out / open in editor".
- **P-054** `todo` Verify: two mesh-connected engineers; one
  pushes to `user/<handle>`; the other reaches the commit via
  `git log` in <3s without either pushing to GitHub origin (the
  peer-mirror replication carried it).

## Phase 8 — PR lifecycle + sidebar tabs + trust-list UI  (L)

The collaboration surface itself. Possibly the biggest UI lift.

- **P-055** `todo` Features tab (§9.1) — unified feature list,
  filter chips (nuqs), avatars, queue/working actions.
  blocked-by: P-027 (reactivity)
- **P-056** `todo` Contributors tab (§9.2) — contributor cards,
  trust UI affordances. blocked-by: P-055
- **P-057** `todo` Trust dropdown (§9.3) — add/remove trust
  rows; deliberately NO "trust anyone" toggle. blocked-by: P-056
- **P-058** `todo` PR tab (§9.4) — open-PR list; auto-review
  toggle; deep-link to GitHub. blocked-by: P-020
- **P-059** `todo` PR-open flow (§8.1): orchestrator + manual
  trigger; auto-rebase + push + `PrHost.openPullRequest`;
  write `harness_feature_prs` row; feature → `pending_done`.
  blocked-by: P-021, P-046
- **P-060** `todo` Auto-approve flow (§8.2): for each role-holder
  with auto-review on, check trust list, call
  `PrHost.approvePullRequest`. blocked-by: P-059
- **P-061** `todo` Merge detection (§8.4): poll/webhook detect;
  stamp `completion_ref`; flip to `shipped`; clear
  `working_users` + queue rows. blocked-by: P-018, P-059
- **P-062** `todo` Verify: file a feature; a teammate pulls into
  queue, starts working; orchestrator generates code, opens PR;
  another teammate (role-holder, has teammate in trust list)
  auto-approves; merge → flip to shipped. blocked-by: P-061

## Phase 9 — Cupboard  (M)

Unchanged from v2 Phase 8.

- **P-063** `todo` `papercusp-cupboard` registry — repo +
  systemd unit + publish/index endpoints.
- **P-064** `todo` Operator publish flow on `shared-public` flip;
  delist on flip back. blocked-by: P-038
- **P-065** `todo` Cupboard navbar item + card grid (reuse
  marketplace components); contributor count surfaced.
- **P-066** `todo` "Install" → harness-link prefill → Entry 4.
  blocked-by: P-013, P-065
- **P-067** `todo` Verify: flip a harness public; appears on
  Cupboard; install on a second workspace.

## Phase 10 — Discord  (S)

Unchanged from v2 Phase 9.

- **P-068** `todo` `.harness/config.json` `discord` field +
  per-harness Discord settings panel.
- **P-069** `todo` "Open Discord channel" gesture → `discord://`
  + HTTPS fallback.
- **P-070** `todo` Outbound webhook poster (extend existing
  notification surface) — PR opened / escalation /
  done-after-review.
- **P-071** `todo` Verify: configure a test channel; trigger
  each event class; observe in Discord.

## Phase 11 — Multi-engineer dogfood + verification  (M)

The full demo.

- **P-072** `todo` Share the papercup harness (P-037); a second
  engineer joins via harness link + mesh enrollment + GitHub OAuth.
  blocked-by: P-048, P-039, P-013
- **P-073** `todo` Onboarding doc for joining engineers.
- **P-074** `todo` Unit coverage for the §2 classifier (4 cases
  + cycle detection).
- **P-075** `todo` Unit coverage for the orchestrator-claim flow
  (Hypercore-sequence first-wins semantics).
- **P-076** `todo` Integration coverage: GIT-as-sync round-trip +
  Hyperbee → PG projection + PR open/merge full cycle.
- **P-077** `todo` Integration coverage: Hyperdrive peer-mirror
  (commit on one peer, `git log` on another).
- **P-078** `todo` Playwright e2e for create-harness wizard (all
  4 entries, temp dirs) + Features/Contributors/PR tab smoke.
- **P-079** `todo` Performance: local-write → peer-PG (<1s),
  orchestrator-claim resolution (<1s), peer-mirror fetch
  (<3s on mesh).
- **P-080** `todo` Multi-engineer exercise: both engineers file +
  pull features; one's orchestrator picks a feature, ships PR;
  trust-list-gated auto-approve from the other; merge; flip to
  shipped on both screens. blocked-by: P-072, P-062

## Decisions

### D-001 — Collaboration is the core, not a sync feature
Every Papercusp install of a shared harness creates a Contributor
identity with a long-lived branch + worktree on day one. There is
no "single-user mode" path through the UI for shared harnesses.

### D-002 — Features stay in PG (HYPERBEE-synced); no feature files in git
Corrects v2's drift toward putting feature definitions on user
branches. Features are PG-canonical rows, Hyperbee-synced, with
`created_by_pubkey` as the owner pointer. The branch carries code
only. See §7.2 for the full rationale.

### D-003 — User-branch per contributor; one worktree per harness
Each contributor gets `user/<github-handle>` on the canonical
remote + a worktree of that branch on disk. **Not two** worktrees
— main is accessed via the sync-with-main UI gesture, not a
second physical checkout.

### D-004 — Queue is a pointer table, not a per-user copy
`feature_queue` is a (feature_id, pubkey) Hyperbee table.
Pulling F-042 into your queue is a one-row write; un-queuing is
a delete. No feature definition is ever duplicated. The Features
tab dedupes by `feature_id` and renders queue members as avatars.

### D-005 — Working list is plural in the data model, size-1 in v1 policy
`working_users[]` is an array; `current_worker` is a singleton.
The orchestrator only picks features with empty `working_users`,
keeping the array size 0 or 1 in practice. The plural shape
future-proofs simultaneous-work scenarios.

### D-006 — Orchestrator-claim arbitrated by Hypercore sequence
The "no one else is working on it" gate is enforced by the
orchestrator writing a claim entry to its own Hypercore;
Autobase's deterministic merge by `(writer_pubkey, seq)`
arbitrates contention. No central lock, no consensus protocol.

### D-007 — Anyone who joins = a Contributor
No two-tier "members vs contributors" distinction. The act of
joining via a harness link is treated as a contribution-of-intent;
the Contributors tab welcomes them immediately.

### D-008 — Identity = pubkey primary; GitHub login derived; identicon fallback
Pubkey (Ed25519, per-(workspace, harness)) is the root id. GitHub
login is derived (force-linked on join). Avatar comes from GitHub
when available, deterministic identicon from the pubkey otherwise.

### D-009 — GitHub OAuth required for shared harnesses
Joining or sharing requires linking GitHub. Behind a `PrHost`
abstraction (driver: github | future: gitlab/gitea/forgejo); v1
implements GitHub only. Private-only harnesses do not require
GitHub.

### D-010 — Sync-with-main = status + button + auto-rebase-on-push
Three UI surfaces, no background rebase. Conflicts are always
foregrounded. Auto-rebase default ON.

### D-011 — PR lifecycle: open → trust-gated review → merge → shipped
Agent commits + auto-rebase + push + open PR via `PrHost`.
Auto-approve only if PR author pubkey is on a role-holder's trust
list. Merge happens on GitHub (deep-link). Merge detection
stamps `completion_ref` and flips status to `shipped`.

### D-012 — `pr-review` role + per-user trust list
A boolean toggle per (workspace, harness, user). Multiple
engineers can independently hold it. Each maintains their own
`trusted_authors` LOCAL table. Trust gestures are deliberate,
per-pubkey.

### D-013 — Deep-link to GitHub for PR review; no built-in review UI
We do not build a code-review surface. Papercusp surfaces PR
metadata + auto-approval state; the actual review happens on
GitHub via deep-link.

### D-014 — No "trust anyone" toggle, anywhere
Trust must be deliberate per-pubkey. The dropdown UI for adding
to the trust list never offers a "trust everyone" or
"auto-trust-new-contributors" affordance. **Security-critical**;
violation of this rule is a P0 fix.

### D-015 — Holepunch primitives only, not Pear
Use `@holepunchto/{hyperswarm,hyperbee,hyperdrive,autobase}` as
npm modules inside the existing Tauri/Node runtime. The full
**Pear** runtime (Bare + `pear://` + app shell) is NOT adopted in
v1 — it would require replacing Tauri. Revisit for P2P
distribution of Papercusp itself (Keet model) or a serious
mobile build.

### D-016 — Cross-repo unified queue is cosmetic UI, deferred
Carried from v2 D-022. The four papercup repos stay separate
top-level harnesses; an all-four-queues view is a UI grouping,
out of scope for v1.

### D-017 — All v2 decisions carry forward unless restated
v2's D-001 (PG is a cache), D-002 (4 repos separate), D-003
(harness = unit of sharing), D-004 (sub-harness = submodule),
D-005 (hybrid sync), D-006 (classify by use), D-007 (sync policy
= registry), D-008 (LWW honest), D-009 (peer-mirror opt-in),
D-010 (`completion_ref` background poll), D-012 (Discord
deep-link), D-013 (Cupboard via registry), D-014 (reactivity via
triggers), D-015 (real PG only), D-016 (dogfood pulled forward),
D-018 (Phase 0 fallback), D-019 (Holepunch over Spock), D-020
(IPFS/Radicle/Fossil/git-bug ruled out), D-021 (harness link
format) — all stand.

### D-018 — Harness link format adds `host` parameter
`papercusp://harness/<slug>?topic=<hex>&remote=<url>&pub=<hex>&host=github`.
The host parameter tells the joiner which `PrHost` driver to
use. v1 will always be `host=github` (forced).

### D-019 — `done` vs `shipped` distinction
`shipped` is the terminal state for the collaborative flow
(PR-merged feature). `done` is reserved for features completed
without a PR (e.g. doc-only changes already on main). Most
features will skip `done` and go pending_done → shipped.

### D-020 — `feature_queue` rows clear on merge
When a feature flips to `shipped`, every user's `feature_queue`
row for that feature is deleted. A shipped feature should not
appear in anyone's active queue.

### D-021 — `user/` branches mirror by default when peer-mirror is on
The branch-pattern gate (v2 D-009) gains `user/` in its default.
When a harness has `peerMirror.enabled = true`, your
`user/<handle>` branch replicates to peers' Hyperdrive replicas
on every push (subject to the post-commit hook).

### D-022 — Trust state surfacing in Contributors tab is informational only
A viewer can see "trusted-by-some-reviewer" as info about other
reviewers' trust, but never bulk-act on it. Trust remains
per-(viewer, contributor) and is never derived from another
reviewer's decisions.

## Open questions

### Q-1 — Branch reuse on GitHub-login change
If a contributor's GitHub login changes (rare), their
`user/<old-handle>` branch is orphaned and a new
`user/<new-handle>` would be created. Should the operator detect
this and offer a rename / push-to-new-branch flow?

### Q-2 — Multi-machine same user
A contributor on two machines has two pubkeys for one harness,
but presumably one GitHub login. Two `user/<handle>` branches
would conflict on push. Options: (a) suffix the second
(`user/<handle>-2`), (b) detect and re-use the same branch from
both machines (risk: concurrent pushes from the same login), (c)
mint a single per-engineer identity copied across machines.
**v3 punts**; this needs an answer before multi-machine support
is real.

### Q-3 — When does a Contributors row become "inactive"?
The schema has `inactive_at`. What triggers it? Options: explicit
"leave harness" gesture; N days without a Hyperbee write;
revocation by a role-holder. Probably explicit + idle-timeout;
needs scoping.

### Q-4 — PR auto-approve UI affordance for "I changed my mind"
A role-holder auto-approves a PR; later they realize they
shouldn't have. GitHub's "dismiss review" UI is the canonical
fix. Surface a deep-link from Papercusp? Add a "remove from
trust list" undo flow on the same screen?

### Q-5 — Stale `user/<handle>` branch cleanup
Branches accumulate. After a contributor goes inactive, their
`user/<handle>` branch on GitHub stays forever. Auto-archive
after N days idle (with notification)? Manual gesture only?

### Q-6 — Feature draft state before "filed"
The `todo` status assumes a feature is fully filed and ready for
the queue. Is there a `draft` precursor (filed but not yet
visible to other users) for an author still refining the
description? If yes, where does it sync — LOCAL until
"publish," then HYPERBEE? Adds a state to the machine.

### Q-7 — Issue lifecycle parallel to feature lifecycle?
Issues have `working_users` + `current_worker` columns added
(P-015 mirrors features). Do they get the same orchestrator-claim
flow, same PR lifecycle, same queue mechanism? Likely yes; needs
explicit scoping.

### Q-8 — Onboarding: does Entry 4 enable peer-mirror automatically?
Peer-mirror is opt-in per-harness (default off). On joining via a
harness link, should the join wizard offer to opt-in immediately
(with a clear explanation of what it means)? Or leave it
explicitly off until the contributor visits harness settings?
v3 leans toward "offer on join with default OFF" — surfaced but
not preselected.

### Q-9 — All v2 open questions carry forward unless restated
v2's Q-1 (`harness_brainstorm` / `harness_pending_issues` LOCAL?),
Q-2 (`harness_proposals_shared` legacy?), Q-3 (topic-key
rotation needed?), Q-4 (`harness_escalations` GIT or HYPERBEE?),
Q-5 (`org_*` overlay active?), Q-6 (`goals` project-level only?),
Q-7 (`plugin_kv` per-plugin opt-in?), Q-8 (Cupboard moderation?),
Q-9 (per-engineer or per-machine identity? — sharpened to v3 Q-2
above), Q-10 (Discord webhook payload shape?), Q-11 (bare-mirror
location?), Q-12 (`{{SCHEMA}}` template still live?) — all open.
