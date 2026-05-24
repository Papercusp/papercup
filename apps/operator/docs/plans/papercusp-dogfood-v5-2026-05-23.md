---
title: Papercusp dogfood — make Papercusp collaborative-at-the-core (v5)
slug: papercusp-dogfood-v5-2026-05-23
date: 2026-05-23
status: draft
owners: [aviynw3]
supersedes: papercusp-dogfood-v4-2026-05-23
---

## Now

**Single next action**: get user sign-off on v5, then split into per-phase execution plans (one per Phase 0 through Phase 11) and start Phase 0 spike.

## What changed from v4

v5 is a maintenance pass folding in the v4 audit findings plus user resolutions on the 9 open questions. No architectural changes. All 22 v4 decisions stand; v5 adds fixes, clarifications, and answers to the open questions.

**Audit-driven changes (10):**

1. **§7 two-ensure-path callout (audit A)** — Papercusp has TWO schema-ensure paths: `*.sql` migrations in `libs/papercusp/libs/db/sql/` (~114 tables) AND runtime `apps/operator/lib/ensure-schema.ts` (~57 tables in `harness_shared`). Several v4-classified HYPERBEE tables (`coord_presence`, `harness_decisions`, `harness_lanes`, `harness_checkpoints`, `harness_branch_actions`, `harness_skills`, `harness_feature_prs`, `snapshot_features`) are runtime-ensured, not SQL-migrated. The Hyperbee projection process (P-031) must wait for both ensure-paths to complete at boot.
2. **Octokit + isomorphic-git explicit new-deps (audit D)** — repo currently has NO `@octokit/*` packages. v4 referenced them implicitly. v5 calls out: `@octokit/rest` + `@octokit/auth-oauth-device` are net-new deps alongside `isomorphic-git`. Sized in P-008/P-009/P-040.
3. **Cupboard server architecture sub-design (audit F)** — v4 said "Cupboard server" without specifying schema, auth, hosting, or anti-abuse. v5 §10 adds a sub-design with concrete shape; P-051 split into P-051a (schema + auth) and P-051b (deploy + DNS).
4. **Discord webhook poster spec (audit G)** — v4 said "reuse existing notification surface." No such surface exists. v5 specs the webhook poster as new code in §11.
5. **Hyperbee schema versioning (audit H)** — v4 left this as Q-4. v5 moves it into P-030 with a concrete versioning policy: every Autobase op carries a `schema_version` field; peers ignore ops with newer-than-known schemas + raise an "upgrade Papercusp" toast.
6. **PG schemas for new HYPERBEE tables (audit I)** — v5 adds explicit `CREATE TABLE` schemas for `feature_queue`, `contributors`, and `pr_reviewer_settings` in §7.1 / §7.8. They get added to `apps/operator/lib/ensure-schema.ts` (per audit A's two-ensure-path rule).
7. **Conflict-resolution fallback (audit J)** — v4 said "operator conflict UI (or $EDITOR fallback)." No conflict UI exists; v5 drops the "or" and specifies the $EDITOR fallback as v1 behavior.
8. **OAuth scopes for Gist attestation (audit L)** — v5 §0.6 specifies required scopes: `gist` + `read:user` minimum. Wizard requests these at OAuth time.
9. **Octokit poll error handling (audit M)** — v5 §8.4 adds: exponential backoff on 5xx (max 5min), honor `X-RateLimit-Reset` header on 429, auto-refresh expired tokens, alert user on 401-after-refresh.
10. **Phase sizing re-summed (audit Q)** — Phase 1 (was L, actually XL ≈ 8–10 weeks) split into Phase 1a (workspace + classifier + UI shell) and Phase 1b (OAuth + clone + device attestation). Phase 5 (was L, actually XL ≈ 7–9 weeks) split into Phase 5a (Hyperbee plumbing) and Phase 5b (UI integration + clobber toast).

**Answers to v4 open questions (8 of 9 resolved):**

- **Q-1 Cupboard moderation** → ship Phase 9 with rate-limit per `github_user_id` + report endpoint; manual review operator-side; richer moderation deferred to Phase 12+ (recorded as new D-023).
- **Q-2 Mobile** → no adjustments to mobile in this plan; mobile keeps its existing per-engineer feature queue surface only. No shared-harness mobile UI. Recorded as out-of-scope; removed Q-2 from open list.
- **Q-3 Identity revocation race** → user accepts the existing Autobase semantics (prior writes from revoked pubkey persist in history; future writes ignored). No design changes needed. Removed Q-3.
- **Q-4 Hyperbee schema migrations** → answered by user request for recommendation. v5 D-024: every Autobase op carries `schema_version BIGINT`; peers maintain a `known_schema_versions` table per harness; unknown-newer schema → ignore op + emit "newer Papercusp available" toast. Removed Q-4 (now decided).
- **Q-5 Peer-mirror disk footprint** → defer to Phase 12+. Recorded; removed from active questions.
- **Q-6 Sleeping laptop convergence latency** → make this part of v1: ship a "Hyperbee bootstrap progress" indicator (sub-second status events from Autobase merge events). New item P-066 in Phase 5b.
- **Q-7 (was already resolved)** → removed entirely (separate-repos confirmed in Phase 1 gate).
- **Q-8 Discord URI scheme** → user confirms works on all OSes with Discord desktop installed. v5 simplifies §11: drop the OS-specific fallback prose; only fallback is "no Discord desktop installed → HTTPS URL in new tab." Removed Q-8.
- **Q-9 vditor vs Starlight** → vditor for BOTH reading AND editing of single-markdown surfaces (its live-editing toggle is the win). Starlight reserved for real multi-doc sites (the existing `apps/operator-docs/` and the public `apps/papercusp-docs/`). v5 D-020 clarified; removed Q-9.

**Net open-questions list**: 1 remaining (the moderation policy itself, scoped to Phase 12+).

**Smaller documentation tidies (audit B, C, N, O, P, R applied as text edits, no scope change).**

## Background

(v4 §Background carries forward verbatim. Papercusp's substrate is in place: Tauri desktop, embedded PG18 via `embedded-postgres-server` ^18.3.0-beta.17 with `wal_level=logical`, Next.js operator, embedded-pg discovery file, OAuth provider lib, `libs/sync` SyncProvider + SSEAdapter, `harness-fs-watcher`, `workspace-listener.ts`, `harness_features_consolidated` / `harness_issues_consolidated` canonical, `@rocicorp/zero` retired but dep not yet removed. Phase 0 spike is the gate before anything ships; named fallback is "HYPERBEE bucket collapses into GIT bucket.")

**Two-ensure-path reality (NEW in v5):**
- `libs/papercusp/libs/db/sql/*.sql` → 114 SQL-migrated tables, run by the migration system at boot.
- `apps/operator/lib/ensure-schema.ts` → 57 tables in `harness_shared` created at operator boot via `CREATE TABLE IF NOT EXISTS`.
- New tables added by v5 (`feature_queue`, `contributors`, augmented `pr_reviewer_settings`) go into `ensure-schema.ts` — same path the existing HYPERBEE-bucket tables use.

## Goals

(Same as v4. Restated for completeness.)

1. **Workspace + harness model** that supports private + shared modes with submodule walking.
2. **Per-human cross-device identity** via GitHub-Gist attestation, no centralized server.
3. **Live collab via Hyperbee + Autobase**, falling back to git-as-sync only if Phase 0 spike fails.
4. **GitHub-forced for PRs and identity attestation**, behind a `PrHost` abstraction.
5. **A Cupboard registry for public harnesses**, discoverable + joinable in one click.

## Non-goals

(Same as v4 + one addition.)

- Replacing GitHub-the-attestation-authority.
- Collaboration features for private harnesses beyond what's already there.
- Pear / Bare runtime adoption.
- A truly P2P attestation authority.
- **Mobile UI surfaces for collaboration features** (v5 confirms: mobile stays on its existing per-engineer queue; no shared-harness UI changes for mobile).
- Webhook-based PR live state (poll-only in v1).
- Issue collaboration model (deferred until issue use cases firm up).
- Cross-harness queue unification across separate-repo harnesses.

## Done

v5 ships when:
- Phase 0 spike passes (Holepunch primitives bundle and converge as expected) OR the named fallback is invoked.
- Phases 1a, 1b, 2, 3, 4 are complete: a private harness on papercup runs the existing single-engineer flow against this plan's primitives.
- Phases 5a, 5b, 6, 7, 8 are complete: a shared-private harness works end-to-end with one other engineer.
- Phase 9 ships Cupboard + Discord + sync-with-main.
- Phases 10, 11 are complete: peer-mirror is opt-in-able and Cupboard listings exist.
- Dogfood signal: the team is using Papercusp to run Papercusp's own development queue, not just demoing.


## Decided-first gate

Before Phase 1a begins:
- **Resolved (Q-7 from v3)**: 4 papercup repos (papercup, papercusp-desktop, papercup-rust, papercup-rust-mobile) stay separate. No monorepo. No umbrella superproject. §2 submodule walking applies WITHIN each repo only (papercup's 9 `libs/*` submodules); cross-repo grouping is just multi-harness-in-one-workspace.
- **Workspace name**: `papercusp-workspace` (literal).
- **`libs/` topology confirmed at implementation start** (updated 2026-05-23, P-001 + P-007): 17 dirs total = 9 submodules (rule #1) + 8 plain (rule #4). Plain dirs: `flags`, `holepunch-spike` (created during P-001 spike), `host-platform`, `marketplace-public-ui`, `papercusp-export-state`, `papercusp-publish-auth`, `sse`, `test-config`. Submodules per `.gitmodules`: `agent-chat`, `git-graph`, `papercup-db`, `papercup-shared`, `papercusp`, `papergrid`, `sync`, `ui-primitives`, `zero-harness`. Drift from this count is asserted by `apps/operator/lib/harness/classify-tree.test.ts`.

## Design

### §0 — Collaboration model

The core shift from "Papercusp with collaboration features" to "Papercusp where collaboration is the substrate":

- Identity is per-human (`github_user_id`), not per-machine.
- Each contributor to a shared harness gets their own long-lived branch (`user/<github_user_id>`) and worktree.
- Features stay PG-canonical (synced via Hyperbee, NOT committed to git).
- The orchestrator on each peer respects an atomic distributed claim (via Autobase merge-order arbitration).
- Trust is keyed by `trusted_github_user_id` (the human), persists across that user's devices, persists across GitHub renames.
- Membership = contributorship: the act of joining via Papercusp earns the contributor label.

#### §0.1 — Identity

**Identity is per-human.** Root identifier = `github_user_id` (BIGINT, GitHub's stable numeric user ID, never recycled across renames or account migrations). Display name = `github_username`, refreshed on poll. Avatar from `https://avatars.githubusercontent.com/u/<id>` with a deterministic identicon fallback (derived from `github_user_id` hash).

#### §0.2 — Device binding via GitHub-Gist attestation (D-001)

1. On first use, device generates an Ed25519 keypair (`device_pubkey`) and stores the private key in the OS keychain (libsecret on Linux, Keychain on macOS, Credential Manager on Windows).
2. User completes GitHub OAuth on that device. **Required scopes**: `gist` (for attestation gist creation) + `read:user` (for `github_user_id` read). Wizard requests these explicitly.
3. Device uses the OAuth token to call `GET https://api.github.com/user` → reads `id` (BIGINT) and `login` (string).
4. Device creates a **public gist** in the user's GitHub account named `papercusp-device-binding-<pubkey-prefix-8chars>.json`, body:
   ```json
   {
     "github_user_id": 12345,
     "github_username": "alice",
     "device_pubkey": "ed25519:<base64url>",
     "device_label": "alice-macbook-pro",
     "created_at": "2026-05-23T18:00:00Z",
     "signature_by_device": "<base64url-signed body>"
   }
   ```
5. Device emits a Hyperbee binding row referencing the gist URL: `contributors/<github_user_id>/devices/<device_pubkey>` → `{gist_id, gist_url, github_username, created_at}`.
6. Peers verify by `GET https://api.gist.com/gists/<gist_id>` — confirms the gist owner matches the claimed `github_user_id` AND contains the claimed `device_pubkey`. Cache the verified binding for ~24h; re-verify in background.
7. Revocation = delete the gist. Peers detect 404 on next re-verification and reject the device's signatures going forward.

**Auto-trust across devices.** Trust is keyed by `trusted_github_user_id`. New devices added by a trusted human are auto-trusted with no re-trust gesture. OAuth + gist combination guarantees only the actual GitHub-account holder can bind a new device.

**Revocation race (Q-3, resolved)**: when a stolen device's pubkey is revoked, prior writes from that pubkey persist in Autobase history (append-only). Future writes are ignored. User accepts this; no design changes.

#### §0.3 — Contributors

Anyone who joins a shared harness (via link or via Cupboard) becomes a contributor. No two-tier "member vs contributor" distinction. The Contributors tab (§9.2) lists everyone.

#### §0.4 — User branch + worktree

When a user joins a shared harness:
- A long-lived branch `user/<github_user_id>` on the GitHub remote (e.g. `user/12345`).
- A local worktree at `<harness-root>/.papercusp/user-trees/<github_user_id>/` (worktree of the same `user/<id>` branch).
- ONE physical worktree per harness. `main` is accessed via:
  - The §16 "sync with main" trio (status indicator + button + auto-rebase-on-push).
  - A virtual "diff against main" view in the operator UI.
  - Manual `git worktree add` on demand if the user wants to physically `cd` into main.

#### §0.5 — Feature state machine

- `backlog` — filed but not in any user's queue.
- `in_queue` — pulled into a user's queue (one row per `(github_user_id, feature_id)` in `feature_queue` HYPERBEE table). Multiple users can queue the same feature simultaneously.
- `working` — orchestrator claimed it via §0.6 arbitration OR user manually flipped to working. `working_users[]` records who; `working_users[0]` is the derived `current_worker`. Today's flow keeps `working_users` size 1; the schema supports future multi-user.
- `pending_done` — agent finished, PR opened, awaiting review/merge.
- `shipped` — PR merged; `completion_ref` populated with merge commit SHA.

Lifecycle on merge: feature row stays in PG/Hyperbee with `status='shipped'`. The branch (`user/<id>`) is NOT deleted — it stays as the user's workspace for next features.

#### §0.6 — Orchestrator distributed claim (Autobase merge-order arbitration, D-002)

The new distributed primitive in this design.

1. Orchestrator on peer A reads PG. Sees feature F-042 in state `in_queue`, `working_users` empty.
2. A appends a *claim record* to the harness Autobase: `{kind: 'feature_claim', feature_id: 'F-042', claimer_pubkey: A_pub, claimer_github_user_id: 12345, ts: <iso>, schema_version: 1}`.
3. A **awaits its own append being merged into the local Autobase view** (typically 50–200ms on a healthy mesh). NOT a fixed sleep; A subscribes to view-change events and detects "my just-appended record is now in the merged view."
4. A reads the merged view and finds *all* claims for `F-042`. Autobase orders them deterministically by `(writer_pubkey, seq)`.
5. If A's claim is first in the order: A wins → fires the agent. If not: A loses → drops + retries on a different feature.
6. The losing peer NEVER fires its agent for F-042; mathematical guarantee, no wasted cycles.

Latency floor = Autobase merge convergence (~50–200ms on healthy mesh), which is also the lower bound for any other guarantee. Quiescence-window approach from earlier drafts is rejected (D-002).

### §1 — Workspace, harness, sub-harness

#### §1.1 — Workspace

`papercusp-workspace` is a named, sentinel workspace (per user decision). One per Papercusp install; holds N harnesses. Per-workspace state lives under `~/.papercusp-workspaces/papercusp-workspace/` (the existing workspace dir shape).

#### §1.2 — Harness

A harness is `{slug, path, state}`, where `state ∈ {private, shared-private, shared-public}`. Default state for newly-created harnesses = `private`. Conversion via §5 wizard.

State semantics:
- `private` — single-engineer, no Hyperbee, no user-branch.
- `shared-private` — invite-link-gated. Hyperbee sync + user-branch + GitHub-forced.
- `shared-public` — same as shared-private + Cupboard registry entry.

#### §1.3 — Sub-harness

When the harness root has `.gitmodules`, each submodule becomes a sub-harness node sharing the root's queue. The walk follows the §2 five-rule classifier.

Sub-harness slugs are path-qualified: `papercup/libs/sync`, not just `sync`.

Sub-harnesses DO NOT have their own queue. They register as code-location nodes within the root harness's queue. A feature tagged `libs/sync` (the component axis) is the same feature, lives in the root's `harness_features_consolidated`.

### §2 — Submodule/worktree five-rule classifier

(Verified at v5 write-time against papercup's actual `libs/` topology: 16 dirs total = 9 rule-1 + 7 rule-4.)

When walking nested directories under a harness root:

1. **`.git` file pointing to `<parent>/.git/modules/<name>`** → submodule. Register as sub-harness node sharing root's queue. Tagged with component path (e.g. `libs/sync`).
2. **`.git` file pointing to `<parent>/.git/worktrees/<name>`** → worktree of the same repo. NOT a new harness. Skip.
3. **`.git` directory (not a file)** → standalone repo nested inside. Register as a separate top-level harness in the same workspace.
4. **Directory with no `.git` at all** → just a code directory, part of the parent repo. Skip.
5. **Path-qualified slugs**: sub-harness slugs are `<parent-slug>/<relative-path>` (e.g. `papercup/libs/sync`) — disambiguates across the workspace.


### §3 — Create-harness UI (4 entries)

Picker exposes 4 mutually-exclusive entry points. Each maps to a different backend code path.

**Entry 1 — New local directory (non-git).** User picks a folder name + parent dir. Operator creates the directory, runs `git init`, scaffolds harness, registers in PG via `POST /api/harness/projects`. State defaults to `private`.

**Entry 2 — GitHub URL.** User pastes a GitHub HTTPS URL. Operator requires GitHub OAuth (fires §0.2 if first time). Clones via `isomorphic-git` with the OAuth token as auth (new dep). Scaffolds harness, walks `.gitmodules` per §2. State defaults to `private`. User can later convert to shared via §5 wizard.

**Entry 3 — Existing local repo.** User picks an existing directory. Backend uses the existing `POST /api/harness/projects` route which validates `existsSync(path)` and runs `scaffoldHarnessSchema(slug)`. **Entry 3 does NOT require GitHub auth** (no remote interaction). State defaults to `private`.

**Entry 4 — Harness link (shared harnesses only).** User pastes a `papercusp://harness?topic=<hex>&github=<owner>/<repo>` URL. Operator:
1. Requires GitHub OAuth (fires §0.2 attestation flow if first time on this device).
2. Clones the GitHub repo via Entry 2's clone helper.
3. Joins Hyperswarm topic (`<hex>`).
4. Bootstraps Hyperbee from peer-replicated Autobase.
5. Seeds local PG from the projection.
6. Creates `user/<github_user_id>` branch + worktree.
7. Publishes contributor binding to Hyperbee.

### §4 — Harness states + transitions

- `private` (default for Entries 1, 2, 3) — single-engineer, no Hyperbee, no user-branch.
- `shared-private` — invite-link-gated. Hyperbee + user-branch + GitHub-forced.
- `shared-public` — same as shared-private + Cupboard registry entry.

Transitions:
- `private → shared-private` via §5 wizard.
- `shared-private → shared-public` via "publish to Cupboard" action.
- `shared-public → shared-private` via "remove from Cupboard" action.
- **No shared → private downgrade.** Once shared, stays shared (downgrade would orphan other engineers' branches).

### §5 — Share-this-harness wizard

Seven-step flow:

1. **Confirm GitHub remote.** `git remote -v` must show an authenticated GitHub remote. If not, prompt to add one (OAuth-gated).
2. **Generate Hyperswarm topic.** 32 random bytes. Becomes the harness's swarm key.
3. **Choose Discord channel** (optional). If user provides a channel link, store in `.harness/config.json` (committed to git).
4. **Choose privacy** (shared-private or shared-public).
5. **Privacy confirm-modal (D-013)**:
   - `shared-private`: "Anyone with this link can join and see all contributors' GitHub usernames + avatars."
   - `shared-public`: "This harness will be listed in the Cupboard. Your GitHub username, display name, and avatar will be visible to anyone."
6. **Backfill from PG to Hyperbee + GIT** (§7.3): one-time seeding of all HYPERBEE-bucket and GIT-bucket data from this engineer's PG.
7. **Write `.harness/shared.json`** (committed) with `{topic, github_remote, discord_channel?, privacy, created_at, schema_version}`. Generate harness link: `papercusp://harness?topic=<hex>&github=<owner>/<repo>`. Display for sharing.

### §6 — Hybrid sync model

Two transport layers:

**HYPERBEE** — live, sub-second propagation for state that changes fast:
- Feature queue + status changes
- Contributor list + device attestations
- Presence (who's currently in the harness UI)
- Current PR live state (status checks summary)
- Orchestrator claim records (Autobase log)

**GIT** — file-per-row in `.harness/state/` for state that changes slowly + benefits from human-diffable history:
- Decisions
- Summaries
- Design artifacts (text/markdown)
- Test fixtures, claims, findings
- Phases (legacy, kept for private harnesses)
- Shipped-feature history (rebuilt from `harness_features_consolidated` on first boot via projection)

**LWW honesty (D-012)**: conflicts in HYPERBEE tables resolve last-writer-wins by (timestamp, writer_pubkey) tie-break. NOT real CRDT merge. When two peers update the same row's same field, one update silently wins. **UI surfaces clobbers**: "your change was overridden" toast with diff link when a peer's recent write loses.

**Path B git layer (D-008)**: Hyperdrive peer-mirror for code, default OFF per-harness, opt-in via a per-harness toggle. When ON: post-commit hook pushes to a local bare mirror; Hyperdrive replicates the bare mirror to peers; peers fetch from their local mirror. Cuts engineer-to-engineer code latency from ~5s (auto-fetch on Hyperbee status hint) to <1s.

**Schema versioning (D-024, NEW)**: every Autobase op carries a `schema_version BIGINT`. Each peer maintains `known_schema_versions` per harness (LOCAL). When a peer receives an op with `schema_version > my_max_known`, the op is **ignored** AND a toast fires: "A newer Papercusp is in use by another contributor. Update to participate fully." This prevents corrupting newer-shape data with an older-shape peer. Schema-version increments are bundled with Papercusp release versions.


### §7 — Table classification (HYPERBEE / GIT / LOCAL / SECURITY)

**v5 schema-source addition (audit A)**: Papercusp uses TWO ensure-paths for PG schema:
- `libs/papercusp/libs/db/sql/*.sql` — migration files run at boot (~114 unique CREATE TABLEs across all schemas).
- `apps/operator/lib/ensure-schema.ts` — runtime `CREATE TABLE IF NOT EXISTS` execution (~57 tables in `harness_shared`).

Several v4-classified HYPERBEE tables (`coord_presence`, `harness_decisions`, `harness_lanes`, `harness_checkpoints`, `harness_branch_actions`, `harness_skills`, `harness_feature_prs`, `snapshot_features`) live in `ensure-schema.ts`, NOT SQL files. The Hyperbee projection process (P-031) **MUST** wait for both ensure-paths to complete at boot before reading or writing.

New v5 tables (`feature_queue`, `contributors`, augmented `pr_reviewer_settings`) go into `ensure-schema.ts` — same path as existing HYPERBEE-bucket tables.

#### §7.1 — HYPERBEE bucket (7 tables, ~live state)

Propagate via Hyperbee CRDT (Autobase log → Hyperbee KV → per-peer projection back into PG).

| Table | Schema source | Why HYPERBEE | Hyperbee key shape |
|---|---|---|---|
| `harness_features_consolidated` | `001-shared.sql` | Queue, status, working state change sub-second | `features/by-id/<feature_id>` + `features/by-status/<status>/<id>` |
| `feature_queue` (NEW) | `ensure-schema.ts` | Pointer table; queue membership live | `queue/<github_user_id>/<feature_id>` |
| `contributors` (NEW) | `ensure-schema.ts` | Membership + device attestations | `contributors/<github_user_id>` |
| `coord_presence` | `ensure-schema.ts` | Who is in harness UI right now | `presence/<github_user_id>/<machine_label>` |
| `feature_claims` (NEW) | `ensure-schema.ts` (audit log only) | Orchestrator arbitration; Autobase-only | `claims/<feature_id>/<seq>` (append-only) |
| `harness_feature_prs` | `ensure-schema.ts` | Shared PR metadata + live status from poll | `prs/<feature_id>` |
| `harness_issues_consolidated` | `030-harness-issues-canonical.sql` | Issue queue, mirrors feature mechanics. v5: keep shared row, do NOT add `working_users` / `current_worker` / `completion_ref` (deferred per D-017) | `issues/<issue_id>` |

**Schema additions to existing tables** (HYPERBEE-bucket):
- `harness_features_consolidated`:
  - `created_by_github_user_id BIGINT` — author identity
  - `working_users BIGINT[]` — array of github_user_ids currently working
  - `completion_ref JSONB` — `{remote, branch, commit_sha, pr_url}` populated when status → `pending_done` or `shipped`
  - `worked_by_history JSONB[]` — append-only audit of who worked on it
  - `current_worker` is **derived** as `working_users[0]`; NOT stored
- `harness_issues_consolidated`: no schema additions in v5 (deferred per D-017).
- `harness_feature_prs`: extend with `last_polled_at`, `checks_status` (summary), `mergeable_state`, `review_decision`, `reviewers[]`.

**New table schemas (added to `apps/operator/lib/ensure-schema.ts`)**:

```sql
-- feature_queue: pointer-per-(user, feature). One row per queue entry.
CREATE TABLE IF NOT EXISTS harness_shared.feature_queue (
  harness_slug TEXT NOT NULL,
  github_user_id BIGINT NOT NULL,
  feature_id TEXT NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  schema_version BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (harness_slug, github_user_id, feature_id)
);
CREATE INDEX IF NOT EXISTS idx_feature_queue_feature
  ON harness_shared.feature_queue (harness_slug, feature_id);

-- contributors: human identity with device list + attestation refs
CREATE TABLE IF NOT EXISTS harness_shared.contributors (
  harness_slug TEXT NOT NULL,
  github_user_id BIGINT NOT NULL,
  github_username TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  device_attestations JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- shape: [{device_pubkey, gist_id, gist_url, device_label, created_at, signature_by_device}]
  revoked_pubkeys TEXT[] NOT NULL DEFAULT '{}',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  schema_version BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (harness_slug, github_user_id)
);

-- feature_claims: Autobase-only audit log (also mirrored to PG for diagnostics).
CREATE TABLE IF NOT EXISTS harness_shared.feature_claims (
  harness_slug TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  seq BIGINT NOT NULL,             -- Autobase sequence (writer_pubkey + counter)
  claimer_pubkey TEXT NOT NULL,
  claimer_github_user_id BIGINT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL,
  outcome TEXT,                    -- 'won' | 'lost' | NULL when in-flight
  schema_version BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (harness_slug, feature_id, seq)
);
```

#### §7.2 — GIT bucket (~20 tables, file-per-row in `.harness/state/`)

Document-shaped, slow-changing. Each table maps to a directory under `.harness/state/<table>/`; each row is a JSON or markdown file keyed by id. Mutations commit-debounced at 15s.

| Table | Schema source | Storage |
|---|---|---|
| `harness_decisions` | `ensure-schema.ts` + `063-decisions-search.sql` | `.harness/state/decisions/<id>.md` (front matter + body, vditor-edited) |
| `harness_summaries` | `017-harness-shared-phase-and-proposal-cols.sql` | `.harness/state/summaries/<id>.md` |
| `harness_escalations` | `018-zero-migration-batch.sql` + `ensure-schema.ts` | `.harness/state/escalations/<id>.md` |
| `harness_design_artifacts` | `048-design-phase.sql` | `.harness/state/design/<id>.md` |
| `harness_text_artifacts` | `035-harness-text-artifacts-canonical.sql` | `.harness/state/text-artifacts/<id>.md` |
| `harness_chunk_plans` | `042-harness-chunk-plans.sql` | `.harness/state/chunk-plans/<feature_id>/<chunk_id>.json` |
| `harness_feature_notes` | `025-harness-registry-and-feature-notes.sql` | `.harness/state/feature-notes/<feature_id>/<note_id>.md` |
| `feature_audit_consolidated` | drizzle snapshot | `.harness/state/feature-audit/<feature_id>.jsonl` (append-only log) |
| `harness_tests` | `018-zero-migration-batch.sql` + `ensure-schema.ts` | `.harness/state/tests/<id>.md` |
| `llm_test_fixtures` | `073-llm-testing.sql` | `.harness/state/llm-test-fixtures/<id>.json` |
| `llm_test_claims` | `074-llm-test-claims.sql` | `.harness/state/llm-test-claims/<id>.json` |
| `llm_test_findings` | `073-llm-testing.sql` | `.harness/state/llm-test-findings/<id>.json` |
| `harness_phases` | `018-zero-migration-batch.sql` + `ensure-schema.ts` | `.harness/state/phases.json` (legacy; only present in `private` harnesses per D-006) |
| `harness_promotions` | `ensure-schema.ts` | `.harness/state/promotions/<id>.json` (legacy) |
| `harness_lanes` | `ensure-schema.ts` | `.harness/state/lanes.json` |
| `harness_checkpoints` | `ensure-schema.ts` | `.harness/state/checkpoints/<id>.json` |
| `harness_branch_actions` | `ensure-schema.ts` | `.harness/state/branch-actions/<id>.json` |
| `harness_snapshots` | `002-per-harness-template.sql` | `.harness/state/snapshots/<id>.json` (metadata only; tarball content stays LOCAL) |
| `harness_experts` | `057-expert-assertions.sql` + `ensure-schema.ts` (related) | `.harness/state/experts/<id>.md` |
| `harness_skills` | `ensure-schema.ts` | `.harness/state/skills/<id>.md` |
| `goals` | `005-goals-events-routines.sql` | `.harness/state/goals/<id>.md` |
| `papercup_shared.messages` | `003-papercup-shared.sql` | `.harness/state/cross-agent-messages/<id>.json` |
| `papercup_shared.directives` | `003-papercup-shared.sql` | `.harness/state/directives/<id>.json` |
| `papercup_shared.briefings` | `003-papercup-shared.sql` | `.harness/state/briefings/<id>.json` |
| `{{SCHEMA}}.messages` | per-harness template | `.harness/state/agent-messages/<id>.json` |
| `{{SCHEMA}}.supervisor_notes` | per-harness template | `.harness/state/supervisor-notes/<id>.md` |
| `{{SCHEMA}}.directive_summaries` | per-harness template | `.harness/state/directive-summaries/<id>.md` |
| `harness_proposals_shared` | `017-harness-shared-phase-and-proposal-cols.sql` + `ensure-schema.ts` | `.harness/state/proposals/<id>.md` (legacy; v5 P-051 verifies if still used) |
| `snapshot_features` | `ensure-schema.ts` | `.harness/state/snapshot-features/<id>.json` |
| `project_spec_revisions` | `007-project-specs.sql` | Rebuilt from `SPEC.md` git history; not duplicated as files |

**Projection direction**: GIT is the canonical store. On startup, the operator scans `.harness/state/` and rebuilds the PG rows (replacing them). Mutations in PG fire write hooks that serialize → write file → debounce commit. Conflicts surface as git merge conflicts (visible, human-resolvable).

#### §7.3 — Backfill from PG (one-time, at share-time)

When a user converts a private harness to shared via §5 wizard:
- For each GIT-bucket table, serialize current PG rows → write files under `.harness/state/<table>/` → commit as `chore(harness): seed shared state from local PG`.
- For each HYPERBEE-bucket table, serialize current PG rows → append as Autobase log records under the bootstrap epoch.
- After backfill, write hooks on PG tables become active; further mutations flow through the appropriate transport.

#### §7.4 — LOCAL bucket (~120 tables, per-engineer operational state)

NEVER cross machines. Operational, telemetry, runtime, personal config, UI state, plugin state, mobile, backups, voice. Includes ALL `plan_*` tables.

| Category | Tables |
|---|---|
| Plans | `plan_revisions`, `plan_runs`, `plan_run_turns`, `harness_plan_review`, `harness_brainstorm` |
| Runtime | All `*_run`, `*_runs`, `*_telemetry`, `*_session`, `*_invocations`, `tool_invocations` |
| Spawns | `harness_shared.spawns`, `spawn_signatures`, `spawn_sig_verification_failures` |
| Agent runtime | `agent_chats`, `agent_chat_*`, `agent_messages`, `agent_runs`, `agent_state` |
| Logs | `toast_log`, `console_log`, `audit_log`, `error_log` |
| Operator | `operator_*` (preferences, drafts, settings, UI state) |
| Plugin state | All `plugin_*` except those flagged HYPERBEE conditional |
| Backups | All `kopia_*` |
| Mobile | All `mobile_*` |
| Voice | All `voice_*` (sessions, transcripts; credentials gated SECURITY) |
| Embedded PG | `embedded_pg_*` |
| Search | `search_cache`, `search_results` |
| LLM caches | `llm_completion_cache`, `llm_embedding_cache` |
| Memory | `mem0_*` (per-engineer agent memory) |
| Project history | `project_spec_revisions` (rebuildable from git, not duplicated) |
| **PR check status detail cache** | NEW `pr_check_status_cache` — per-engineer cache of GitHub check-run details fetched on click |
| **Known schema versions** | NEW `known_schema_versions(harness_slug, max_known_version, updated_at)` — per-engineer; drives the §6 newer-schema-detection toast |
| **Auto-review audit** | NEW `auto_review_audit(harness_slug, pr_number, action, ts)` — per-engineer log of auto-approve / auto-merge actions |
| **Claim audit** | NEW `claim_audit(harness_slug, feature_id, attempt_ts, outcome)` — per-engineer log of orchestrator claim attempts |

#### §7.5 — SECURITY bucket (~22 tables, NEVER cross machines under any circumstance)

| Category | Tables |
|---|---|
| Auth | All `papercusp_auth.*`, `users`, `user_sessions`, `user_preferences` |
| Audit | `auth_audit_log`, `auth_rate_limit`, `cooldown_marks` |
| Tokens | `oauth_nonces`, `token_index`, `system_principals`, `jti_used` |
| Sessions | `power_user_sessions`, `pi_sessions`, `mobile_pair_tokens` |
| Credentials | All `operator_*credentials*`, `secrets`, `marketplace_token`, `publish_credentials`, `voice_credentials`, `search_provider_credentials`, `trust_store` |
| Local trust | `trusted_authors` (keyed by `trusted_github_user_id`, LOCAL by design) |
| PR reviewer settings | `pr_reviewer_settings` keyed by `(harness_slug, github_user_id)` |
| Plugin grants | `plugin_capability_grants` |

#### §7.6 — HYPERBEE conditional (~9 tables, only if feature used)

| Table | Bucket if active |
|---|---|
| `org_features`, `org_decisions`, `org_summaries`, `org_directives`, `org_briefings`, `org_messages`, `org_escalations` | HYPERBEE (rare; most harnesses don't use org-overlay) |
| `plugin_jira_sync.links`, `plugin_linear_sync.links` | HYPERBEE if shared, LOCAL otherwise (plugin opt-in) |
| `plugin_kv` (per plugin) | Plugin-author choice (HYPERBEE or LOCAL via plugin manifest) |

#### §7.7 — Legacy tables (flagged for verification at implementation)

- `{{SCHEMA}}.harness_proposals` — proposals hero bar was removed earlier; verify table still in use before classifying
- `harness_pending_issues` — LOCAL inbox vs HYPERBEE team triage (needs use-case confirmation)
- Plain `harness_features` (legacy path) vs `harness_features_consolidated` — implementing agent must diff §7 against live `001-shared.sql` and reconcile

#### §7.8 — `pr_reviewer_settings` schema

```sql
-- ensure-schema.ts; LOCAL only; per-engineer config; identity = github_user_id
CREATE TABLE IF NOT EXISTS harness_shared.pr_reviewer_settings (
  harness_slug TEXT NOT NULL,
  github_user_id BIGINT NOT NULL,
  pr_reviewer_role_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  auto_review BOOLEAN NOT NULL DEFAULT FALSE,
  auto_merge BOOLEAN NOT NULL DEFAULT FALSE,
  merge_method TEXT NOT NULL DEFAULT 'squash' CHECK (merge_method IN ('squash','merge','rebase')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (harness_slug, github_user_id)
);
```


### §8 — PR lifecycle

#### §8.1 — Open PR from agent

When an agent in a worker run finishes:
1. Agent commits to `user/<github_user_id>` branch in its worktree.
2. Auto-rebase-on-push (§16) runs: `git fetch origin main && git rebase origin/main`. On conflict, escalate (§16.2).
3. On clean rebase, push to `user/<github_user_id>` on the GitHub remote.
4. Open a PR via Octokit (`@octokit/rest`, new dep): `POST /repos/{owner}/{repo}/pulls` with `head: user/<github_user_id>`, `base: main`, title from feature, body referencing `closes F-<id>`.
5. Feature status flips to `pending_done`. `completion_ref` JSONB populated with `{remote, branch: user/<id>, commit_sha: HEAD, pr_url: <returned-url>, pr_number}`.
6. HYPERBEE-sync the feature row + `harness_feature_prs` row.

#### §8.2 — Trust-list-gated auto-approve

Per-reviewer: if `pr_reviewer_role_enabled` AND `auto_review` are both true AND PR author's `github_user_id` is in `trusted_authors` for this harness:
1. Octokit fetches the PR.
2. If status checks all green (poll-cached, §8.4), reviewer's operator posts `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with `event: APPROVE`.
3. Audit row written to LOCAL `auto_review_audit` table.

Untrusted PRs sit in the manual-review queue (§9.3 PR tab).

#### §8.3 — Auto-merge (separate opt-in)

Independent toggle `auto_merge` (default FALSE). If both `auto_review` and `auto_merge` are true AND PR approved AND checks green:
1. Octokit `PUT /repos/{owner}/{repo}/pulls/{number}/merge` with `merge_method` from settings (default `squash`).
2. Feature status → `shipped`; `completion_ref.commit_sha` → merge commit.
3. The `user/<github_user_id>` branch is **not deleted**.

**Three coherent reviewer postures:**
- **Hands-off**: `auto_review=true, auto_merge=true` — full automation, requires trust list discipline.
- **Cautious**: `auto_review=true, auto_merge=false` — auto-approve to save the click, human merges deliberately.
- **Manual**: both false — every PR human-reviewed.

**Consequence modal at trust-add (D-013, refined)**: when adding to trust list AND `auto_review=true`, modal: "Future PRs from this contributor will be auto-approved by you while your auto-review is on. Continue?" When also `auto_merge=true`: "...and will be auto-merged when checks pass."

#### §8.4 — PR live-state polling (with audit-M error handling)

**One bulk request per harness per 60s** when ≥1 PR is open; idle (no requests) otherwise.

```
GET /repos/{owner}/{repo}/pulls?state=open&per_page=100
```

Returns up to 100 open PRs in one call. Extract per-PR: `head.sha`, `base.sha`, `merged`, `mergeable`, `mergeable_state`, `requested_reviewers[]`, `assignees[]`. Status checks summary requires a follow-up `GET /repos/{owner}/{repo}/commits/{head.sha}/check-runs`.

**Cache:**
- HYPERBEE `harness_feature_prs.checks_status` (summary) — shared across peers.
- LOCAL `pr_check_status_cache` — per-engineer cache of individual check-run details, populated on user click.

**Rate budget**: 5000 req/hr authenticated. Comfortable order-of-magnitude headroom.

**Error handling (NEW in v5, audit M):**
- **5xx**: exponential backoff (2s, 4s, 8s, 16s, 32s, capped at 5min). After 10 consecutive failures, surface "Cannot reach GitHub" status badge in §9.3.
- **429 (rate-limit)**: honor `X-RateLimit-Reset` header; suspend polling until reset; resume with the standard cadence.
- **401 (token expired)**: invoke `refresh()` on the OAuth provider (existing surface at `apps/operator/lib/oauth/providers.ts`). If refresh fails: surface "GitHub auth expired" toast linking to settings.
- **404 on a known PR**: PR was deleted/transferred; remove from cache; demote `harness_feature_prs` row to `state='gone'`.

**Webhook**: out of scope for v1. Phase 12+ optimization once Cloudflare-tunnel ingress is normalized for arbitrary harnesses.

#### §8.5 — PR review surface = GitHub UI itself (D-013 v3 stands)

Don't build a PR review UI in Papercusp. The PR tab (§9.3) lists open PRs and links out to GitHub for actual review. Reviewer's local operator polls + executes auto-approve / auto-merge actions via Octokit when configured.

#### §8.6 — Manual review path

For untrusted authors:
1. PR sits in the manual queue.
2. Reviewer with `pr_reviewer_role_enabled=true` clicks PR in §9.3.
3. Opens GitHub PR page in a new browser tab.
4. Reviews on GitHub.
5. Returns to Papercusp. PR tab shows "approved" / "changes-requested" via poll within 60s.
6. If reviewer trusts the author after this review, they add the author to their trust list via the §9.2 Contributors tab (consequence modal per §8.3).

### §9 — Sidebar tabs

Three new tabs (in addition to existing tabs):

#### §9.1 — Features tab

Lists ALL features in the harness (HYPERBEE-synced). Each row:
- Feature ID + title
- Status pill (`backlog` / `in_queue` / `working` / `pending_done` / `shipped`)
- Author avatar (`created_by_github_user_id`)
- Queue avatars stack (users with this feature in their queue)
- Working avatar highlight (`working_users[0]`)
- "Pull into my queue" button — adds to `feature_queue` row keyed by `(my_github_user_id, feature_id)`
- "Remove from my queue" if already queued

Filter chips: `mine`, `working`, `available`, `shipped`.

Click → detail panel with description (vditor-rendered markdown), notes, audit log, current PR.

#### §9.2 — Contributors tab

Lists all contributors (HYPERBEE-synced `contributors` table):
- Avatar (GitHub avatar by `github_user_id` or identicon fallback)
- Display name + `@github_username` (resolved at display-time)
- Joined date
- Activity badges: features authored, features worked, PRs merged
- Per-contributor menu (visible if I have `pr_reviewer_role_enabled`):
  - "Add to my trust list" / "Remove from my trust list" (consequence modal per §8.3)
- Devices section (collapsed by default): each `device_pubkey` + machine label + attestation gist URL (link out)

#### §9.3 — PRs tab

Lists open PRs (poll-cached per §8.4). Each row:
- PR number + title
- Author avatar
- Status: checks (green/red/pending), reviews (approved/changes-requested/pending)
- Trust badge: ✓ if author is in my trust list
- "Cannot reach GitHub" badge if §8.4 polling has failed for >5min
- Action buttons (if `pr_reviewer_role_enabled`):
  - "Open on GitHub" (always)
  - "Approve" (manual)
  - "Approve + merge" (manual)
  - "Auto-review on/off" indicator (read-only summary)

Filter chips: `mine`, `awaiting-me`, `awaiting-review`, `approved`, `merged`.

#### §9.4 — PR-reviewer settings (gear icon in PRs tab)

Per-harness settings modal:
- `pr_reviewer_role_enabled` (bool)
- `auto_review` (bool, only enabled if role is enabled)
- `auto_merge` (bool, only enabled if auto_review is on)
- `merge_method` (squash/merge/rebase; default squash)
- Trust list view: who's trusted; remove inline
- Audit log: recent auto-review and auto-merge actions

### §10 — Cupboard registry (public harnesses) — sub-design (audit F)

A new top-level navbar item `Cupboard`, sibling to existing nav. v5 specifies the architecture v4 left implicit.

#### §10.1 — Where it lives

**Cupboard server lives as a route group inside `apps/operator-public/` (NEW app)**, NOT inside the desktop-bundled operator. Reasoning:
- Public-facing service can't piggy-back on per-user embedded PG.
- Marketplace pipeline (`project_marketplace_pipeline` memory) already runs separately on :3057 as systemd unit — Cupboard joins the same pattern.
- Self-hosters can run their own Cupboard pointing at their own registry.

Default deployment: `cupboard.papercusp.dev` (a single Cloudflare-fronted Next.js app + small managed Postgres). Self-host: any operator can override `PAPERCUSP_CUPBOARD_URL` env to point elsewhere.

#### §10.2 — Schema

```sql
-- public.harnesses (in cupboard server's PG, NOT in user's embedded PG)
CREATE TABLE harnesses (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  harness_link TEXT NOT NULL,            -- papercusp://harness?topic=<hex>&github=<owner>/<repo>
  github_repo TEXT NOT NULL,             -- owner/repo
  github_repo_must_be_public BOOLEAN NOT NULL DEFAULT TRUE,
  published_by_github_user_id BIGINT NOT NULL,
  contributor_count_estimate INT NOT NULL DEFAULT 1,  -- self-reported, recomputed weekly
  last_activity_at TIMESTAMPTZ,
  language TEXT,
  tags TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id BIGSERIAL PRIMARY KEY,
  harness_id BIGINT NOT NULL REFERENCES harnesses(id),
  reporter_github_user_id BIGINT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution TEXT
);

CREATE TABLE publish_rate_limit (
  github_user_id BIGINT PRIMARY KEY,
  publishes_this_hour INT NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### §10.3 — Auth + anti-abuse

- **Publish**: `POST /harnesses` requires GitHub OAuth (same provider as desktop). Rate-limited at 5 publishes per `github_user_id` per hour. Rejects if GitHub repo is private.
- **Report**: `POST /reports` requires GitHub OAuth. Reporter identity recorded.
- **Unlisting**: `DELETE /harnesses/:id` — only by the original publisher (`published_by_github_user_id`) OR by Cupboard operator on resolved abuse report.
- **Listing fetch**: `GET /harnesses` — public, no auth.

#### §10.4 — Moderation (Phase 9 v1, scaled per D-023)

- Manual operator-side review of reports.
- Spam-only auto-flagging via Cloudflare rate-limit at the edge (not Phase 9 scope; future).
- Phase 12+: richer tools (auto-takedown on multiple reports, contributor reputation, etc.).

#### §10.5 — Joining

Clicking a Cupboard listing → "Install this harness" → runs Entry 4 flow with the harness link.

#### §10.6 — UI

Same component family as the existing Marketplace pages. Card grid (avatars/tags/description), filter + search, detail view shows contributors + recent activity + README pulled from the GitHub repo via Octokit.

### §11 — Discord integration (audit G fix + Q-8 resolution)

**Per-harness Discord channel pointer** in `.harness/config.json` (committed):

```json
{
  "discord_channel_url": "https://discord.com/channels/123456/789012",
  "discord_webhook_url": null
}
```

**Switch-to-harness behavior**: when user activates a harness with `discord_channel_url` set, fire `discord://discord.com/channels/123456/789012` URI scheme. Discord desktop intercepts and focuses the channel.

**OS support (Q-8 resolved)**: user confirms the URI scheme works across macOS, Linux, Windows when Discord desktop is installed. No OS-specific fallbacks needed; the only fallback is "no Discord desktop installed → HTTPS URL in new tab."

**Opt-in**: per-user setting `auto_focus_discord_on_harness_switch` (default FALSE). Otherwise it's a manual "Open Discord channel" button in the harness sidebar.

**Optional outbound webhook (audit G)**: if `discord_webhook_url` is set, operator posts harness events:
- New shared-feature filed
- PR opened / merged
- Escalation

**Implementation (NEW in v5)**: the operator currently has no general "post to external HTTP" abstraction. v5 specifies a small new module `apps/operator/lib/integrations/outbound-webhook.ts` that:
- Maintains an in-process work queue per harness.
- Posts events as fire-and-forget JSON.
- Retries with exponential backoff on 5xx (3 attempts).
- Logs failures to LOCAL `webhook_audit` table.
- Does NOT block harness operations on webhook success/failure.

Discord webhook adapter calls this module with Discord's standard webhook payload shape (`{content, embeds[], username, avatar_url}`).

**No bot, no auto-create channel** (D-014 stands). Channel + webhook are external Discord-side config.


### §12 — P2P transport (Hyperswarm + Hyperbee + Autobase)

**Packages** (all unscoped npm modules; `holepunchto` is the GitHub org but published packages are NOT scoped; D-015 — primitives, NOT Pear):
- `hyperswarm` — DHT-based peer discovery + UDP holepunching
- `corestore` — manages local Hypercore storage
- `hypercore` — append-only signed log per writer
- `autobase` — multi-writer append-only log merged into a single linearized view
- `hyperbee` — P2P B-tree (sorted KV) over Hypercore (or Autobase)
- `hyperdht` — the DHT (transitive)
- `hyperdrive` — P2P filesystem (Path B per-harness opt-in, §14)
- `b4a` — Buffer-compatible byte arrays for cross-runtime

Verified install + load on Node 25 Linux x64 (commit `fa887946` and follow-ups). Native deps (UDX, sodium-native) ship prebuilds — no system toolchain required on Linux. macOS/Windows verification pending (needs those hosts). Spike package at `libs/holepunch-spike/`.

**Possible future amendment**: context7 surfaced **HyperDB** (a newer abstraction over Hyperbee with RocksDB-backed local indexing). May be worth evaluating as the projection-layer substrate (§7.1) once the base spike fully closes. Out of scope for Phase 0 itself.

**Per-harness swarm**:
- 32-byte topic key generated at share-time (§5).
- On join, peer connects to Hyperswarm with the topic → discovers other peers → exchanges Hypercore writer keys.
- Each contributor's device has its own Hypercore writer (one writer per `device_pubkey`).
- All writers feed into a per-harness Autobase; the Autobase merged view is then projected into a Hyperbee for KV reads.

**Per-table Hyperbee namespacing**:
- One Hyperbee per harness; tables namespaced by key prefix: `features/`, `contributors/`, `queue/`, `presence/`, `prs/`, `issues/`, `claims/`.
- Secondary indexes maintained as additional key prefixes: `features/by-status/<status>/<id>`. Rebuilt on view-change events.

**Write path**:
1. PG row mutated locally.
2. Write hook serializes the row into a KV update op (with `schema_version` field, per D-024).
3. Op appended to peer's local Hypercore writer log.
4. Autobase merges into the view; Hyperbee KV updated.
5. Hyperswarm replicates the Hypercore to peers; each peer's Autobase converges; each peer's projection process writes back to local PG.

**Read path**:
1. UI/operator reads from local PG (already-projected state).
2. `useSyncQuery` (§13) listens for invalidations triggered by PG-side `pg_notify` from the projection process.

**Schema versioning (D-024)**: every op carries `schema_version BIGINT`. Peer ignores ops with `schema_version > my_known_max`. Toast: "Newer Papercusp in use by another contributor. Update to participate fully." `known_schema_versions` table (LOCAL §7.4) tracks per-harness max known version, bumped on Papercusp upgrade.

**Why not Yjs / Automerge for the data layer**: Yjs is text-CRDT-shaped (used for `vditor` rich text; not tabular). Automerge is doc-CRDT-shaped (could work but adds a second CRDT stack alongside Autobase/Hyperbee). Single primitive set wins.

**Why not Pear runtime (D-015)**: Pear replaces Tauri end-to-end — months-long port. Not v1.

**Phase 0 spike gates this** (P-001..P-005): validate the unscoped npm packages (hyperswarm, hypercore, autobase, hyperbee, corestore, hyperdrive, hyperdht, b4a) bundle into Tauri/Node desktop build (native deps: UDX, sodium-native), validate Autobase stability under expected churn (3-5 active writers per harness, sleeping laptops returning days later). If spike fails: fallback is "HYPERBEE bucket collapses into GIT bucket."

**P-001..P-004 sub-gates closed on Linux x64 Node 25** (2026-05-23, commits `fa887946`, `f94346d8`, `6f6b753e`, `ff2cdd3f`): install + load (7s), two-peer swarm loopback via real DHT (~7-10s), two-writer Autobase convergence on deterministic merged view, Hyperbee-over-Autobase KV with LWW conflict resolution + range queries. Remaining Phase 0 work: macOS/Windows verification, Tauri-bundle verification, sleeping-laptop convergence, real cross-network test.

### §13 — Reactivity architecture

Three tiers, mostly already shipped.

**Tier 1 — UI invalidation (`libs/sync`)** (existing):
- `SyncProvider` wraps the app; manages SSE connection.
- `useSyncQuery` wraps TanStack Query; auto-invalidates on SSE messages matching query keys.
- `SSEAdapter` parses SSE invalidation messages.

**Tier 2 — Producer (the gap to close)**:
- PG-side `emit_change_notify` trigger function (NEW). Attached to every "reactive" table (HYPERBEE-bucket + curated subset of GIT-bucket).
- Trigger fires `pg_notify('papercusp_changes', json_build_object('table', TG_TABLE_NAME, 'op', TG_OP, 'pk', new.id, 'workspace_id', current_setting('papercusp.workspace_id')))`.
- One SSE endpoint at `/api/sync/stream` does `LISTEN papercusp_changes` per workspace + multiplexes to all subscribed client sessions.
- `workspace-listener.ts` pattern (existing for lock notifications via `ch_coord_<wsId>`, in `apps/operator/lib/agent-tools/locks/`) is the template.

**Tier 3 — Polling fallback**:
- `useSyncQuery` falls back to polling at TanStack Query's default `staleTime` if SSE disconnects.
- Some surfaces (PR live state via GitHub poll, §8.4) inherently poll; the SSE invalidation kicks in when the poll-result causes a PG row update.

**v5 migration tasks**:
- Wire `emit_change_notify` triggers to HYPERBEE tables + select GIT-bucket tables (presence, queue).
- Migrate `apps/operator/app/admin/plans/*` from `useAsyncJson` + 30s polling → `useSyncQuery`.
- Remove residual Zero WS adapter wiring + `@rocicorp/zero` dep (verified still in `apps/operator/package.json` + `libs/zero-harness/package.json` at v5 write-time).

### §14 — Path B (Hyperdrive git peer-mirror)

**Default OFF** per harness; opt-in via per-harness toggle (offered in §5 wizard at share-time).

**Mechanics**:
1. Per-peer bare-mirror repo at `~/.papercusp/peer-mirrors/<harness-slug>.git` (normal bare git, never `gc`'d).
2. Git `post-commit` hook in user's worktree: `git push --quiet file://~/.papercusp/peer-mirrors/<harness-slug>.git HEAD`. ~50ms locally.
3. Hyperdrive watches `~/.papercusp/peer-mirrors/<harness-slug>.git/` (one Hyperdrive per harness peer-mirror).
4. Hyperdrive replicates the bare-mirror dir to peers over the same Hyperswarm topic.
5. Peer's operator receives Hyperdrive update event → `git fetch <peer-mirror>` locally (file URL, no network).
6. Peer's main repo gains the new commit. Optional: "Bob has new commits on F-042" notification in §9.1.

**Visibility implication (D-013)**: when enabled, commits propagate to peers immediately — before push to GitHub.

**Mitigations**:
- Default OFF per harness (D-014).
- On enable, modal: "Once enabled, every commit on your `user/<id>` branch will be visible to other contributors before you push to GitHub. WIP commits should use the `wip/` branch prefix to stay local."
- Per-harness branch-pattern filter: `^(user/|feature/|fix/|chore/|docs/|refactor/|test/)` by default; user can edit.
- `wip/*` branches NEVER mirrored.
- "Privacy purge" tool: if a secret slipped in, the operator offers a guided `git filter-repo` + Hyperdrive cache wipe across peers (best-effort; clearly noted that nothing is fully reclaimable post-replication).

**Fallback when peer offline**: `git fetch origin` from GitHub as canonical. Mirror is an optimization, not a replacement.

### §15 — `completion_ref` + trust model

#### §15.1 — `completion_ref` schema

Added to `harness_features_consolidated` (§7.1):

```sql
completion_ref JSONB
-- {remote: "github.com/owner/repo", branch: "user/12345", commit_sha: "abc...", pr_url: "...", pr_number: 42}
```

#### §15.2 — Status verification

When feature → `pending_done`:
1. Operator captures `{remote, branch, commit_sha, pr_url, pr_number}` from PR-open response (§8.1).
2. Stored in `completion_ref`.
3. Background verifier (every 5min when in `pending_done`): `git ls-remote origin <branch>` confirms commit at remote. On divergence (force-push, branch deleted), warn in §9.1.

When feature → `shipped`:
1. PR-merge event (§8.4 poll or auto-merge) updates `completion_ref.commit_sha` to merge commit, sets `merged_at`.
2. No further verification needed.

**Cached, NEVER on-read**: `git ls-remote` is rate-limited and slow. Reads serve from cached `completion_ref` + latest verification timestamp.

#### §15.3 — Trust model

```sql
-- LOCAL only; NEVER synced. Your trust list is yours.
CREATE TABLE IF NOT EXISTS harness_shared.trusted_authors (
  harness_slug TEXT NOT NULL,
  trusted_github_user_id BIGINT NOT NULL,
  trusted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trusted_by_github_user_id BIGINT NOT NULL,
  PRIMARY KEY (harness_slug, trusted_github_user_id)
);
```

- Trust keyed by `trusted_github_user_id` (the human).
- Trust persists across the trusted user's device additions (auto-trusted) per §0.2.
- Trust persists across GitHub renames (numeric id never changes).
- "Add to trust list" gesture requires `pr_reviewer_role_enabled` (§9.2 / §9.4).
- **No "trust anyone" rule** (D-014): no UI affordance to bulk-trust or auto-trust new contributors.

### §16 — Sync-with-main UI (audit J fix)

Three small surfaces.

#### §16.1 — Status indicator

In harness sidebar header: badge "behind main by N commits" when `user/<id>` is behind `origin/main`. Click → opens sync flow.

Computation: `git rev-list --count user/<id>..origin/main` after each `git fetch origin main` (background-poll every 60s when harness is active).

#### §16.2 — Manual sync button

Badge dropdown: "Sync with main" button. On click:
1. `git fetch origin main`
2. `git rebase origin/main` in user's worktree.
3. On clean rebase: success toast.
4. **On conflict (v1 behavior, audit J)**: open the user's `$EDITOR` (resolved from `git config core.editor`, falling back to `$EDITOR` env, falling back to `vi`) on each conflicted file in sequence. Plus an inline operator panel listing conflicted files with "open in editor" / "mark resolved" / "abort rebase" buttons. **NO custom conflict-resolution UI in v5** (none exists today; building one is out of scope).

#### §16.3 — Auto-rebase-on-push (default ON)

Before every agent push (§8.1 step 2):
1. `git fetch origin main`.
2. `git rebase origin/main`.
3. **On clean rebase**: proceed with push.
4. **On conflict (agent-driven, unattended)**:
   - Open `harness_escalations` row: `{kind: 'rebase_conflict', feature_id, conflicted_files[], stash_ref}`.
   - Stash the agent's changes to `wip/conflict-F-<id>-<ts>` branch.
   - Reset feature status to `in_queue`, clear `working_users`.
   - Surface in §9.1 as warning + escalation panel: "F-042 hit a conflict — review and decide."
   - User can: resolve manually, re-queue for orchestrator (which will re-run with fresh main), or abandon the WIP branch.

Per-harness toggle: `auto_rebase_on_push` (default TRUE). Disable if team prefers manual conflict handling.


## Scope

**In scope:**
- All 13 phases below, end-to-end (Phase 1 split into 1a + 1b; Phase 5 split into 5a + 5b per audit Q).
- Schema additions and trigger wiring per §7 / §13.
- New tables in `ensure-schema.ts`: `feature_queue`, `contributors`, `feature_claims`, `pr_reviewer_settings` (augmented), `pr_check_status_cache`, `known_schema_versions`, `auto_review_audit`, `claim_audit`, `webhook_audit`, `trusted_authors` (augmented).
- All UI surfaces in §3, §9, §10, §11, §16.
- The PrHost abstraction (GitHub impl in v1).
- Phase 0 spike + named fallback.
- Hyperbee schema versioning per D-024.
- Cupboard sub-architecture per §10.1–§10.6.

**Out of scope:**
- GitLab / Gitea / Bitbucket PrHost implementations (v2+).
- Truly P2P attestation (research project).
- Pear runtime adoption.
- Webhook-based PR live state (poll-only in v1).
- Issue collaboration model (deferred until issue use cases firm up).
- Replacing fumadocs/Starlight surfaces for the existing engineering docs site.
- Cross-harness queue unification across separate-repo harnesses (Q-7 resolved: separate).
- **Mobile UI for collab features (Q-2 resolved)**: mobile stays on per-engineer queue only; no shared-harness mobile views.
- Custom conflict-resolution UI for sync-with-main (audit J: $EDITOR fallback is v1).
- Peer-mirror disk-footprint compaction tooling (Q-5 deferred to Phase 12+).
- Richer Cupboard moderation tools beyond rate-limit + reports (Q-1 / D-023, deferred to Phase 12+).

## Phases

Sizing legend: **S** = ~1-3 days. **M** = ~1 week. **L** = ~2-3 weeks. **XL** = >3 weeks (split candidate).

### Phase 0 — Spike (gate before all subsequent phases) [M]

- **P-001** [M] Bundle the Holepunch primitive packages (`hyperswarm`, `hypercore`, `autobase`, `hyperbee`, `corestore`, `hyperdrive`, `hyperdht`, `b4a` — all unscoped npm names; published from the `holepunchto` GitHub org) into the Tauri+Node desktop build. Verify native-dep prebuilds (UDX, sodium-native) cover macOS / Linux / Windows targets. **PARTIAL PASS as of 2026-05-23**: Linux x64 Node 25 verified (commits `fa887946`..`ff2cdd3f`, see `libs/holepunch-spike/`); macOS + Windows + Tauri-bundle verification still pending.
- **P-002** [S] Hyperswarm DHT join + UDP holepunching smoke test across 2 networks (home + cellular tether).
- **P-003** [M] Autobase stability test: 3 writers, 1000 ops each, sleeping-peer simulation (offline for hours, reconnects, view re-converges). Measure convergence latency.
- **P-004** [S] Hyperbee KV write/read benchmarks under projected load (~10 ops/sec).
- **P-005** [S] Decision gate: spike pass → proceed; spike fail → trigger fallback (HYPERBEE bucket collapses into GIT bucket).

### Phase 1a — Workspace + create-harness UI shell + classifier [M]

- **P-006** [S] Create the `papercusp-workspace` (literal name) — sentinel workspace for dogfooding papercup itself. Schema-only; UI binds later.
- **P-007** [S] Implement §2 five-rule classifier as `apps/operator/lib/harness/classify-tree.ts`. Tests for all five cases against papercup's actual `libs/` (9 sub + 7 plain = 16 dirs total).
- **P-010** [M] Entry 1 (new local non-git dir) + Entry 3 (existing local repo): UI shell + backend `{kind: 'local_init'}` and `{kind: 'local_existing'}` handlers. Entry 3 reuses existing `POST /api/harness/projects` path-validation; Entry 1 wraps `mkdir` + `git init` + Entry 3. **Entry 3 does NOT require GitHub auth.**
- **P-012** [M] Create-harness UI shell: 4-entry picker, per-entry forms, progress UI for clone/init, error handling. Uses vditor for description input.
- **P-013** [S] PG schema (in `ensure-schema.ts`): register harness rows in `harness_registry` with `entry_kind` + `state` columns. Also adds the new `feature_queue`, `contributors`, `feature_claims`, `pr_reviewer_settings` (augmented), `pr_check_status_cache`, `known_schema_versions`, `auto_review_audit`, `claim_audit`, `webhook_audit` tables.

### Phase 1b — OAuth + clone + device attestation [L]

- **P-008** [L] Entry 2 (GitHub URL): add `isomorphic-git` + `@octokit/rest` + `@octokit/auth-oauth-device` deps (NEW). Build `clone-with-oauth` helper. Wire into `POST /api/harness/projects` to accept `{kind: 'github_url', url, oauth_token}`. Real work, not just wiring; OAuth lib provides token mgmt, not clone-with-auth.
- **P-009** [L] Entry 4 (harness link): add link-paste flow. Parse `papercusp://harness?topic=<hex>&github=<owner>/<repo>` URL scheme. On accept: GitHub OAuth → clone via P-008 → join Hyperswarm topic → bootstrap Hyperbee → seed PG. Device attestation (P-011) runs here on first-join.
- **P-011** [L] Device attestation: `apps/operator/lib/identity/attest.ts`. Octokit + gist creation flow with **required scopes `gist` + `read:user`** (audit L). Verifier helper for inbound bindings (compares `gist.owner.id` to claimed `github_user_id`). Local cache (~24h TTL). Tests against a real GitHub test account.

**Decided-first gate (recap)**: Phase 1a + 1b assume Q-7 resolved (4 repos separate) + `papercusp-workspace` name. Decided.

### Phase 2 — `completion_ref` + status verification [M]

- **P-014** [S] Schema add `completion_ref JSONB` to `harness_features_consolidated` (SQL migration since the base table is in `001-shared.sql`).
- **P-015** [M] Schema additions to `harness_features_consolidated` per §7.1 (`created_by_github_user_id`, `working_users[]`, `worked_by_history`). **Explicitly NOT adding** issue-equivalent columns to `harness_issues_consolidated` (D-017).
- **P-016** [M] Background verifier daemon. `git ls-remote` polling. Cache + divergence-warning surfacing.
- **P-017** [S] Surface in PlanDetail / FeatureDetail UI: `completion_ref` + verification timestamp; warn on divergence.

### Phase 3 — Reactivity migration (independently shippable) [M]

- **P-018** [S] PG-side `emit_change_notify` trigger function. Migration 078 adds it. **REVISED 2026-05-24** (commits 20609bb + c549e5c4): emits on the **existing** `sync_invalidate` channel (not a new `papercusp_changes` channel) with the established `{name, args}` payload shape — so the existing SSE endpoint `/api/zero-harness/sse` + `notifySyncInvalidate()`-style consumers serve both app-code notifies and PG-trigger notifies. The 90s dedupe window in `sync-sse.ts` handles the overlap when application code ALSO fires the trigger. Application-code `notifySyncInvalidate()` and PG-trigger `emit_change_notify()` are now complementary producers on the same channel: app-code = fine-grained intentional notifies; PG trigger = coarse catch-all that fires on EVERY write including raw SQL / MCP-tool direct writes / migrations.
- **P-019** [M] Attach trigger to HYPERBEE-bucket tables + curated GIT-bucket tables. End-to-end invalidation test. **Part 1 done** in commit `da1284f6` (`wireDogfoodTriggers` helper attaching to the 10 new dogfood tables); **part 2 pending** (existing HYPERBEE tables like `harness_features_consolidated`, `harness_issues_consolidated`, `coord_presence`, `harness_feature_prs` — needs a trigger-interaction audit since those already have writers that may call `notifySyncInvalidate()`).
- **P-020** [DROPPED 2026-05-24] **Original**: new `/api/sync/stream` endpoint with `LISTEN papercusp_changes`. **Why dropped**: discovered the project already had this — `/api/zero-harness/sse` + `apps/operator/lib/sync-sse.ts` (`subscribe()` / `notifySyncInvalidate()` / 60s ring buffer / Last-Event-ID replay), used by 20+ existing writers. P-020's implementation (commit `e4fe1bcf`) was parallel infrastructure; reverted in commit `a0327933` and 078's channel routed to `sync_invalidate` instead. No work needed here.
- **P-021** [S/M] Migrate `apps/operator/app/admin/plans/*` from `useAsyncJson` → `useSyncQuery`. **Note (2026-05-23 discovery)**: the actual `useAsyncJson` in `plans-api.ts` is fetch-on-mount with manual `refresh()`, NOT 30s polling — v5's original "30s polling" wording was inaccurate, no polling to remove. **Entanglement with P-022**: `useSyncQuery` resolves `queryName` through the `@restart/zero-harness` ZQL registry (`zero-harness-resolver.ts`); switching plans-admin to it means either adding plans queries to that Zero-coupled registry (which P-022 retires) OR landing a Zero-free `useSyncQuery` first. Split the work: **P-021a (server side, done in commit XXXX)** — `notifySyncInvalidate('plans.list'|'plans.get'|...)` fires on every successful plan write via the existing `sync_invalidate` channel; any future client subscriber works immediately. **P-021b (client side, deferred until after P-022)** — the actual hook migration.
- **P-022** [S/M] Remove `@rocicorp/zero` dep from `apps/operator/package.json` + `libs/zero-harness/package.json`. Audit any residual Zero WS adapter wiring; remove. **Replace `zero-harness-resolver.ts` with a Zero-free query registry** (a switch-on-name pattern like `device/sync.ts` already uses) so P-021b can land without re-entangling.
- **P-023** [S] Documentation: how to add a new reactive table (trigger + bucket assignment + `useSyncQuery` key naming).

### Phase 4 — Single-engineer dogfood (papercup as `state: private`) [M]

**Purpose**: prove the harness-creation + PR + completion_ref flow on a real codebase BEFORE adding any sharing/P2P complexity.

- **P-024** [S] Use Entry 3 to register the papercup repo as a harness in the new `papercusp-workspace`, `state: private`. No GitHub auth needed at this step.
- **P-025** [S] Seed initial features into the harness queue. Reuse existing feature-CRUD tools.
- **P-026** [M] Run a feature end-to-end on papercup: orchestrator picks → worker run → PR opened → manual review → merge → `shipped`. Verify `completion_ref` populates and status reaches `shipped`.
- **P-027** [S] Observe scale: existing UI on papercup's 175+ tables, 50+ existing features. Capture pain points as follow-up items.
- **P-028** [S] Decision gate: if Phase 4 surfaces blocker-level pain, fix before Phase 5; otherwise proceed.

### Phase 5a — Hyperbee plumbing [L]

- **P-029** [M] §5 share-this-harness wizard UI. Seven-step flow + privacy confirm-modal.
- **P-030** [L] Hyperbee schema + Autobase setup: per-harness corestore, per-writer Hypercore, Autobase wiring. `apps/operator/lib/sync/hyperbee/*` module. **Includes D-024 schema-versioning**: every op carries `schema_version BIGINT`; `known_schema_versions` per-engineer table; ignore-and-toast on newer-than-known.
- **P-031** [L] Write-side projection: PG write hooks for HYPERBEE-bucket tables → serialize → append to Hypercore. Read-side projection: Hyperbee → PG row writes + `pg_notify` for §13 invalidation. **MUST gate on both ensure-paths complete** (`ensure-schema.ts` + SQL migrations) before projection starts.
- **P-066** [S] (NEW per Q-6 resolution): Sleeping-laptop bootstrap progress indicator. Subscribe to Autobase merge events; surface as "Syncing harness (N/M ops merged)..." status in harness sidebar header. Auto-dismisses when caught up.

### Phase 5b — Hyperbee UI integration + clobber-toast [M]

- **P-032** [M] `feature_queue` HYPERBEE table + UI in §9.1 Features tab.
- **P-033** [M] `contributors` HYPERBEE table + `user/<github_user_id>` branch creation on join + worktree setup.
- **P-034** [S] §3 Entry 4 link-join flow extended to call wizard's bootstrap on join completion.
- **P-035** [S] LWW clobber-toast UI: detect remote write that overrode my recent local write → toast with diff link.

### Phase 6 — Orchestrator distributed claim [M]

- **P-036** [M] `feature_claims` Autobase log structure. Append-then-await-merge flow.
- **P-037** [M] Orchestrator integration: on feature pickup, call claim arbitration; on win, proceed; on loss, drop + retry on next feature.
- **P-038** [S] Manual "set active" flow per §0.5: user flips queued feature to `working` directly. Orchestrator respects (won't pick up actively-flipped).
- **P-039** [S] Claim audit: every claim attempt + outcome captured in LOCAL `claim_audit` for diagnostics.

### Phase 7 — PR lifecycle [L]

- **P-040** [M] PrHost abstraction interface (`apps/operator/lib/pr-host/index.ts`) + GitHub impl via Octokit (`@octokit/rest`, new dep). Open PR, get PR, post review, merge, list-open-PRs (bulk per §8.4).
- **P-041** [M] Auto-rebase-on-push (§16.3) integration into worker run's push step. Conflict → escalation flow.
- **P-042** [M] PR poll daemon. 60s cadence per harness when ≥1 PR open. Updates `harness_feature_prs` (HYPERBEE) + LOCAL `pr_check_status_cache`. Includes audit-M error handling (exponential backoff on 5xx, honor `X-RateLimit-Reset` on 429, OAuth-refresh on 401, demote-to-gone on 404).
- **P-043** [M] §9.3 PRs tab UI.
- **P-044** [M] Auto-approve flow gated on trust list. `pr_reviewer_settings` + per-PR check + Octokit approve call.
- **P-045** [S] Auto-merge flow gated on auto-merge toggle + auto-approve outcome + checks green.
- **P-046** [S] §8.6 manual review path + trust-add consequence modal.

### Phase 8 — Sidebar tabs + identity UI [L]

- **P-047** [M] §9.1 Features tab UI. Queue/working/shipped filters. Pull-into-queue actions.
- **P-048** [M] §9.2 Contributors tab UI. Avatar rendering (GitHub avatar OR identicon). Trust-list actions (gated by `pr_reviewer_role_enabled`).
- **P-049** [S] §9.4 PR-reviewer settings modal.
- **P-050** [M] vditor integration. **Per D-020-v5 clarification**: vditor used for BOTH editing AND reading of single-markdown surfaces (feature descriptions, decisions, design artifacts). Starlight reserved for real multi-doc sites only (existing `apps/operator-docs/` + `apps/papercusp-docs/`). Migration of existing PlanEditor in `apps/operator/app/admin/plans/` to vditor included.

### Phase 9 — Cupboard + Discord + sync-with-main [L]

- **P-051a** [M] Cupboard server (NEW app `apps/operator-public/`): schema (§10.2), auth (GitHub OAuth, §10.3), rate-limit + report endpoints. Self-host-able via `PAPERCUSP_CUPBOARD_URL` env.
- **P-051b** [S] Cupboard server deployment: Cloudflare-fronted Next.js + managed Postgres at `cupboard.papercusp.dev`. DNS + cert setup.
- **P-052** [M] Cupboard UI in operator: navbar item, card grid (reuse Marketplace component family), filter + search + detail view.
- **P-053** [S] Publish-to-Cupboard action wired into §5 wizard for `shared-public` state.
- **P-054** [S] Discord integration: deep-link on harness switch (opt-in setting, fallback to HTTPS URL), optional outbound webhook via new `apps/operator/lib/integrations/outbound-webhook.ts` module (audit G).
- **P-055** [M] §16 sync-with-main trio: status badge, manual sync button (with $EDITOR fallback per audit J), auto-rebase-on-push (wired in P-041).

### Phase 10 — Path B Hyperdrive peer-mirror (optional opt-in) [M]

- **P-056** [M] Per-peer bare-mirror repo creation + git `post-commit` hook installer. Per-harness toggle.
- **P-057** [M] Hyperdrive instance per harness peer-mirror. Replicate over harness Hyperswarm topic.
- **P-058** [S] Auto-`git fetch` on Hyperdrive update event. Surface "Bob has new commits on F-042" notification in §9.1.
- **P-059** [S] Per-harness branch-pattern filter (default `^(user/|feature/|fix/|chore/|docs/|refactor/|test/)`); `wip/*` never mirrored.
- **P-060** [M] Privacy-purge tool: guided `git filter-repo` + Hyperdrive cache wipe (best-effort).

### Phase 11 — Multi-engineer dogfood [L]

- **P-061** [M] Onboard a second engineer (real or simulated via second machine). Run paired feature flow: A files, B picks up via §9.1, B works, B opens PR, A reviews on GitHub, B's auto-merge fires.
- **P-062** [S] Stress test: 3+ engineers, 10+ features in flight simultaneously. Measure HYPERBEE convergence + UI invalidation latency end-to-end.
- **P-063** [M] Capture issues from multi-engineer dogfood as Phase-12+ follow-up plans.
- **P-064** [S] Documentation: contributor onboarding guide ("how to join a Papercusp harness"). Lives in `apps/operator-docs/`.
- **P-065** [S] Cupboard publish: list the papercup harness as canonical dogfood example.


## Decisions

### D-001 — Identity is per-human (`github_user_id`), devices bind via GitHub-Gist attestation

**Decided.** Trust is keyed by `trusted_github_user_id` (the human). Each device generates Ed25519 keypair (stored in OS keychain) and publishes a binding to a public gist in the user's GitHub account; peers verify the gist exists and contains the claimed `device_pubkey`. New devices for a trusted user are auto-trusted; revocation = delete the gist.

**Why**: spoofing requires GitHub session compromise (which already grants worse capabilities). No centralized attestation server to maintain. Self-sovereign. Trust gestures are about humans, not laptops.

**Alternatives rejected**: per-machine pubkey trust (high friction); centralized attestation server (operational burden + critical-path dependency); pure-P2P identity (open research, not v1).

### D-002 — Orchestrator distributed claim via Autobase merge-order arbitration

**Decided.** Append claim → await own-append merge → check first-in-merged-order → fire agent. Mathematical guarantee, no race window.

**Alternatives rejected**: quiescence-window (still races); designated coordinator (single point of failure).

### D-003 — `pr_reviewer_settings` keyed by `(harness_slug, github_user_id)`

**Decided.** Drop `user_id` UUID; use `github_user_id` consistently.

### D-004 — Auto-approve and auto-merge are independent toggles

**Decided.** Both default FALSE. Auto-merge only effective when auto-approve is on. Consequence modal at trust-add when auto-review is on.

**Why**: three coherent reviewer postures (manual / auto-approve-only / full automation). Explicit opt-in for the riskiest step.

### D-005 — Phase 4 single-engineer dogfood uses `state: private` (no sharing prereqs)

**Decided.** No user-branch, no Hyperbee, no peer-mirror. Sharing debuts in Phase 5a.

### D-006 — Phases (staging/testing/production) retired for shared harnesses

**Decided.** Shared harnesses: one user-branch worktree per harness; status state machine replaces phase promotion. Private harnesses keep phases.

### D-007 — Hybrid sync (HYPERBEE for 7 live tables, GIT for ~20 doc tables)

**Decided.** Bucket by write-frequency, not by table name.

**Fallback** (Phase 0 spike fail): collapse HYPERBEE into GIT for everything.

### D-008 — Path B (Hyperdrive git peer-mirror) default OFF, opt-in per harness

**Decided.** Per-harness toggle. Cuts engineer-to-engineer code latency from ~5s to <1s when on.

### D-009 — GitHub-forced for shared harnesses, behind a PrHost abstraction

**Decided.** All shared harnesses require GitHub OAuth. PrHost interface for future GitLab/Gitea.

### D-010 — `github_user_id` (numeric, stable) used in branch names

**Decided.** Branches are `user/12345`, not `user/alice`. Display current `github_username` in UI; render branch via stable id.

### D-011 — Features stay PG-canonical, sync via Hyperbee, NEVER committed to git

**Decided.** Per user direction. Hyperbee gives sub-second live sync; PG remains canonical; git carries code only.

### D-012 — Last-writer-wins on HYPERBEE conflicts; surfaced as "your change was overridden" toast

**Decided.** LWW labeled honestly. Clobber toast in §6.4 + UI.

### D-013 — Privacy confirm-modal at BOTH create-time and join-time

**Decided.** Sharer sees consequence at create-time; joiner at join-time. Same modal pattern for shared-private and shared-public (different copy).

### D-014 — No "trust anyone" affordance, ever

**Decided.** Every trust gesture is per-user deliberate. No bulk-trust, no auto-trust-new-contributors, no domain-trust.

### D-015 — Holepunch primitives only (NOT Pear runtime)

**Decided.** Stay on Tauri. Use the unscoped Holepunch npm modules (`hyperswarm`, `hypercore`, `autobase`, `hyperbee`, `corestore`, `hyperdrive`, `hyperdht`, `b4a`) embedded in existing desktop runtime.

### D-016 — `current_worker` derived, not stored

**Decided.** `working_users` is source of truth; `current_worker = working_users[0]`. No separate column.

### D-017 — `harness_issues_consolidated` does NOT get feature-collab columns in v5

**Decided.** Defer issue collaboration design to its own arc. Don't add `working_users` / `current_worker` / `completion_ref` schema until the issue flow is specced.

### D-018 — PR live state via bulk poll, no webhook in v1

**Decided.** One `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100` per harness per 60s. Cache per §8.4. Error handling per audit M (NEW in v5).

### D-019 — New deps: `isomorphic-git`, `@octokit/rest`, `@octokit/auth-oauth-device`

**Decided (v5, audit D).** `isomorphic-git` for clone-with-OAuth-token (Entry 2). `@octokit/rest` for PR APIs + bulk PR list + check-runs. `@octokit/auth-oauth-device` for device-flow OAuth. Other git operations (peer-mirror push, sync-with-main rebase) continue using shell-out to system `git`.

**Why**: repo currently has none of these. Plan implicitly assumed them in v4; v5 makes the new deps explicit.

### D-020 — vditor for BOTH editing AND reading of single-markdown surfaces (v5 refined)

**Decided (v5, Q-9 resolution).** vditor is the markdown surface for feature descriptions, decisions, design artifacts, and PlanEditor. Its live-edit toggle is the win. Starlight reserved for real multi-doc sites only (existing `apps/operator-docs/` engineering reference, `apps/papercusp-docs/` public site).

**Why**: vditor handles single-markdown read/write more ergonomically than splitting reader vs editor surfaces. Starlight's value is multi-doc navigation + search; doesn't apply to single-doc reads.

### D-021 — Cupboard server is required infrastructure (not P2P-discoverable)

**Decided.** Public-harness discoverability needs a centralized listings service. v5 architecture (§10.1–§10.6) specifies: `apps/operator-public/` (new app), self-host-able via `PAPERCUSP_CUPBOARD_URL`, default deployment at `cupboard.papercusp.dev`.

### D-022 — Reactivity layer = `pg_notify` triggers + LISTEN + SSE + `useSyncQuery`

**Decided.** Per §13. Producer-side `emit_change_notify` triggers are the v5 gap to close.

### D-023 — Cupboard moderation: rate-limit + reports in v1; richer tools deferred (NEW in v5)

**Decided (v5, Q-1 resolution).** Phase 9 ships with rate-limit per `github_user_id` (5 publishes/hr) + `POST /reports` endpoint. Manual review is operator-side. Richer moderation (auto-takedown, reputation, etc.) deferred to Phase 12+.

**Why**: getting v1 out matters more than moderation polish. Pre-alpha; abuse is unlikely at scale-zero.

### D-024 — Hyperbee schema versioning: ignore-and-toast (NEW in v5)

**Decided (v5, Q-4 resolution).** Every Autobase op carries `schema_version BIGINT`. Each peer maintains `known_schema_versions` per harness (LOCAL §7.4). When a peer receives an op with `schema_version > my_known_max`, the op is **ignored** AND a toast fires: "A newer Papercusp is in use by another contributor. Update to participate fully."

**Why**: simplest forward-compatibility story. Schema-version increments are bundled with Papercusp release versions. Prevents corrupting newer-shape data with an older-shape peer.

**Alternatives rejected**: best-effort merge of unknown ops (corrupts data); hard-fail (kills harness for whole team if one peer is behind).

## Open questions

### Q-1 — Cupboard moderation depth beyond v1

**v5 STATUS**: PARTIALLY RESOLVED via D-023. v1 ships rate-limit + reports + manual review. Open: what richer tools (auto-takedown, contributor reputation, etc.) belong in Phase 12+? Scope a sub-plan when adoption is real.

