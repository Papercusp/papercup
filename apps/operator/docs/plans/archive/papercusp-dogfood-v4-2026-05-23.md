---
title: Papercusp dogfood — make Papercusp collaborative-at-the-core
slug: papercusp-dogfood-v4-2026-05-23
date: 2026-05-23
status: superseded
owners: [aviynw3]
supersedes: papercusp-dogfood-v3-2026-05-23
---

> **Superseded by [`papercusp-dogfood-v5-2026-05-23`](./papercusp-dogfood-v5-2026-05-23.md)** — v5 folds in the v4 audit (10 fixes incl. §7 two-ensure-path callout, explicit @octokit/* + isomorphic-git deps, Cupboard sub-design, Discord webhook poster, Hyperbee schema versioning, PG schemas for new HYPERBEE tables, $EDITOR conflict fallback, gist OAuth scopes, Octokit poll error handling, phase re-sizing) plus user resolutions to 8 of 9 open questions (D-023 moderation policy, D-024 schema versioning, Q-2/Q-3/Q-5/Q-7/Q-8/Q-9 closed; Q-6 sleeping-laptop progress indicator pulled into v1 as P-066).


## Now

Land **single-engineer dogfood of papercup** (Phase 4) as the first usable milestone, behind a 7-day Holepunch + Autobase spike (Phase 0) that gates the multi-engineer sync work.

If the spike succeeds, build the multi-engineer collaboration model end-to-end: GitHub-Gist-attested device identity, per-user branches + worktrees, PG-canonical features synced via Hyperbee, orchestrator-claim arbitration over Autobase merge-order, GitHub-forced PR lifecycle with trust-list-gated auto-approve and optional auto-merge, Cupboard registry for public harnesses, Discord deep-link integration.

If the spike fails, fall back to **git-as-sync for everything** (the HYPERBEE bucket collapses into the GIT bucket); the collaboration model still ships, with somewhat higher latency on live state.

## What changed from v3

This is a substantial revision driven by two rounds of user pushback and one technical correction:

1. **Multi-machine identity** — v3 keyed contributors by per-(workspace, harness) pubkey, treating new devices as new identities requiring fresh trust. Wrong. Identity is the human; one human owns N devices; trust extends across all of them. v4 keys contributors by `github_user_id` (stable, never recycled) and uses **GitHub-Gist-as-attestation** for cryptographically strong device-to-human binding, with no centralized attestation server. Trust is keyed by `trusted_github_user_id` only.

2. **Orchestrator claim race** — v3 specified a "quiescence window" that reduced but didn't eliminate double-claims. v4 uses **deterministic merge-order arbitration**: append claim → await own-append merge → verify first-in-merged-order → fire agent. Mathematical guarantee, latency is just Autobase's merge convergence (~50–200ms on a healthy mesh).

3. **PR auto-approve + auto-merge** — v3 specified auto-approve but blocked auto-merge as "always a human gesture," making the human a button-clicker. v4 adds an `auto_merge` toggle alongside `auto_review`, defaulting OFF, with a confirm-modal at trust-add time when `auto_review` is on. Three coherent positions: hands-off, cautious, most-cautious.

4. **Issue lifecycle** — v3 silently added PR-lifecycle columns to `harness_issues_consolidated` "for parallelism." v4 drops these; issues today resolve via `linkedFeatureId` pointing to a fix-feature. When issue collaboration is redesigned (separate arc), the columns can be added with intent.

5. **GitHub username rename** — v3 punted to a Q-N. v4 uses the stable numeric `github_user_id` everywhere (in branch names: `user/12345`, in trust rows, in contributor rows). The current `github_username` is display metadata, refreshed on poll.

6. **PR live-state polling** — v3 hand-waved "poll or webhook." v4 specs **one bulk `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100` per harness per 60s** (idle when no open PRs), cached in `harness_feature_prs` (HYPERBEE for shared metadata) + `pr_check_status_cache` (LOCAL for per-engineer check details). No GitHub webhook in v1; webhook is a Phase 12+ optimization.

7. **Phases vs user-branch** — v3 said "main is via the sync gesture, no phase worktrees" but the phases system (`staging`/`testing`/`production`) is alive. v4 explicitly **retires phases for shared harnesses** — the user-branch IS your staging area, `pending_done` is your testing gate, `shipped` is production. Phases stay available as legacy for private harnesses.

8. **Phase 4 dogfood graph** — v3's Phase 4 was blocked by Phase 5 work (share-private). v4 rewrites Phase 4 around `state: private` papercup — no user-branch, no sharing, no Phase 5 prereq. Just Papercusp's existing single-engineer flow on papercup's real codebase. Preserves the pull-forward planning win.

9. **`pr_reviewer_settings` identity collision** — v3 keyed it by `user_id` (UUID, LOCAL/SECURITY) while every other v3 surface uses pubkey/`github_user_id`. v4 rekeys by `(harness_slug, github_user_id)` for consistency.

10. **`current_worker` redundancy** — v3 stored both `working_users[]` and `current_worker` as separate columns. v4 drops `current_worker`; it's derived as `working_users[0]`.

11. **Agent-driven push conflict** — v3 left this undefined. v4 specs: on conflict during unattended agent push, open a `harness_escalations` row, set feature back to `in_queue`, clear `working_users`, park agent's commits on `wip/conflict-F-NNN-<ts>` branch.

12. **OAuth depth** — v3 underestimated. v4 adds **`isomorphic-git`** as a dependency for clone-with-OAuth-token, replacing shell-out + URL injection. P-008/P-009 sizing acknowledged as L (not just wiring).

13. **Privacy at install-time** — v3 only had a confirm-modal at create-time. v4 adds modals at both create-time (sharer) and join-time (joiner) for shared harnesses.

14. **Phases retirement** — promoted to its own decision (D-023), celebrating the simplification rather than scoping it defensively.

15. **vditor for markdown editing** — explicit choice; v4 uses **vditor** as the in-app markdown editor for plans, decisions, and any user-authored markdown. Drops fumadocs-rendered editing (already gone after Starlight migration anyway). Vditor handles WYSIWYG + markdown source + preview cleanly.

## Background

Papercusp is a multi-agent coding harness. Today it's primarily a single-user tool: one engineer per workspace, one workspace per machine. The Holepunch sync infrastructure planned in v2 made *cross-engineer state* possible but treated collaboration as a sync layer over a single-user model.

This plan reorients around **collaboration as the foundation**. Concretely:
- Identity is per-human (`github_user_id`), not per-machine.
- Each contributor to a shared harness gets their own long-lived branch (`user/<github_user_id>`) and worktree.
- Features stay PG-canonical (synced via Hyperbee, NOT committed to git).
- The orchestrator on each peer respects an atomic distributed claim (via Autobase merge-order arbitration).
- PRs from user branches to main are the merge mechanism; trust-gated auto-approve + optional auto-merge automate the busywork.
- Contributors are first-class: anyone with a link can join (private-shared) or discover via Cupboard (public-shared) and become a contributor by the act of importing the harness.
- Trust is per-human and per-harness, with no "trust anyone" toggle.

The first dogfooding target is **papercup itself**: bringing Papercusp's own codebase under Papercusp's harness system, single-engineer first (Phase 4), then multi-engineer once the collaboration layer ships.

## Goals

1. **Make Papercusp usable on Papercusp's own codebase, single-engineer.** That's the Phase 4 milestone.
2. **Multi-engineer collaboration that feels native, not bolted on.** Shared state lives in the right substrate (PG-canonical via Hyperbee, code via git, project decisions as files in git, trust per-human).
3. **No centralized server we own as critical-path infrastructure.** GitHub is in the trust boundary because we already use it for code; everything else is P2P.
4. **GitHub-forced for PRs and identity attestation.** Behind a `PrHost` abstraction so GitLab/Gitea drop in later.
5. **A Cupboard registry for public harnesses.** Discoverable, joinable in one click.

## Non-goals

- **Real-time collaborative cursor / Google-Docs-style editing.** Not a goal; harness work is async by nature.
- **Replacing GitHub for code transport.** GitHub stays canonical. Hyperdrive peer-mirror is an opt-in latency optimization, off by default.
- **Replacing GitHub-the-attestation-authority.** Identity binds to `github_user_id`; trust assumes GitHub's auth is sound.
- **Collaboration features for private harnesses beyond what's already there.** Private = single-engineer or one-machine-multi-engineer; shared = the new collaboration model. Private stays simple.
- **Pear / Bare runtime adoption.** D-015 from v3 stands. v1 uses Holepunch primitives only.
- **A truly P2P attestation authority.** GitHub-Gist is the pragmatic answer; pure-P2P identity is open research, not v1.

## Done

- Phase 0 spike resolves (either Holepunch ships or we fall back to git-as-sync).
- Phase 1 ships the 4-entry-point create-harness UI (new dir / GitHub URL / existing repo / harness link).
- Phase 4 ships papercup as a `state: private` harness, with single-engineer dogfood verified end-to-end (feature filed → agent worked → PR opened → reviewed → merged → status flipped to `shipped`).
- Phase 5+ ships the multi-engineer collaboration layer (user branches, Hyperbee sync, orchestrator-claim arbitration, PR lifecycle, trust UI, Cupboard, Discord).
- All 80 P-NNN items resolve (built or explicitly deferred to a follow-up plan).

## Decide-first gate

These three decisions reshape the plan and must be confirmed before Phase 0 starts:

- **Q-7/Q-8 (from v2)**: Are the 4 papercup repos staying separate (current), collapsing to a monorepo, or becoming an umbrella superproject? **Locked to: staying separate.** Per user direction 2026-05-23.
- **Workspace name for the dogfood**: `papercusp-workspace`. Per user direction 2026-05-23.
- **Hybrid sync model** (HYPERBEE for live state, GIT for documents): **locked.** v3 + v4.


## Design

### §0 — The collaboration model

**Identity is per-human.** The root identifier is `github_user_id` (BIGINT, GitHub's stable numeric user ID, never recycled across renames or account migrations). Display name is `github_username`, refreshed on poll. Avatar is fetched from `https://avatars.githubusercontent.com/u/<id>` (deterministic identicon fallback for accounts without an avatar).

**Devices bind to humans via GitHub-Gist-as-attestation** (D-001):
1. On first use, device generates an Ed25519 keypair (`device_pubkey`).
2. User completes GitHub OAuth on that device (using `@octokit/auth-oauth-device` or web flow).
3. Device uses the OAuth token to create a **public gist** in the user's GitHub account, named `papercusp-device-binding-<pubkey-prefix>.json`, containing:
   ```json
   {
     "github_user_id": 12345,
     "github_username": "alice",
     "device_pubkey": "ed25519-...",
     "device_label": "macbook-pro",
     "created_at": "2026-05-23T...",
     "signature_by_device": "<sig over the rest of this object>"
   }
   ```
4. Device emits a Hyperbee binding row referencing the gist URL.
5. Peers verify by `GET /gists/<gist_id>` — confirms the gist is owned by the claimed `github_user_id` and contains the claimed `device_pubkey`. Cache the verified binding for ~24h; re-verify in background.
6. Revocation = delete the gist. Peers detect the 404 on next re-verification and reject the device's signatures going forward.

**Auto-trust across devices.** Trust is keyed by `trusted_github_user_id`. New devices added by a trusted human are auto-trusted, with no re-trust gesture required. The OAuth + gist combination guarantees only the actual GitHub-account holder can bind a new device.

**Contributors are first-class.** Anyone who joins a shared harness (via link or via Cupboard) becomes a contributor. No two-tier "member vs contributor" distinction — the act of joining via Papercusp signals intent to build. The Contributors tab in the sidebar lists everyone.

**Features stay PG-canonical, NOT in git.** Features are HYPERBEE-synced PG rows (`harness_features_consolidated` carries `created_by_pubkey`, `working_users[]`, `completion_ref`, etc.). The git history holds *code*, not feature metadata. Feature audit lives in the append-only Hyperbee.

**User-branch model.** Each contributor to a shared harness has:
- A long-lived branch `user/<github_user_id>` on the GitHub remote (e.g. `user/12345`).
- A local worktree at `papercup/user-12345/` containing that branch.
- One physical worktree per harness — main is accessed via a virtual "diff against main" view in the UI, plus a manual `git worktree add` on demand if the user wants to physically `cd` into main.

When the user works on a feature, their agents run in the user-branch worktree. Code lives on `user/12345`. Features in PG carry pointer fields (queue, working, current PR) but no code.

**Feature lifecycle** (D-007):
- `proposed` — filed by anyone, not yet picked up.
- `in_queue` — pulled into a user's queue (one row per `(github_user_id, feature_id)` in `feature_queue` HYPERBEE table). Multiple users can have the same feature in their queue simultaneously.
- `working` — orchestrator claimed it (via §0.6 arbitration) OR user manually flipped to working. `working_users[]` records who; `working_users[0]` is the derived `current_worker`. Today's flow keeps `working_users` size 1; the schema supports future multi-user.
- `pending_done` — agent finished, PR opened, awaiting review/merge.
- `shipped` — PR merged. Feature row's `completion_ref` carries `{remote, branch, commit_sha, pr_url}` verified against `git ls-remote`.

**Orchestrator claim arbitration** (D-002): the §0.6 distributed-claim flow.

### §0.6 — Orchestrator claim arbitration (deterministic merge-order)

Two peers can independently decide to work on the same feature. Naive "read working_users empty → write a claim" loses to a race. Hyperbee + Autobase give us a deterministic merge order; we use that.

**Flow:**
1. Orchestrator on peer A reads PG: feature F-042 has `working_users = []`, status `in_queue`.
2. A appends a *claim record* to the harness Autobase: `{kind: 'feature_claim', feature_id: 'F-042', claimer_pubkey: A_pub, claimer_github_user_id: 12345, ts: ...}`.
3. A **awaits its own append being merged into the local Autobase view** (typically 50–200ms on a healthy mesh). This is not a fixed sleep; it's a confirmation that A's writer log is now part of A's merged view.
4. A reads the merged view and finds *all* claims for `F-042` so far. The Autobase orders them deterministically by `(writer_pubkey, seq)`.
5. If A's claim is the **first** in the merged order for F-042: A wins. Update PG `working_users = [A_pub]`, fire the agent.
6. If A's claim is NOT first (a peer's claim landed earlier in the merge): A loses. Mark the claim as superseded locally, pick a different feature, retry.

**Why this is correct:**
- Autobase's merge order is deterministic — every peer eventually agrees on the same ordering.
- No peer fires an agent before its own claim is merged, so no double-work can begin.
- Latency floor = Autobase merge convergence (50–200ms typical), which is the physical lower bound on any P2P consensus anyway.
- Losing peers waste at most one claim record (cheap) — no agent cycles burned.

**Manual override** (per user direction): a user can manually flip a feature to `working` in their own queue. This bypasses the orchestrator's auto-pickup but still emits a claim record. If two users manually claim the same feature within the merge window, the same deterministic arbitration applies; the loser sees the feature flip back to `in_queue` in the UI.

### §1 — Workspace / harness / user-branch model

**Workspace** = personal local context. One per machine. Stored at `~/.papercusp-workspaces/<id>/`. Holds:
- Embedded PG socket + data dir
- Personal config, OAuth tokens, device keypair
- Trust list (LOCAL, never synced)
- Per-engineer telemetry, run history

**Harness** = a project. Lives at a git repo path the user pointed Papercusp at. Identified by `slug`. Three states:
- `private` — single-engineer. No Hyperbee sync. No user-branch. Works like Papercusp today.
- `shared-private` — multi-engineer, invite-link-gated. Hyperbee sync. User-branch model.
- `shared-public` — multi-engineer, discoverable via Cupboard. Same mechanics as shared-private, plus a Cupboard registry entry.

**User branch** (shared harnesses only): `user/<github_user_id>` (e.g. `user/12345`). Created on join. Pushed to the same GitHub remote as `main`. Long-lived; survives PRs (they merge from `user/12345` to `main`, leaving the branch in place for next features). One worktree per harness per machine.

**Sub-harness** (submodule): if the harness root has `.gitmodules`, each submodule becomes a sub-harness node sharing the root's queue. The walk follows the **five-rule classifier** in §2.

### §2 — Five-rule classifier for nested `.git` directories

When walking a repo tree for sub-harness discovery:

1. **`.git` file pointing to `<parent>/.git/modules/<name>`** → submodule. Register as sub-harness node sharing root's queue. Tagged with component path (`libs/sync`).
2. **`.git` file pointing to `<parent>/.git/worktrees/<name>`** → worktree of the same repo. NOT a new harness. Skip.
3. **`.git` directory (not a file)** → standalone repo. Register as a separate top-level harness.
4. **Directory with no `.git` at all** → just a code directory, part of the parent repo. Skip.
5. **Path-qualified slugs**: sub-harness slugs are `papercup/libs/sync`, not just `sync` — disambiguates across the workspace.

### §3 — Create-harness UI (4 entry points)

Backend route `POST /api/harness/projects` exists today and handles Entry 3 only. Entries 1, 2, 4 need new backend work.

**Entry 1 — New local directory (non-git).** User picks a folder name + parent dir. Operator creates the directory, runs `git init`, scaffolds harness, registers in PG. State defaults to `private`.

**Entry 2 — GitHub URL.** User pastes a GitHub HTTPS URL. Operator validates auth (GitHub OAuth required), clones via `isomorphic-git` with the OAuth token as auth, scaffolds harness, walks `.gitmodules` per §2. State defaults to `private`. The user can later convert to shared via §5 wizard.

**Entry 3 — Existing local git repo.** User picks a path. Operator validates (path exists, is a git repo), scaffolds harness, walks `.gitmodules`. State defaults to `private`.

**Entry 4 — Harness link (shared-only).** User pastes a Papercusp-issued harness link (`papercusp://harness?topic=<32-byte-hex>&github=<owner>/<repo>`). Operator:
1. Joins the Hyperswarm topic, replicates the harness's Hyperbee.
2. Reads the shared config (GitHub remote, schema version, contributor list).
3. Forces GitHub OAuth.
4. Clones the GitHub remote via `isomorphic-git`.
5. Creates `user/<my_github_user_id>` branch + worktree.
6. Publishes device attestation gist + Hyperbee binding row.
7. Appends self to contributors list.
8. State = same as shared (private or public).


### §4 — Harness states + transitions

- `private` (default for Entries 1, 2, 3) — single-engineer, no Hyperbee, no user-branch.
- `shared-private` — invite-link-gated. Hyperbee sync + user-branch + GitHub-forced.
- `shared-public` — same as shared-private + Cupboard registry entry.

Transitions:
- `private → shared-private` via §5 wizard.
- `shared-private → shared-public` via "publish to Cupboard" action.
- `shared-public → shared-private` via "remove from Cupboard" action.
- **No shared → private downgrade.** Once shared, stays shared (downgrade would orphan other engineers' branches).

### §5 — Share-this-harness wizard

Five-step flow:
1. **Confirm GitHub remote.** `git remote -v` must show an authenticated GitHub remote. If not, prompt to add one (OAuth-gated).
2. **Generate Hyperswarm topic.** 32 random bytes. Becomes the harness's swarm key.
3. **Choose Discord channel** (optional). If user provides a channel link, store in `.harness/config.json` (committed to git).
4. **Choose privacy** (shared-private or shared-public).
5. **Privacy confirm-modal** (D-013):
   - If `shared-private`: "Anyone with this link can join and see all contributors' GitHub usernames + avatars."
   - If `shared-public`: "This harness will be listed in the Cupboard. Your GitHub username, display name, and avatar will be visible to anyone."
6. Seed Hyperbee with current PG state for HYPERBEE-bucket tables. Write `.harness/shared.json` (committed to git) with `{topic, github_remote, discord_channel?, privacy, created_at, schema_version}`.
7. Generate harness link: `papercusp://harness?topic=<hex>&github=<owner>/<repo>`. Display for sharing.

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

**LWW honesty** (D-012): conflicts in HYPERBEE tables resolve last-writer-wins by (timestamp, writer_pubkey) tie-break. This is NOT real CRDT merge. When two peers update the same row's same field, one update silently wins. **The UI surfaces clobbers**: when a peer's recent write loses to a remote write, a "your change was overridden" toast fires with a diff.

**Path B git layer** (D-008 v3): Hyperdrive peer-mirror for code, default OFF per-harness, opt-in via a per-harness toggle. When ON: post-commit hook pushes to a local bare mirror; Hyperdrive replicates the bare mirror to peers; peers fetch from their local mirror. Cuts engineer-to-engineer code latency from ~5s (auto-fetch on Hyperbee status hint) to <1s.


### §7 — Table classification (HYPERBEE / GIT / LOCAL / SECURITY)

Bucketed by **how the table is used**, not by name (legacy `*_shared` names are NOT a classification signal). All `harness_shared.*` and per-harness `{{SCHEMA}}.*` tables surveyed.

#### §7.1 — HYPERBEE bucket (7 tables, ~live state)

These propagate via Hyperbee CRDT (Autobase log → Hyperbee KV → per-peer projection back into PG):

| Table | Schema | Why HYPERBEE | Key shape in Hyperbee |
|---|---|---|---|
| `harness_features_consolidated` | harness_shared | Queue, status, working state change sub-second; the live collaboration surface | `features/by-id/<feature_id>` + `features/by-status/<status>/<id>` (secondary index) |
| `feature_queue` | NEW (harness_shared) | Pointer table; `(github_user_id, feature_id)` rows; queue membership is live | `queue/<github_user_id>/<feature_id>` |
| `contributors` | NEW (harness_shared) | Membership + device attestations; lookups frequent + identity is core | `contributors/<github_user_id>` |
| `coord_presence` | harness_shared | Who is in the harness UI right now; degrades cleanly if missed | `presence/<github_user_id>/<machine_label>` |
| `feature_claims` | NEW (harness_shared / Autobase log only) | Orchestrator arbitration; not projected to PG, lives only in Autobase | `claims/<feature_id>/<seq>` (append-only) |
| `harness_feature_prs` | harness_shared | Shared PR metadata: URL, head SHA, base SHA, status summary. Live updates from poll | `prs/<feature_id>` |
| `harness_issues_consolidated` | harness_shared | Issue queue; mirrors feature queue mechanics. **v4 scope**: keep the shared row, do NOT add `working_users` / `current_worker` / `completion_ref` yet (deferred to issue-collaboration design) | `issues/<issue_id>` |

**Schema additions to existing tables** (HYPERBEE-bucket):
- `harness_features_consolidated`:
  - `created_by_github_user_id BIGINT` — author identity
  - `working_users BIGINT[]` — array of github_user_ids currently working
  - `completion_ref JSONB` — `{remote, branch, commit_sha, pr_url}` populated when status → `pending_done` or `shipped`
  - `worked_by_history JSONB[]` — append-only audit of who worked on it
  - `current_worker` is **derived** as `working_users[0]`; NOT stored
- `harness_issues_consolidated`: no schema additions in v4 (deferred per blocker-4 fix).
- `harness_feature_prs`: extend with `last_polled_at`, `checks_status` (summary), `mergeable_state`, `review_decision`, `reviewers[]`.

#### §7.2 — GIT bucket (~20 tables, file-per-row in `.harness/state/`)

Document-shaped, slow-changing, benefit from git history + human-diffable PRs. Each table maps to a directory under `.harness/state/<table>/`; each row is a JSON or markdown file keyed by id. Mutations commit-debounced at 15s (§6.2).

| Table | Schema | Storage |
|---|---|---|
| `harness_decisions` | harness_shared | `.harness/state/decisions/<id>.md` (front matter + body, vditor-edited) |
| `harness_summaries` | harness_shared | `.harness/state/summaries/<id>.md` |
| `harness_escalations` | harness_shared | `.harness/state/escalations/<id>.md` |
| `harness_design_artifacts` | harness_shared | `.harness/state/design/<id>.md` |
| `harness_text_artifacts` | harness_shared | `.harness/state/text-artifacts/<id>.md` |
| `harness_chunk_plans` | harness_shared | `.harness/state/chunk-plans/<feature_id>/<chunk_id>.json` |
| `harness_feature_notes` | harness_shared | `.harness/state/feature-notes/<feature_id>/<note_id>.md` |
| `feature_audit_consolidated` | harness_shared | `.harness/state/feature-audit/<feature_id>.jsonl` (append-only log) |
| `harness_tests` | harness_shared | `.harness/state/tests/<id>.md` |
| `llm_test_fixtures` | harness_shared | `.harness/state/llm-test-fixtures/<id>.json` |
| `llm_test_claims` | harness_shared | `.harness/state/llm-test-claims/<id>.json` |
| `llm_test_findings` | harness_shared | `.harness/state/llm-test-findings/<id>.json` |
| `harness_phases` | harness_shared | `.harness/state/phases.json` (legacy; only present in `private` harnesses) |
| `harness_promotions` | harness_shared | `.harness/state/promotions/<id>.json` (legacy) |
| `harness_lanes` | harness_shared | `.harness/state/lanes.json` |
| `harness_checkpoints` | harness_shared | `.harness/state/checkpoints/<id>.json` |
| `harness_branch_actions` | harness_shared | `.harness/state/branch-actions/<id>.json` |
| `harness_snapshots` | harness_shared | `.harness/state/snapshots/<id>.json` (metadata only; tarball content stays LOCAL) |
| `harness_experts` | harness_shared | `.harness/state/experts/<id>.md` |
| `harness_skills` | harness_shared | `.harness/state/skills/<id>.md` |
| `goals` | harness_shared | `.harness/state/goals/<id>.md` |
| `papercup_shared.messages` | papercup_shared | `.harness/state/cross-agent-messages/<id>.json` |
| `papercup_shared.directives` | papercup_shared | `.harness/state/directives/<id>.json` |
| `papercup_shared.briefings` | papercup_shared | `.harness/state/briefings/<id>.json` |
| `{{SCHEMA}}.messages` | per-harness | `.harness/state/agent-messages/<id>.json` |
| `{{SCHEMA}}.supervisor_notes` | per-harness | `.harness/state/supervisor-notes/<id>.md` |
| `{{SCHEMA}}.directive_summaries` | per-harness | `.harness/state/directive-summaries/<id>.md` |
| `harness_proposals_shared` | harness_shared | `.harness/state/proposals/<id>.md` (if still used; verify at implementation) |
| `snapshot_features` | harness_shared | `.harness/state/snapshot-features/<id>.json` |
| `project_spec_revisions` | harness_shared | Rebuilt from `SPEC.md` git history; not duplicated as files |

**Projection direction**: GIT is the canonical store. On startup, the operator scans `.harness/state/` and rebuilds the PG rows (replacing them). Mutations in PG fire write hooks that serialize → write file → debounce commit. Conflicts surface as git merge conflicts (visible, human-resolvable) — much better than silent LWW.

#### §7.3 — Backfill from PG (one-time, at share-time)

When a user converts a private harness to shared via §5 wizard:
- For each GIT-bucket table, serialize current PG rows → write files under `.harness/state/<table>/` → commit as `chore(harness): seed shared state from local PG`.
- For each HYPERBEE-bucket table, serialize current PG rows → append as Autobase log records under the bootstrap epoch.
- After backfill, write hooks on PG tables become active; further mutations flow through the appropriate transport.

#### §7.4 — LOCAL bucket (~120 tables, per-engineer operational state)

These stay in each engineer's PG, NEVER cross machines. Operational, telemetry, runtime, personal config, UI state, plugin state, mobile, backups, voice. Includes ALL `plan_*` tables per user decision (v3 D-003 carries over):

| Category | Tables |
|---|---|
| Plans | `plan_revisions`, `plan_runs`, `plan_run_turns`, `harness_plan_review`, `harness_brainstorm` |
| Runtime | All `*_run`, `*_runs`, `*_telemetry`, `*_session`, `*_invocations`, `tool_invocations` |
| Spawns | `harness_shared.spawns`, `spawn_signatures`, `spawn_sig_verification_failures` |
| Agent runtime | `agent_chats`, `agent_chat_*`, `agent_messages`, `agent_runs`, `agent_state` |
| Logs | `toast_log`, `console_log`, `audit_log`, `error_log` |
| Operator | `operator_*` (preferences, drafts, settings, UI state) |
| Plugin state | All `plugin_*` except those flagged HYPERBEE conditional below |
| Backups | All `kopia_*` |
| Mobile | All `mobile_*` |
| Voice | All `voice_*` (sessions, transcripts, credentials gated SECURITY) |
| Embedded PG | `embedded_pg_*` |
| Search | `search_cache`, `search_results` |
| LLM caches | `llm_completion_cache`, `llm_embedding_cache` |
| Memory | `mem0_*` (per-engineer agent memory) |
| Project history | `project_spec_revisions` (rebuildable from git, not duplicated) |
| **PR check status detail cache** | NEW `pr_check_status_cache` — per-engineer cache of GitHub check-run details fetched on click |

#### §7.5 — SECURITY bucket (~22 tables, NEVER cross machines under any circumstance)

| Category | Tables |
|---|---|
| Auth | All `papercusp_auth.*`, `users`, `user_sessions`, `user_preferences` |
| Audit | `auth_audit_log`, `auth_rate_limit`, `cooldown_marks` |
| Tokens | `oauth_nonces`, `token_index`, `system_principals`, `jti_used` |
| Sessions | `power_user_sessions`, `pi_sessions`, `mobile_pair_tokens` |
| Credentials | All `operator_*credentials*`, `secrets`, `marketplace_token`, `publish_credentials`, `voice_credentials`, `search_provider_credentials`, `trust_store` |
| Local trust | `trusted_authors` (per-engineer trust list, keyed by `trusted_github_user_id`, LOCAL by design) |
| PR reviewer settings | `pr_reviewer_settings` keyed by `(harness_slug, github_user_id)` — per-reviewer auto_review + auto_merge toggles |
| Plugin grants | `plugin_capability_grants` |

#### §7.6 — HYPERBEE conditional (~9 tables, only if feature used)

If a harness has org-overlay enabled OR uses specific plugins:

| Table | Bucket if active |
|---|---|
| `org_features`, `org_decisions`, `org_summaries`, `org_directives`, `org_briefings`, `org_messages`, `org_escalations` | HYPERBEE (rare; most harnesses don't use org-overlay) |
| `plugin_jira_sync.links`, `plugin_linear_sync.links` | HYPERBEE if shared, LOCAL otherwise (plugin opt-in) |
| `plugin_kv` (per plugin) | Plugin-author choice (HYPERBEE or LOCAL via plugin manifest) |

#### §7.7 — Legacy tables (flagged for verification at implementation)

These appeared in earlier surveys but may not match current schema:
- `{{SCHEMA}}.harness_proposals` — proposals hero bar was removed earlier; verify table still in use before classifying
- `harness_pending_issues` — LOCAL inbox vs HYPERBEE team triage (needs use-case confirmation)
- Plain `harness_features` (legacy path) vs `harness_features_consolidated` — implementing agent must diff §7 against live `001-shared.sql` and reconcile

#### §7.8 — `pr_reviewer_settings` schema

```sql
pr_reviewer_settings (
  harness_slug TEXT NOT NULL,
  github_user_id BIGINT NOT NULL,
  auto_review BOOLEAN NOT NULL DEFAULT FALSE,
  auto_merge BOOLEAN NOT NULL DEFAULT FALSE,
  pr_reviewer_role_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (harness_slug, github_user_id)
)
-- LOCAL only; per-engineer config. Identity = github_user_id for consistency with the rest of v4.
```


### §8 — PR lifecycle

#### §8.1 — Open PR from agent

When an agent in a worker run finishes:
1. Agent commits to `user/<github_user_id>` branch in its worktree.
2. Auto-rebase-on-push (§16) runs: `git fetch origin main && git rebase origin/main`. On conflict, escalate (§16.2).
3. On clean rebase, push to `user/<github_user_id>` on the GitHub remote.
4. Open a PR via Octokit: `POST /repos/{owner}/{repo}/pulls` with `head: user/<github_user_id>`, `base: main`, title from feature, body referencing `closes F-<id>`.
5. Feature status flips to `pending_done`. `completion_ref` JSONB populated with `{remote, branch: user/<id>, commit_sha: HEAD, pr_url: <returned-url>}`.
6. HYPERBEE-sync the feature row + `harness_feature_prs` row (new).

#### §8.2 — Trust-list-gated auto-approve

Per-reviewer: if `pr_reviewer_role_enabled` AND `auto_review` are both true AND the PR's author `github_user_id` is in `trusted_authors` for this harness:
1. Octokit fetches the PR.
2. If status checks are all green (poll-cached, §8.4), reviewer's operator posts a `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with `event: APPROVE`.
3. Audit row written to LOCAL `auto_review_audit` table.

Untrusted PRs sit in the manual-review queue (visible in §9.4 PR tab).

#### §8.3 — Auto-merge (separate opt-in)

Independent toggle `auto_merge` (default FALSE). If both `auto_review` and `auto_merge` are true AND the PR is approved AND status checks are green:
1. Octokit `PUT /repos/{owner}/{repo}/pulls/{number}/merge` with `merge_method: 'squash'` (configurable per harness; default squash).
2. On merge: feature status flips to `shipped`; `completion_ref` updated with merge commit SHA.
3. The `user/<github_user_id>` branch is **not deleted** — it stays as the user's workspace for next features.

**Three coherent reviewer postures:**
- **Hands-off**: `auto_review=true, auto_merge=true` — full automation, requires trust list discipline.
- **Cautious**: `auto_review=true, auto_merge=false` — auto-approve to save the click, human merges deliberately. The default for trusted-team setups.
- **Manual**: both false — every PR human-reviewed. Default for new reviewers.

**Consequence modal at trust-add** (D-013 v3, refined): when adding to trust list AND `auto_review=true`, modal: "Future PRs from this contributor will be auto-approved by you while your auto-review is on. Continue?" When also `auto_merge=true`: "...and will be auto-merged when checks pass."

#### §8.4 — PR live-state polling

**One bulk request per harness per 60s** when ≥1 PR is open; idle (no requests) otherwise.

```
GET /repos/{owner}/{repo}/pulls?state=open&per_page=100
```

Returns up to 100 open PRs in one call. Extract per-PR:
- `head.sha`, `base.sha`, `merged`, `mergeable`, `mergeable_state`
- `requested_reviewers[]`, `assignees[]`
- Status checks summary requires a follow-up `GET /repos/{owner}/{repo}/commits/{head.sha}/status` (combined status API) OR `GET /repos/{owner}/{repo}/commits/{head.sha}/check-runs` (checks API) — pick checks API as primary for modern Actions support.

Cache:
- HYPERBEE `harness_feature_prs.checks_status` (summary only) — shared across peers.
- LOCAL `pr_check_status_cache` — per-engineer cache of individual check-run details, populated on user click into a check.

**Rate budget**: 5000 req/hr authenticated. 60s × (1 PR-list req + N check-runs reqs per harness) per N harnesses comfortably fits — order of magnitude headroom.

**Webhook**: out of scope for v1. Phase 12+ optimization once Cloudflare-tunnel ingress is normalized for arbitrary harnesses.

#### §8.5 — PR review surface = GitHub UI itself (D-013 v3 stands)

Don't build a PR review UI in Papercusp. The PR tab (§9.4) lists open PRs and links out to GitHub for actual review. Reviewer's local operator polls + executes auto-approve / auto-merge actions via Octokit when configured.

#### §8.6 — Manual review path

For untrusted authors, the PR sits in the manual queue. A reviewer with `pr_reviewer_role_enabled=true`:
1. Clicks the PR in the §9.4 tab.
2. Opens GitHub PR page in a new browser tab.
3. Reviews on GitHub.
4. Returns to Papercusp. PR tab shows "approved" / "changes-requested" via poll within 60s.
5. If reviewer trusts the author after this review, they add the author to their trust list via the §9.3 Contributors tab (consequence modal per §8.3).

### §9 — Sidebar tabs

The harness sidebar gains three new tabs (in addition to existing tabs):

#### §9.1 — Features tab

Lists ALL features in the harness (HYPERBEE-synced). Each row shows:
- Feature ID + title
- Status pill (`backlog` / `in_queue` / `working` / `pending_done` / `shipped`)
- Author avatar (from `created_by_github_user_id`)
- Queue avatars: small stack of avatars of users with this feature in their queue
- Working avatar: highlighted icon of `working_users[0]` (the current worker)
- "Pull into my queue" button — adds to `feature_queue` row keyed by `(my_github_user_id, feature_id)`
- "Remove from my queue" if already queued

Filter chips: `mine` (my queue), `working` (someone working), `available` (in_queue, nobody working), `shipped`.

Click a feature → opens detail panel with description (vditor-rendered markdown), notes, audit log, current PR (if `pending_done`).

#### §9.2 — Contributors tab

Lists all contributors to this harness (HYPERBEE-synced `contributors` table):
- Avatar (GitHub avatar by `github_user_id` or identicon fallback)
- Display name + `@github_username` (resolved at display-time; rename-resilient)
- Joined date
- Activity badges: features authored, features worked, PRs merged
- Per-contributor menu (only visible if I have `pr_reviewer_role_enabled`):
  - "Add to my trust list" / "Remove from my trust list" (with consequence modal per §8.3)
- Devices section: collapsed by default; expand to see each `device_pubkey` + machine label + attestation gist URL (link out to gist for verification)

#### §9.3 — PRs tab

Lists open PRs in the GitHub remote (poll-cached per §8.4). Each row:
- PR number + title
- Author avatar
- Status: checks (green/red/pending), reviews (approved/changes-requested/pending)
- Trust badge: ✓ if author is in my trust list
- Action buttons (only if `pr_reviewer_role_enabled`):
  - "Open on GitHub" (always)
  - "Approve" (manual; Octokit call)
  - "Approve + merge" (manual; Octokit calls)
  - "Auto-review on/off" indicator (read-only summary of my settings)

Filter chips: `mine` (PRs I authored), `awaiting-me` (requested-reviewer is me), `awaiting-review` (no approvals), `approved` (approved but not merged), `merged` (recently).

#### §9.4 — PR-reviewer settings (gear icon in PRs tab)

Per-harness settings modal:
- `pr_reviewer_role_enabled` (bool)
- `auto_review` (bool, only enabled if role is enabled)
- `auto_merge` (bool, only enabled if auto_review is on)
- `merge_method` (squash/merge/rebase; default squash)
- Trust list view: who's trusted; remove inline
- Audit log: recent auto-review and auto-merge actions

### §10 — Cupboard registry (public harnesses)

A new top-level navbar item `Cupboard`, sibling to existing nav.

**Listing source**: Cupboard server (`cupboard.papercusp.dev` or self-hosted). Same shape as the existing Marketplace listing service (P-053 in §17 phases). One row per `shared-public` harness with: title, description, contributor count, last-activity ts, language, tags, harness link.

**Publishing**: when a user converts a `shared-private` harness to `shared-public`, the wizard:
1. Validates GitHub repo is public (else block — can't publish a private GitHub repo as a public Papercusp harness).
2. Posts metadata to Cupboard server: `POST /harnesses` with `{slug, title, description, harness_link, github_url, tags, ...}`.
3. Sets `state: shared-public` locally.

**Joining**: clicking a Cupboard listing → "Install this harness" → runs Entry 4 flow with the harness link.

**Unlisting**: "Remove from Cupboard" action → DELETE on the Cupboard server → state reverts to `shared-private`.

**UI**: same component family as the Marketplace pages. Card grid with avatars/tags/description; filter + search; detail view shows contributors, recent activity, README pull from GitHub repo.

### §11 — Discord integration

**Per-harness Discord channel pointer** stored in `.harness/config.json` (committed to git, so team gets it via clone):

```json
{
  "discord_channel_url": "https://discord.com/channels/123456/789012",
  "discord_webhook_url": null
}
```

**Switch-to-harness behavior**: when user activates a harness with `discord_channel_url` set, fire `discord://discord.com/channels/123456/789012` URI scheme. Discord desktop intercepts and focuses the channel. **Opt-in**: a per-user setting `auto_focus_discord_on_harness_switch` (default false) — otherwise it's a manual "Open Discord channel" button in the harness sidebar.

**Discord-in-browser fallback**: if Discord URI scheme doesn't fire (no Discord desktop installed), fallback to `https://discord.com/channels/...` in a new browser tab.

**Optional outbound webhook**: if `discord_webhook_url` is set, the operator posts harness events:
- New shared-feature filed
- PR opened / merged
- Escalation

Implementation: reuse the existing operator notification surface (D-022 v3 — verify which existing surface in P-051) rather than building new HTTP-poster infrastructure.

**No bot, no auto-create channel** (D-014 v3 stands). Channel and webhook are external Discord-side configuration.


### §12 — P2P transport (Hyperswarm + Hyperbee + Autobase)

**Packages** (`@holepunchto/*`, all real npm modules; D-015 v3 — primitives, not Pear):
- `hyperswarm` — DHT-based peer discovery + connection via UDP holepunching
- `corestore` — manages local Hypercore storage
- `hypercore` — append-only signed log per writer
- `autobase` — multi-writer append-only log merged into a single linearized view
- `hyperbee` — P2P B-tree (sorted KV) over Hypercore (or Autobase)
- `hyperdht` — the DHT itself (transitively required)
- `b4a` — Buffer-compatible byte arrays for cross-runtime

**Per-harness swarm**:
- 32-byte topic key generated at share-time (§5 wizard).
- On join, peer connects to Hyperswarm with the topic → discovers other peers → exchanges Hypercore writer keys.
- Each contributor's device has its own Hypercore writer (one writer per `device_pubkey`).
- All writers feed into a per-harness Autobase; the Autobase merged view is then projected into a Hyperbee for KV reads.

**Per-table Hyperbee namespacing**:
- One Hyperbee per harness; tables namespaced by key prefix: `features/`, `contributors/`, `queue/`, `presence/`, `prs/`, `issues/`, `claims/`.
- Secondary indexes maintained as additional key prefixes: `features/by-status/<status>/<id>`. Rebuilt on view-change events.

**Write path**:
1. PG row mutated locally via operator write.
2. Write hook serializes the row into a KV update op.
3. Op appended to peer's local Hypercore writer log.
4. Autobase merges into the view; Hyperbee KV updated.
5. Hyperswarm replicates the Hypercore to peers; each peer's Autobase converges; each peer's projection process writes back to local PG.

**Read path**:
1. UI/operator reads from local PG (already-projected state).
2. `useSyncQuery` (§13) listens for invalidations triggered by PG-side `pg_notify` from the projection process.

**Why not Yjs / Automerge for the data layer**: Yjs is text-CRDT-shaped (great for `vditor` rich-text use; not great for tabular rows). Automerge is doc-CRDT-shaped (could work but adds a second CRDT stack alongside Autobase/Hyperbee, doubling primitive surface). Hyperbee gives sorted-KV semantics that map cleanly to row-shaped data, and Autobase gives multi-writer semantics. Single primitive set wins.

**Why not Pear runtime** (D-015 v3): Pear replaces Tauri end-to-end — a months-long port for a different distribution model. Not v1.

**Phase 0 spike gates this**: validate `@holepunchto/*` packages bundle into Tauri/Node desktop build (native deps: UDX, sodium-native), validate Autobase stability under expected churn (3-5 active writers per harness, sleeping laptops returning days later). If spike fails: fallback is "HYPERBEE bucket collapses into GIT bucket" — same harness model, slower live state (commit-debounced 15s instead of <1s).

### §13 — Reactivity architecture

Three tiers, mostly already shipped (§13 mostly documents what exists + names the gaps):

**Tier 1 — UI invalidation (`libs/sync`)**:
- `SyncProvider` (existing) wraps the app; manages SSE connection.
- `useSyncQuery` (existing) wraps TanStack Query; auto-invalidates on SSE messages matching query keys.
- `SSEAdapter` (existing) parses SSE invalidation messages.

**Tier 2 — Producer (the gap to close)**:
- PG-side `emit_change_notify` trigger function (NEW). Attached to every "reactive" table (initially: all HYPERBEE-bucket tables + a curated subset of GIT-bucket tables for slow-changing surfaces).
- Trigger fires `pg_notify('papercusp_changes', json_build_object('table', TG_TABLE_NAME, 'op', TG_OP, 'pk', new.id, 'workspace_id', current_setting('papercusp.workspace_id')))`.
- One SSE endpoint at `/api/sync/stream` does `LISTEN papercusp_changes` per workspace + multiplexes to all subscribed client sessions.
- `workspace-listener.ts` pattern (existing for lock notifications via `ch_coord_<wsId>`) is the template.

**Tier 3 — Polling fallback**:
- `useSyncQuery` falls back to polling at TanStack Query's default `staleTime` if SSE disconnects.
- Some surfaces (PR live state via GitHub poll, §8.4) inherently poll; the SSE invalidation kicks in when the poll-result causes a PG row update.

**v4 migration tasks**:
- Wire `emit_change_notify` triggers to HYPERBEE tables + the GIT-bucket tables that benefit from sub-15s reactivity (e.g. presence, queue).
- Migrate `apps/operator/app/admin/plans/*` from `useAsyncJson` + 30s polling → `useSyncQuery` (inconsistency I introduced in plan-agent-launch arc; called out in v3, fixing in v4).
- Remove residual Zero WS adapter wiring + `@rocicorp/zero` dep (Zero retired per memory `project_sync_transports`).

### §14 — Path B (Hyperdrive git peer-mirror)

**Default OFF** per harness; opt-in via per-harness toggle in the harness settings (§5 wizard can offer it at share-time).

**Mechanics**:
1. Per-peer bare-mirror repo at `~/.papercusp/peer-mirrors/<harness-slug>.git` (a normal bare git repo; never `gc`'d).
2. Git `post-commit` hook in each user's worktree: `git push --quiet file://~/.papercusp/peer-mirrors/<harness-slug>.git HEAD`. ~50ms locally.
3. Hyperdrive watches `~/.papercusp/peer-mirrors/<harness-slug>.git/` (one Hyperdrive per harness peer-mirror).
4. Hyperdrive replicates the bare-mirror dir to peers over the same Hyperswarm topic (§12).
5. Peer's operator receives the Hyperdrive update event → `git fetch <peer-mirror>` locally (file URL, no network).
6. Peer's main repo gains the new commit. Optional: surface "Bob has new commits on F-042" notification in §9.1 Features tab.

**Visibility implication** (D-013 v3): when enabled, commits propagate to peers immediately — before push to GitHub. Means uncommitted work stays private (good); committed-but-unpushed work is peer-visible (a workflow change worth surfacing).

**Mitigations**:
- Default OFF per harness (D-014 v3).
- On enable, modal: "Once enabled, every commit on your `user/<id>` branch will be visible to other contributors before you push to GitHub. Wip commits should use the `wip/` branch prefix to stay local." (Configurable per-harness branch-pattern filter.)
- Per-harness branch-pattern filter: `^(user/|feature/|fix/|chore/|docs/|refactor/|test/)` by default; user can edit.
- `wip/*` branches are NEVER mirrored.
- "Privacy purge" tool: if a secret slipped in, the operator offers a guided `git filter-repo` + Hyperdrive cache wipe across peers (best-effort; clearly noted that nothing is fully reclaimable post-replication).

**Fallback when peer offline**: `git fetch origin` from GitHub as the canonical remote. Mirror is an optimization, not a replacement.

### §15 — `completion_ref` + trust model

#### §15.1 — `completion_ref` schema

Added to `harness_features_consolidated` (§7.1):

```sql
completion_ref JSONB
-- shape: {remote: "github.com/owner/repo", branch: "user/12345", commit_sha: "abc...", pr_url: "...", pr_number: 42}
```

#### §15.2 — Status verification

When a feature transitions to `pending_done`:
1. Operator captures `{remote, branch, commit_sha, pr_url}` from the PR-open response (§8.1).
2. Stored in `completion_ref`.
3. Background verifier (every 5min when a feature is in `pending_done`): `git ls-remote origin <branch>` — confirms commit exists at remote. If divergence (force-push, branch deleted), surface in §9.1 as a warning.

When a feature transitions to `shipped`:
1. PR-merge event (via §8.4 poll OR auto-merge action) updates `completion_ref.commit_sha` to merge commit, sets `merged_at`.
2. No further verification needed; `shipped` is a terminal state.

**Cached, NEVER on-read**: `git ls-remote` is rate-limited and slow. Reads always serve from the cached `completion_ref` + the latest verification timestamp.

#### §15.3 — Trust model

```sql
trusted_authors (
  harness_slug TEXT,
  trusted_github_user_id BIGINT,
  trusted_at TIMESTAMPTZ,
  trusted_by_github_user_id BIGINT,
  PRIMARY KEY (harness_slug, trusted_github_user_id)
)
-- LOCAL only; NEVER synced. Your trust list is yours.
```

- Trust keyed by `trusted_github_user_id` (the human, not the device).
- Trust persists across the trusted user's device additions (auto-trusted) per §0.4.
- Trust persists across the trusted user's GitHub renames (the id never changes).
- "Add to trust list" gesture requires `pr_reviewer_role_enabled` (§9.2 / §9.4).
- "No trust anyone" rule (D-014 v3): no UI affordance to bulk-trust or auto-trust new contributors. Every trust gesture is per-user deliberate.

### §16 — Sync-with-main UI

Three small surfaces (per user choice in this session):

#### §16.1 — Status indicator

In the harness sidebar header: a badge showing "behind main by N commits" when the user's `user/<id>` branch is behind `origin/main`. Click → opens the sync flow.

Computation: `git rev-list --count user/<id>..origin/main` after each `git fetch origin main` (which runs background-poll every 60s when the harness is active).

#### §16.2 — Manual sync button

In the badge dropdown: "Sync with main" button. On click:
1. `git fetch origin main`
2. `git rebase origin/main` in the user's worktree.
3. On clean rebase: success toast.
4. On conflict: open the operator's conflict-resolution UI (or fall back to "open editor on conflicted files" if the conflict UI isn't built yet).

#### §16.3 — Auto-rebase-on-push (default ON)

Before every agent push (§8.1 step 2):
1. `git fetch origin main`.
2. `git rebase origin/main`.
3. **On clean rebase**: proceed with push.
4. **On conflict** (agent-driven, unattended):
   - Open `harness_escalations` row: `{kind: 'rebase_conflict', feature_id, conflicted_files[], stash_ref}`.
   - Stash the agent's changes to `wip/conflict-F-<id>-<ts>` branch.
   - Reset feature status to `in_queue`, clear `working_users`.
   - Surface in §9.1 as a warning + escalation panel: "F-042 hit a conflict — review and decide."
   - User can: resolve manually, re-queue the feature for the orchestrator (which will re-run with fresh main), or abandon the WIP branch.

Per-harness toggle: `auto_rebase_on_push` (default TRUE). Disable if the team prefers manual conflict handling.


## Scope

**In scope:**
- All 11 phases below, end-to-end.
- Schema additions and trigger wiring per §7 / §13.
- All UI surfaces in §3, §9, §10, §11, §16.
- The PrHost abstraction (GitHub impl in v1).
- Phase 0 spike + named fallback.

**Out of scope:**
- GitLab / Gitea / Bitbucket PrHost implementations (v2+).
- Truly P2P attestation (research project).
- Pear runtime adoption (separate future project).
- Webhook-based PR live state (v1 is poll-only).
- Issue collaboration model (deferred until issue use cases firm up).
- Replacing fumadocs/Starlight surfaces (vditor is for user-authored content only, not docs).
- Cross-harness queue unification across separate-repo harnesses (Q-7: papercup, mobile, rust, desktop stay separate per user decision — no umbrella superproject).
- Mobile UI surfaces for collaboration features (mobile gets read-only views in v1).

## Phases

Sizing legend: **S** = ~1-3 days. **M** = ~1 week. **L** = ~2-3 weeks. **XL** = >3 weeks (split candidate).

### Phase 0 — Spike (gate before all subsequent phases) [M]

- **P-001** [M] Bundle `@holepunchto/*` packages into the Tauri+Node desktop build. Verify native-dep compilation across macOS / Linux / Windows targets.
- **P-002** [S] Hyperswarm DHT join + UDP holepunching smoke test across 2 networks (home + cellular tether). Document any STUN/TURN gaps.
- **P-003** [M] Autobase stability test: 3 writers, 1000 ops each, sleeping-peer simulation (writer offline for hours, reconnects, view re-converges). Measure convergence latency.
- **P-004** [S] Hyperbee KV write/read benchmarks under projected load (~10 ops/sec across all harness tables).
- **P-005** [S] Decision gate: spike pass → proceed; spike fail → trigger named fallback (HYPERBEE bucket collapses into GIT bucket, all phases otherwise unchanged).

### Phase 1 — Workspace + create-harness UI (4 entries) [L]

- **P-006** [S] Create the `papercusp-workspace` (literal name, per user) — sentinel workspace for dogfooding papercup itself. Schema-only; UI binds later.
- **P-007** [S] Implement §2 five-rule classifier as `apps/operator/lib/harness/classify-tree.ts`. Tests for all five cases.
- **P-008** [L] Entry 2 (GitHub URL): add `isomorphic-git` dep. Build `clone-with-oauth` helper. Wire into `POST /api/harness/projects` to accept `{kind: 'github_url', url, oauth_token}`. **Sizing acknowledgment**: this is real work, not just wiring; OAuth lib provides token mgmt, not clone-with-auth.
- **P-009** [L] Entry 4 (harness link): add link-paste flow. Parse `papercusp://harness?topic=<hex>&github=<owner>/<repo>` URL scheme. On accept: GitHub OAuth → clone GitHub repo via P-008's helper → join Hyperswarm topic → bootstrap Hyperbee → seed PG. Also: device attestation (P-011) runs here on first-join.
- **P-010** [M] Entry 1 (new local non-git dir) + Entry 3 (existing local repo): UI shell + backend `{kind: 'local_init'}` and `{kind: 'local_existing'}` handlers. Entry 3 reuses existing `POST /api/harness/projects` path-validation; Entry 1 wraps `mkdir` + `git init` + Entry 3.
- **P-011** [L] Device attestation: `apps/operator/lib/identity/attest.ts`. Octokit + gist creation flow. Verifier helper for inbound bindings. Local cache (~24h TTL). Tests against a real GitHub test account.
- **P-012** [M] Create-harness UI shell: 4-entry picker, per-entry forms, progress UI for clone/init, error handling. Uses vditor for description input.
- **P-013** [S] PG schema: register harness rows in `harness_registry` table with `entry_kind` + `state` columns.

**Decided-first gate** (must be resolved before this phase begins): **Q-7** confirmed by user — 4 repos (papercup, papercusp-desktop, papercup-rust, papercup-rust-mobile) stay separate, no monorepo, no umbrella superproject. §2 sub-harness walk only applies WITHIN each repo (papercup's 9 libs/ submodules); cross-repo grouping is just multi-harness-in-one-workspace.

### Phase 2 — `completion_ref` + status verification [M]

- **P-014** [S] Schema add `completion_ref JSONB` to `harness_features_consolidated`.
- **P-015** [M] Schema additions to `harness_features_consolidated` per §7.1 (`created_by_github_user_id`, `working_users[]`, `worked_by_history`). **Explicitly NOT adding** issue-equivalent columns (per blocker-4 fix; defer until issue-collab is designed).
- **P-016** [M] Background verifier daemon. `git ls-remote` polling. Cache + divergence-warning surfacing.
- **P-017** [S] Surface in PlanDetail / FeatureDetail UI: pull `completion_ref` + verification timestamp; warn on divergence.

### Phase 3 — Reactivity migration (independently shippable) [M]

- **P-018** [S] PG-side `emit_change_notify` trigger function. Migration to add it.
- **P-019** [M] Attach trigger to HYPERBEE-bucket tables + curated GIT-bucket tables. Test invalidation flow end-to-end.
- **P-020** [M] `/api/sync/stream` endpoint with `LISTEN papercusp_changes` + per-workspace multiplex. Reuse `workspace-listener.ts` pattern.
- **P-021** [S] Migrate `apps/operator/app/admin/plans/*` from `useAsyncJson` + polling → `useSyncQuery`. Remove the 30s polling.
- **P-022** [S] Remove residual Zero WS adapter + `@rocicorp/zero` dep.
- **P-023** [S] Documentation: how to add a new reactive table (trigger + bucket assignment + `useSyncQuery` key naming).

### Phase 4 — Single-engineer dogfood (papercup as `state: private`) [M]

**Purpose**: prove the harness creation + PR + completion_ref flow on a real codebase BEFORE adding any sharing/P2P complexity.

- **P-024** [S] Use Entry 3 to register the papercup repo as a harness in the new papercusp-workspace, `state: private`.
- **P-025** [S] Seed initial features into the harness queue. Reuse existing feature-CRUD tools.
- **P-026** [M] Run a feature end-to-end on papercup: orchestrator picks → worker run → PR opened → manual review → merge → `shipped`. Verify `completion_ref` populates correctly and status reaches `shipped`.
- **P-027** [S] Observe: did the existing UI handle dogfood-papercup's scale (175+ tables, 50+ existing features)? Capture any pain points as follow-up items.
- **P-028** [S] Decision gate: if Phase 4 surfaces blocker-level pain, fix before Phase 5; otherwise proceed.

### Phase 5 — Sharing wizard + Hyperbee bootstrap [L]

- **P-029** [M] §5 share-this-harness wizard UI. Five-step flow + privacy confirm-modal.
- **P-030** [L] Hyperbee schema + Autobase setup: per-harness corestore, per-writer Hypercore, Autobase wiring. `apps/operator/lib/sync/hyperbee/*` module.
- **P-031** [L] Write-side projection: PG write hooks for HYPERBEE-bucket tables → serialize → append to Hypercore writer. Read-side projection: Hyperbee → PG row writes + `pg_notify` for §13 invalidation.
- **P-032** [M] `feature_queue` HYPERBEE table + UI in §9.1 Features tab.
- **P-033** [M] `contributors` HYPERBEE table + `user/<github_user_id>` branch creation on join + worktree setup.
- **P-034** [S] §3 Entry 4 link-join flow already built in P-009; extend to call wizard's bootstrap on join completion.
- **P-035** [S] LWW clobber-toast UI: detect remote write that overrode my recent local write → toast with diff link.

### Phase 6 — Orchestrator distributed claim [M]

- **P-036** [M] `feature_claims` Autobase log structure. Append-then-await-merge flow.
- **P-037** [M] Orchestrator integration: on feature pickup, call claim arbitration; on win, proceed; on loss, drop + retry on next feature.
- **P-038** [S] Manual "set active" flow per §0.5: user can flip a queued feature to `working` directly (bypassing orchestrator). Orchestrator respects (won't pick up an actively-flipped feature).
- **P-039** [S] Audit log: every claim attempt + outcome captured in LOCAL `claim_audit` for diagnostics.

### Phase 7 — PR lifecycle [L]

- **P-040** [M] PrHost abstraction interface (`apps/operator/lib/pr-host/index.ts`) + GitHub impl via Octokit. Open PR, get PR, post review, merge, list-open-PRs (bulk per §8.4).
- **P-041** [M] Auto-rebase-on-push (§16.3) integration into worker run's push step. Conflict → escalation flow.
- **P-042** [M] PR poll daemon. 60s cadence per harness when ≥1 PR open. Updates `harness_feature_prs` HYPERBEE + LOCAL `pr_check_status_cache`.
- **P-043** [M] §9.3 PRs tab UI.
- **P-044** [M] Auto-approve flow gated on trust list. `pr_reviewer_settings` + per-PR check + Octokit approve call.
- **P-045** [S] Auto-merge flow gated on auto-merge toggle + auto-approve outcome + checks green.
- **P-046** [S] §8.6 manual review path + trust-add consequence modal.

### Phase 8 — Sidebar tabs + identity UI [L]

- **P-047** [M] §9.1 Features tab UI. Queue/working/shipped filters. Pull-into-queue actions.
- **P-048** [M] §9.2 Contributors tab UI. Avatar rendering (GitHub avatar OR pubkey identicon). Trust-list actions (gated by `pr_reviewer_role_enabled`).
- **P-049** [S] §9.4 PR-reviewer settings modal.
- **P-050** [M] vditor integration for feature description editing, decision drafts, and any markdown surfaces. Wire into FeatureDetail + DecisionDetail UI.

### Phase 9 — Cupboard + Discord + sync-with-main [M]

- **P-051** [M] Cupboard server: minimal listings service (could be a single Next.js route + small PG). Schema for harness listings. `POST/DELETE /harnesses` endpoints.
- **P-052** [M] Cupboard UI: navbar item, card grid (reuse Marketplace component family), filter + search + detail view.
- **P-053** [S] Publish-to-Cupboard action wired into §5 wizard for `shared-public` state.
- **P-054** [S] Discord integration: deep-link on harness switch, opt-in setting, fallback to HTTPS URL, optional outbound webhook poster reusing existing notification surface.
- **P-055** [M] §16 sync-with-main trio: status badge, manual sync button, auto-rebase-on-push (already wired in P-041).

### Phase 10 — Path B Hyperdrive peer-mirror (optional opt-in) [M]

- **P-056** [M] Per-peer bare-mirror repo creation + git `post-commit` hook installer. Per-harness toggle.
- **P-057** [M] Hyperdrive instance per harness peer-mirror. Replicate over the harness Hyperswarm topic.
- **P-058** [S] Auto-`git fetch` on Hyperdrive update event. Surface "Bob has new commits on F-042" notification in §9.1.
- **P-059** [S] Per-harness branch-pattern filter (default `^(user/|feature/|fix/|chore/|docs/|refactor/|test/)`); `wip/*` never mirrored.
- **P-060** [M] Privacy-purge tool: guided `git filter-repo` + Hyperdrive cache wipe (best-effort).

### Phase 11 — Multi-engineer dogfood [L]

- **P-061** [M] Onboard a second engineer (real or simulated via second machine). Run paired feature flow: A files, B picks up via §9.1, B works, B opens PR, A reviews on GitHub, B's auto-merge fires.
- **P-062** [S] Stress test: 3+ engineers, 10+ features in flight simultaneously. Measure HYPERBEE convergence + UI invalidation latency end-to-end.
- **P-063** [M] Capture issues from the multi-engineer dogfood as Phase-12+ follow-up plans.
- **P-064** [S] Documentation: contributor onboarding guide ("how to join a Papercusp harness"). Lives in `apps/operator-docs/`.
- **P-065** [S] Cupboard publish: list the papercup harness on the public Cupboard as the canonical dogfood example.


## Decisions

### D-001 — Identity is per-human (`github_user_id`), devices bind via GitHub-Gist attestation

**Decided.** Trust is keyed by `trusted_github_user_id` (the human). Each device generates an Ed25519 keypair and publishes a binding to a public gist in the user's GitHub account; peers verify the gist exists and contains the claimed `device_pubkey`. New devices for a trusted user are auto-trusted; revocation = delete the gist.

**Why**: spoofing requires GitHub session compromise (which already grants worse capabilities). No centralized attestation server to maintain. GitHub-Gist as the publish target piggy-backs on GitHub's existing uptime. Trust gestures are about humans, not laptops.

**Alternatives rejected**: per-machine pubkey trust (high friction across devices); centralized attestation server (operational burden + critical-path dependency); pure-P2P identity (open research, not v1).

### D-002 — Orchestrator distributed claim via Autobase merge-order arbitration

**Decided.** Append claim → await own-append merge → check first-in-merged-order → fire agent. Mathematical guarantee, no race window.

**Why**: deterministic merge order eliminates double-work without requiring a coordinator. Latency floor is just Autobase convergence (~50-200ms), which is also a lower bound for any other guarantee.

**Alternatives rejected**: quiescence-window (still races on the slow path); designated coordinator (single point of failure).

### D-003 — `pr_reviewer_settings` keyed by `(harness_slug, github_user_id)`

**Decided.** Drop `user_id` UUID; use `github_user_id` consistently across all identity surfaces.

**Why**: mixing UUID and `github_user_id` was a bug magnet.

### D-004 — Auto-approve and auto-merge are independent toggles

**Decided.** Both default FALSE. Auto-merge is only effective when auto-approve is on. Consequence modal at trust-add when auto-review is on (and again when auto-merge is on).

**Why**: three coherent reviewer postures (manual / auto-approve-only / full automation) instead of the half-design where auto-approve + manual-merge is busywork. Explicit opt-in for the riskiest step.

### D-005 — Phase 4 single-engineer dogfood uses `state: private` (no sharing prereqs)

**Decided.** No user-branch, no Hyperbee, no peer-mirror — just Papercusp's normal single-engineer flow on papercup's real codebase. Sharing debuts in Phase 5.

**Why**: preserves the pull-forward win. Phase 4 was blocked-by Phase 5 items in v3, defeating the planning advantage. Solo dogfood is self-contained.

### D-006 — Phases (staging/testing/production) retired for shared harnesses

**Decided.** For shared harnesses: one user-branch worktree per harness; status state machine (`backlog / in_queue / working / pending_done / shipped`) replaces phase promotion. Private harnesses keep phases for now (no breaking change).

**Why**: phases were an awkward fit even for single-user. The collaboration model dissolves them naturally. User-branch is your staging; `pending_done` is testing; `shipped` is production.

**Alternatives rejected**: coexist phases + user-branch (contradiction; complicated to maintain both worktrees).

### D-007 — Hybrid sync (HYPERBEE for 7 live tables, GIT for ~20 doc tables)

**Decided.** Bucket by write-frequency, not by table name. Live state via Hyperbee CRDT; document state via files-in-git on user branches.

**Why**: most "shared" state is document-shaped and slow-changing — better as human-diffable files with visible merge conflicts. Hyperbee surface stays small + manageable.

**Fallback** (Phase 0 spike fail): collapse HYPERBEE into GIT for everything. Slower live state (15s commit debounce), same collaboration model.

### D-008 — Path B (Hyperdrive git peer-mirror) default OFF, opt-in per harness

**Decided.** Per-harness toggle. When on, peer-mirror via Hyperdrive cuts engineer-to-engineer code latency from ~5s to <1s.

**Why**: commit-becomes-peer-visible is a workflow change that deserves explicit opt-in. Branch-pattern filter excludes `wip/*` by default.

### D-009 — GitHub-forced for shared harnesses, behind a PrHost abstraction

**Decided.** All shared harnesses require GitHub OAuth. PrHost interface for future GitLab/Gitea.

**Why**: GitHub OAuth provides identity + clone + PR API in one stack. Almost everyone in our target audience has GitHub. Abstracting now is cheap; switching hosts later is bounded.

### D-010 — `github_user_id` (numeric, stable) used in branch names

**Decided.** Branches are `user/12345`, not `user/alice`. Display the current `github_username` in the UI; render the branch via the stable id.

**Why**: GitHub username renames are real and orphan branches otherwise. Numeric id never recycles, never changes.

### D-011 — Features stay PG-canonical, sync via Hyperbee, NEVER committed to git

**Decided.** Per user direction. Hyperbee gives sub-second live sync; PG remains canonical store; git carries code only.

**Why**: putting features in git would mean either dual-canonical (Hyperbee + git conflict) or sole-canonical (lose live sync). PG-canonical with Hyperbee projection is the simplest model.

### D-012 — Last-writer-wins on HYPERBEE conflicts; surfaced as "your change was overridden" toast

**Decided.** LWW labeled honestly. Clobber toast in §6.4 + UI.

**Why**: real per-field CRDT for tabular data is complex and yields limited benefit at our scale (3-5 concurrent writers per harness). LWW + clobber visibility is acceptable. Document state with real merge conflicts lives in GIT bucket.

### D-013 — Privacy confirm-modal at BOTH create-time and join-time

**Decided.** Sharer sees consequence at create-time; joiner sees consequence at join-time. Same modal pattern for shared-private and shared-public (different copy).

**Why**: privacy implications should be visible to BOTH parties at consent-time, not buried in docs.

### D-014 — No "trust anyone" affordance, ever

**Decided.** Every trust gesture is per-user deliberate. No bulk-trust, no auto-trust-new-contributors, no domain-trust.

**Why**: trust-anyone is a foot-gun for security. Anyone-can-become-a-contributor (good) combined with manual-trust-only (necessary) is the right balance.

### D-015 — Holepunch primitives only (NOT Pear runtime)

**Decided.** Stay on Tauri. Use `@holepunchto/*` npm modules embedded in existing desktop runtime.

**Why**: Pear is an app-runtime swap (months-long port). Holepunch primitives are libraries we add.

### D-016 — `current_worker` derived, not stored

**Decided.** `working_users` is the source of truth (array); `current_worker = working_users[0]`. No separate column.

**Why**: one source of truth eliminates the "which one wins" race when both columns are stored.

### D-017 — `harness_issues_consolidated` does NOT get feature-collab columns in v4

**Decided.** Defer issue collaboration design to its own arc. Don't add `working_users` / `current_worker` / `completion_ref` schema until the issue flow is specced.

**Why**: shipping schema for a behavior we haven't designed is the dead-letter scenario. Issues today resolve via `linkedFeatureId` to a fix-feature; that flow already works.

### D-018 — PR live state via bulk poll, no webhook in v1

**Decided.** One `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100` per harness per 60s. Cache in HYPERBEE + LOCAL split per §8.4.

**Why**: bulk endpoint covers up to 100 open PRs per call. Comfortably inside GitHub's 5000-req/hr authenticated quota. Webhook needs ingress infrastructure we don't have generically; deferring.

### D-019 — `isomorphic-git` as the clone-with-OAuth driver

**Decided.** Add `isomorphic-git` for clone-with-auth (Entry 2). Other git operations (peer-mirror push, sync-with-main rebase) continue using shell-out to system `git`.

**Why**: `isomorphic-git` handles auth-token-in-URL cleanly; shell-out for clone-with-auth requires URL-injection of secrets. Mixing the two by use-case is acceptable.

### D-020 — vditor as the markdown editor for user-authored content

**Decided.** Plans, decisions, feature descriptions, design artifacts. vditor handles WYSIWYG + markdown source + preview.

**Why**: user-authored markdown deserves a real editor, not a textarea. vditor is mature, MIT, has the WYSIWYG / source / preview modes our content workflows want. (Docs surfaces stay on Starlight; vditor is for authoring, not reading.)

### D-021 — Cupboard server is required infrastructure (not P2P-discoverable)

**Decided.** Public-harness discoverability needs a centralized listings service. Cupboard server hosts the index. Same shape as the existing Marketplace listings service.

**Why**: discovery without a directory is a chicken-and-egg problem. The Cupboard server is small (a single Next.js route + small PG); not on the critical path of normal harness use (only used at publish-time + discovery-time).

### D-022 — Reactivity layer = `pg_notify` triggers + LISTEN + SSE + `useSyncQuery`

**Decided.** Per §13. Producer-side `emit_change_notify` triggers are the v4 gap to close.

**Why**: ~70% already shipped. Drop `@rocicorp/zero`. Migrate stragglers (plans-admin) from polling.

## Open questions

### Q-1 — Cupboard moderation policy

If anyone can publish a `shared-public` harness, the Cupboard could fill with spam / abuse / NSFW. What's the moderation surface? Manual review queue? Rate-limit per `github_user_id`? Community reports?

**Probable answer**: Phase 9 ships with rate-limit + report endpoint; manual review is operator-side; defer richer moderation tools to Phase 12+.

### Q-2 — Mobile read-only views

What does the existing mobile UI need for collab features? Read-only feature queue? PR status? Out-of-scope for v1 but worth scoping.

### Q-3 — Cross-machine identity revocation race

If user has 2 devices and one is stolen, they can revoke from the other (`delete gist`). But the stolen device's local Hyperbee writer log still has its history. Does the revocation propagate effectively? Need to verify the Autobase semantics: revoked-pubkey records ignored on future writes, but prior writes persist. Acceptable?

### Q-4 — Hyperbee schema migrations

What's the migration story when we add a new HYPERBEE table or change a key prefix? Hyperbee is append-only — bumping a schema version with old records present needs a story.

### Q-5 — Peer-mirror disk footprint

Bare git mirrors `never gc'd` accumulate. For a year-old harness with thousands of commits, what's the footprint? Document, then offer a "compact mirror" operation.

### Q-6 — Sleeping laptop convergence latency

Phase 0 P-003 measures this. If converging a 2-week-asleep peer takes 30s+, we need a "Hyperbee bootstrap progress" indicator. Spike informs UX.

### Q-7 — RESOLVED — `Q-7` from v3 (monorepo vs separate) confirmed by user as separate

(Recorded here for traceability; no action needed.)

### Q-8 — Discord URI scheme reliability across OSes

Confirmed working on macOS+Linux when Discord desktop installed. Windows? Linux without Discord client? Document the fallback paths.

### Q-9 — vditor + Starlight coexistence

vditor for authoring; Starlight for reading. Are there UI surfaces that need both (e.g. a plan that's a Starlight doc but also editable inline)? Spike during Phase 8.
