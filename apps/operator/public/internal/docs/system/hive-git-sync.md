# Hive git-sync — per-member seeding and the multi-pusher model
URL: /internal/docs/system/hive-git-sync

How git-sync generalizes to any hive — one routine per member checkout (never homes or views), the push decision table, creator/joiner seed-active split, deterministic cron jitter, and the origin-serialized multi-pusher model for shared hives.

import { Aside } from '@astrojs/starlight/components';

# Hive git-sync

The git-sync pipeline (`packages/operator-core/lib/harness/git-sync/run-git-sync.ts`)
commits the whole tree, fetches, merges, and pushes — for **any** registered
checkout, not just papercup. This page documents how that pipeline is *wired*
to hives: which registry entries get a `system:git-sync` routine, who seeds it,
what the seeded config says, and how N independent peers on a shared hive
converge on one origin branch. Source plan: `git-sync-any-hive-2026-06-12`
(see the [plans index](/internal/docs/reference/plans-index)); the pipeline
itself was built in `git-sync-auto-commit-2026-06-03` and hardened in
`git-sync-system-audit-2026-06-09`.

The **creator-ACTIVE / joiner-INACTIVE seed split** (P-005) and the
**multi-pusher origin-serialized model** (D-004) are provisional defaults
(plan decision D-005), implemented as one-line constants so a later
ratification is a trivial flip. D-004 is additionally gated on the P-010
two-peer convergence verification, which has **not yet run** — see
[Verification status](#verification-status).

## The model in one paragraph

A hive = a **home** harness (`harness_kind: 'hive'`, a non-repo state dir) +
N **member** harnesses (registered clones carrying `hive_slug`). Joiners
additionally materialize a `remote_hive` home **view** (non-repo) + read-only
member clones. Git-sync seeds **one routine per member checkout — never homes,
never views** (plan D-001: "git-sync for a hive" = the set of its members'
routines). Each routine is an ordinary `harness_shared.routines` row
(`target_role: 'system:git-sync'`, cron trigger — see
[Routines](/internal/docs/spec/routines)); the routines engine runs the action,
which wraps the pure pipeline with locks, escalations, and resolver dispatch.

## Eligibility — which entries get a routine

`git-sync-eligibility.ts` is the **one** verdict module, shared by every seed
site and by the action's runtime gate, so seed time and run time can never
disagree. `gitSyncEligibility(entry)` is pure + sync over a registry snapshot;
reasons in precedence order:

| Reason                 | Entry shape                                  | Why it never syncs                                                                                                      |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `remote_hive_view`     | `remote_hive: true`                          | Joiner-side hive view — a non-repo dir under `~/.papercusp/remote-hives` (checked first: views are also `kind: 'hive'`) |
| `hive_home`            | `harness_kind: 'hive'`                       | The hive home is a non-repo state dir                                                                                   |
| `non_local_deployment` | `deployment.target` present and ≠ `'local'`  | The checkout lives on a cloud frame, not this box's filesystem                                                          |
| `no_path`              | No registered path, or it vanished from disk | Nothing to sync                                                                                                         |
| `not_a_git_repo`       | Path exists but carries no `.git`            | Not a clone (`.git` may be a dir or a worktree/submodule file)                                                          |

The same verdict also runs as a **runtime gate** at the top of every tick
(`git-sync-action.ts`): a routine row whose target became ineligible no-ops
with a logged reason and a `last_status: 'skipped'` metadata patch instead of
error-escalating every 10 minutes.

## Seeding — one spine, five producers

All seeding flows through `seedGitSyncRoutineForMember`
(`git-sync-routine.ts`), which composes eligibility → existing-row check →
push decision → jittered cron → upsert. It **never throws** and never fails
the calling tool — every failure folds into a reported outcome. It is
**non-clobbering**: an existing routine row (possibly human-edited) is left
intact; a re-add/re-join reports `routine_exists`. One carve-out: a
creator-side re-seed that brings github coords **upgrades** a row that is
still exactly the untouched machine-default coords-less shape, so the probed
push and default branch land on the from-repo double-seed ordering
(`harness:create { hive }` seeds before the coords are stamped); the outcome
surfaces `upgraded: true`. Anything human-touched — active flipped, cron
retuned, any config deviation — is never clobbered, and joiner-side or
coords-less re-seeds still report `routine_exists`.

| Producer                  | Site                                                                                  | Side                | Cron jitter key                      |
| ------------------------- | ------------------------------------------------------------------------------------- | ------------------- | ------------------------------------ |
| `hive:create_from_repo`   | `agent-tools/hive/_create_from_repo.ts` (step 7.25, new-hive **and** into-hive paths) | creator             | member slug                          |
| `hive:add-member`         | `agent-tools/hive/_add-member.ts` (both success paths — a re-add heals a missing row) | creator             | member slug                          |
| `harness:create { hive }` | `agent-tools/harness/create.ts` (step 5a)                                             | creator             | member slug                          |
| Hive join                 | `lib/harness/join-hive.ts` (`joinHiveAsView` per-member loop)                         | joiner              | `<slug>:<workspaceId>`               |
| Boot reconcile            | `git-sync-reconcile.ts`, fired once per process from `lib/sync/hyperbee/boot-all.ts`  | detected per member | slug, or salted when joiner-detected |

The boot reconcile is the **backfill**: it walks each workspace's registry,
visits only hive members (`hive_slug` set), detects joiner-side members by
their home entry's `remote_hive` flag, and add-only seeds whatever is missing —
so hives created before the seed sites existed (or members that slipped past
them) converge on next boot. Members joined via a **bare join link** (outside
`joinHiveAsView`) carry no `hive_slug` and are not covered.

A seeded row carries, in `trigger_config`:

* **`cron`** — jittered every-10-minutes schedule (below);
* **`push`** — from the decision table (below);
* **`branch`** — the member's `github_default_branch` registry coord when
  known (the pipeline falls back to its own per-repo branch resolution
  otherwise);
* **`active`** — from the provisional creator/joiner split (below).

## Seed-active split (P-005 — provisional)

Creator-side members seed **ACTIVE**; joiner-side clones seed **INACTIVE**.
The constants live in `git-sync-eligibility.ts`:

```ts
export const GIT_SYNC_SEED_ACTIVE_CREATOR = true;  // provisional P-005
export const GIT_SYNC_SEED_ACTIVE_JOINER = false;  // provisional P-005
```

Rationale for the default: creator-side follows the flags-default-enabled
culture (escalations surface problems); joiner-side clones are read-only by
design (fork-PR is the contribution path), so even commit-only churn stays
opt-in until a human flips the routine on
(`setGitSyncRoutineActive(sql, slug, true)`). The owner may ratify or flip
either constant — they are deliberately one-line.

## The push decision table

`decideGitSyncPush` (`decide-git-sync-push.ts`) is the one place that answers
"should this seeded routine push?". Rules in precedence order; the first match
wins (reason tokens are stable, machine-greppable prefixes):

| # | Condition                                     | `push`  | Reason token                     |
| - | --------------------------------------------- | ------- | -------------------------------- |
| 1 | No upstream remote (no `github_remote` coord) | `false` | `no_upstream_remote`             |
| 2 | Joiner-side clone                             | `false` | `joiner_side`                    |
| 3 | GitHub `permissions.push === false`           | `false` | `github_permissions_push_false`  |
| 4 | GitHub `permissions.push === true`            | `true`  | `github_permissions_push_true`   |
| 5 | Permission unknown (`null`)                   | `true`  | `permissions_unknown_optimistic` |

The permissions signal comes from a best-effort probe
(`lib/harness/github-repo-permissions.ts`: authenticated
`GET /repos/{owner}/{repo}`, auth via the shared `getOctokit()`/gh-token path;
any failure returns `null`, never throws). The spine only runs the probe when
it can change the answer — rules 1–2 win outright without it.

Why the default is asymmetric (rule 5 optimistic, rules 1–2 hard `false`): the
pipeline's fetch-fail branch is not symmetric in `push`. With `push: false` a
failed/absent fetch is benign — the repo gets quiet commit-only sync. With
`push: true` the same failed fetch error-escalates **every tick** and never
self-heals. So push is only enabled where it plausibly works; a wrong
optimistic guess surfaces loudly via the `git-sync-error` escalation (plan
D-002) instead of silently stranding work.

## Cron jitter — and why

`gitSyncCronForKey(key)` (`git-sync-eligibility.ts`) hashes the key (FNV-1a
32-bit, dependency-free, stable across processes and platforms) to a minute
offset 0–9 and emits a 6-field every-10-minutes cron:

```
0 <o>,<o+10>,<o+20>,<o+30>,<o+40>,<o+50> * * * *
```

Every member keeps a 10-minute cadence, but members land on different minute
offsets. This cuts same-tick collisions two ways:

* **between members on one box** — N members' ticks don't all contend the
  routines engine and the network at once;
* **between peers on a shared hive** (the D-004 case) — the same member slug
  exists on every peer box, so joiner-side seeding salts the key with the
  workspace id (`<slug>:<workspaceId>`), de-correlating peers' fire times and
  shrinking the window for two peers to fetch→push the same origin branch in
  the same instant.

Jitter is structural, not configurable: the seeding spine always computes the
cron through this helper (no seed site bypasses it), and the schedule shape is
the same one papercup's hand-seeded row already uses, parsed by the routines
engine's `computeNextFireAt`.

## The multi-pusher model (D-004 — provisional)

For shared hives, **every push-capable peer runs its own git-sync
independently**. There is no single-pusher election and no new coordination
machinery. Convergence relies on the origin branch as the serializer:

1. Each peer's tick runs commit → fetch → merge → push per repo
   (submodules deepest-first, superproject last).
2. When a peer's push is rejected **non-fast-forward** (another peer pushed
   between its fetch and push), the pipeline re-fetches, re-merges once, and
   re-pushes (`run-git-sync.ts`, `syncOneRepo`). The loser's local edits ride
   in on the merge commit.
3. When that merge **content-conflicts**, the tree is aborted clean (agents
   never see a half-merged tree), a `git-sync-conflict` escalation is written,
   and a `merge-resolver` agent is dispatched **on that peer** — resolvers run
   per peer, against the peer's own checkout. Dispatch is deduped per harness
   while a resolver is genuinely in-flight (`RESOLVER_INFLIGHT_MS`, 20 min);
   the launch resolves via the `merge-resolution`
   [launch blueprint](/internal/docs/agent-insights/launch-blueprints).

Accepted cost: occasional cross-peer merge conflicts, handled by the existing
escalation + resolver path rather than prevented by election or locking.

### Federation is orthogonal (D-003)

A shared hive's substrate federation
([hive-scoped federation](/internal/docs/agent-insights/hive-scoped-federation)
— hyperbee/peer-log over the hive's Ed25519 topic) carries **coordination and
PG state**. Git origin carries **the tree**. Generalized git-sync neither
replaces nor depends on federation: a federated hive still syncs its tree
per-peer through ordinary git remotes, and a hive with no federation at all
syncs the same way.

## Run-time concerns: locks and escalation keying

Per tick, the action holds the **per-slug** exclusive lock `git-sync:<slug>`
(auto-registered idempotently, in the same transaction as the acquire) for the
whole commit → submodule-push → pointer-bump → push sequence, plus every name
in the routine's `trigger_config.extra_lock_resources` (which are **never**
auto-registered — an unknown name skips the tick with a loud log). Held by a
peer → skip this tick. Papercup's row lists the legacy global `git-sync` +
`libs-papercusp-submodule` names there, so the documented back-off protocol
("acquire `exclusive(git-sync)` to make papercup's git-sync back off") keeps
working — see
[named resource locks](/internal/docs/agent-spawning/named-resource-locks) and
[repo conventions](/internal/docs/system/repo-conventions) for the papercup
specifics.

Escalations key on `(harness_slug, phase)` with the **constant** phase
`'git-sync'`. The old constant `'staging'` shared its row with other
`phase='staging'` writers — auto-rebase's `rebase_conflict` rows clobbered
git-sync's and vice versa via `ON CONFLICT DO UPDATE` — and a branch-derived
phase would orphan open rows whenever a routine's branch changed. A
git-sync-owned constant ends both.

Both changes ship with migrations — locks `sql/015` (registry prose for the
per-slug naming) and db `sql/237` (papercup's `extra_lock_resources` + re-key
of open escalation rows `'staging'` → `'git-sync'`) — which apply via the
migration runner (`db:migrate`).

## Failure surfaces (links, not prose)

* **`git-sync-conflict`** — merge conflict; tree aborted clean, resolver
  dispatched (above). Read via the `harness:escalation` tool; pipeline history
  on the `/admin/git` tab.
* **`git-sync-error`** — repeated push failures and/or oversized-file
  exclusions (EI-18: GitHub hard-rejects blobs ≥100MB; dirty files over
  `max_blob_bytes`, default 95MB, are excluded from the auto-commit and
  reported instead of permanently wedging the push). Never clobbers an open
  conflict escalation. Long form: plan `git-sync-system-audit-2026-06-09`.
* Every tick also appends a pipeline event row (sync/conflict/error rates over
  time) — surfaced on the `/admin/git` tab.

## Verification status

D-004 stands **provisionally**. The empirical half (plan P-010 — a two-peer
convergence test on a scratch shared hive: disjoint edits, a real overlapping
conflict, and a resolver-race probe for ping-pong) is deferred to a dedicated
session with a second isolated operator stack. Until it runs, treat shared-hive
multi-pusher behavior as designed-but-unverified; if ping-pong is observed the
planned mitigation is a resolver-dispatch backoff (skip dispatch when origin
advanced since the conflicting fetch — re-merge first), recorded as a new plan
decision.
