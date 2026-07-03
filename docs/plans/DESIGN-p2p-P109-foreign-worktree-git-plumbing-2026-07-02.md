# DESIGN — P-109 foreign-worktree git plumbing (X5)

Plan: `p2p-work-distribution-2026-07-02` · Item: P-109 · Author: su-4d6de (lane D) · 2026-07-02
Status: **DESIGN PROPOSAL — awaiting leader ratification before any build.**

The four legs of X5, each with a concrete decision + rationale, grounded in the
landed code it extends. Sibling boundaries respected: P-105 owns the OS-level
sandbox (quota volume, cgroups, netns, OS user); P-108 owns the foreign-ref
visibility decision (a)/(b); P-104 owns spawn/session lifecycle; **P-110 is
LANDED** (`hive-git/foreign-merge-admission.ts`, 16 tests green) and this doc
names its call sites.

## 0. Placement: where a foreign workspace lives (prerequisite to every leg)

**Decision: foreign workspaces live under a dedicated foreign root OUTSIDE the
workspace root** — proposed `~/.papercusp/foreign-work/<fleet>/<offer-id>/repo`
(final path may move with P-105's quota mechanism; the invariant is: NOT a
direct child of `PAPERCUSP_WORKSPACE_ROOT`, NOT inside any host tree).

Why: (a) the landed worktree-guard denies direct workspace-root children that
aren't the canonical tree — placement outside gives structural separation from
day one; (b) git-sync's sweep is scoped to the configured canonical tree, so
foreign edits are structurally unreachable by the host commit path (C7's first
line of defense is geometry, not filtering); (c) P-105's quota volume mounts
one directory subtree — one foreign root makes that mount point singular.

Registry: **one new PG table `p2p_foreign_workspaces`** (migration ≥107):
`{offer_id PK, fleet_slug, origin_github_user_id, executor_device, root_path,
session_id, execution_epoch, state (active|winding-down|parked|reaped),
created_at, updated_at}`. Written by P-104 spawn, read by the guard (leg i),
the commit lane (leg ii), the mirror lane (leg iii), and P-106's reaper.
Reuse-first accounting: no existing surface fits — harness-registry rows are
host projects; there is no worktree registry. This is the ONE new table this
lane adds; everything else extends existing surfaces.

## 1. Leg (iv) — the X4 clone/ODB decision: FULL CLONE, own ODB

**Decision: `git clone --no-local` from the host's canonical repo into the
foreign root. Full clone, private ODB, no alternates, no hardlinks.**

Rejected alternatives, and why:
- **`git worktree`** — shares the ODB via commondir (X4, verified by the
  independent auditor): a quota on the checkout is void, and a foreign
  `git add` of a 10GB blob lands in the SHARED, FEDERATED ODB. Dead on arrival.
- **isolated `GIT_OBJECT_DIRECTORY`** — env-based isolation evaporates in
  exactly the environment we're defending against: any git invocation that
  drops the env (hooks, sub-tools, a bare `git` from the foreign shell) falls
  back silently to the enclosing ODB. Isolation that depends on env
  propagation into a hostile shell is not isolation.
- **partial/blobless clone (`--filter=blob:none`)** — needs a promisor remote
  reachable from inside the sandbox for on-demand fetch, i.e. a loopback hole
  (X1). Post-v1 optimization at most; v1 pays the full-clone disk cost upfront
  where the P-105 quota can see it.

`--no-local` matters: a plain file:// local clone hardlinks objects, tying the
foreign ODB to the host ODB's gc lifetime and undercounting quota. `--no-local`
forces a real object copy over the pack pipe.

Results LEAVE the clone by the mirror lane (leg iii) — the foreign session
never pushes anywhere and needs zero git network access (X1-friendly).

## 2. Leg (i) — worktree-guard: a policy surface, not a config toggle

The landed guard (in `pretooluse-locks-acquire.sh`) denies edits whose repo
root is a workspace-root child ≠ canonical tree. Two NEW directional policies,
both derived from the `p2p_foreign_workspaces` registry — never from a local
config flag (that's what "security-relevant policy surface" means here):

- **Host sessions: DENY edits under the foreign root.** A host agent editing a
  foreign workspace is the C7 blending hazard inverted — HOST work would be
  swept by the foreign commit lane and attributed to the ORIGIN author. Deny
  with a loud message naming the offer id (M21) + a P-004 counter.
- **Foreign sessions: ALLOW ONLY their own registered root_path; deny
  everything else** (canonical tree, sibling foreign workspaces, home). The
  hook resolves the session's foreign identity (spawn-injected env naming the
  offer id + a session token minted by P-104 — NOT trusted alone; checked
  against the registry row's session_id) and fail-CLOSED: a foreign-marked
  session with no live registry row edits nothing.

Honesty note (X1 posture): PreToolUse hooks bind tool-mediated edits of honest
clients only. A hostile foreign shell bypasses hooks entirely — the real
boundary is P-105 (dedicated OS user, netns, quota). The guard is the honest-
path policy + the loud-receipt source, i.e. defense-in-depth and UX, and this
doc explicitly does NOT claim it as containment.

## 3. Leg (ii) — per-foreign-workspace COMMIT lane

Today: git-sync sweeps ONLY the canonical tree; nothing commits foreign
worktrees; C7 forbids blending. **Decision: a separate routine
`foreign-git-sync` (target `system:foreign-git-sync`), same tier/cadence
family as git-sync, seeded when the P-005 flag activates** — NOT a phase
inside the git-sync tick, so a wedged foreign clone can never stall canonical
sync (loud failure separation), and pausing p2p (P-002 kill-switch) pauses
exactly one routine.

Per tick, for each `active` registry row:
1. Resolve the ORIGIN identity from the attestation map: the noreply form
   `<id>+<login>@users.noreply.github.com` for `origin_github_user_id` (X9 —
   the numeric id is the key; login display-only). **Both author AND committer
   are stamped with origin-chain identities** — the landed P-110 gate judges
   both slots, precisely so committer-slot provenance laundering is refused.
2. Run the run-git-sync add/commit machinery via a config seam over the
   foreign clone (REUSE, not fork: the stranding-guard catch-all `git add -A`
   and index.lock discipline carry over; the multi-agent attribution grouping
   of git-sync-attribution.ts does NOT apply — one workspace = one fixed
   identity = one commit group).
3. Trailers: `Papercusp-Offer: <offer-id>` (M21), `Papercusp-Origin-User:
   <numeric-id>`, `Papercusp-Executor-Device: <hex>`, `Papercusp-Execution-
   Epoch: <epoch>` (H9).
4. **Fail CLOSED on identity**: attestation unresolvable → commit NOTHING,
   emit a loud receipt + counter, park the workspace. Never fall back to a
   host identity (C7 is absolute).

Regression test (the C3/WI-1564 class, mandated): one test asserting the
canonical sweep scope and the foreign lane scope are DISJOINT — the canonical
tick never stages a path under the foreign root, the foreign lane never stages
a path outside its clone.

## 4. Leg (iii) — mirror lane: foreign clone → C8 marked namespace

Today worktree-bridge mirrors only staging → `refs/hive/staging`. The foreign
mirror is a NEW lane with an inverted direction and a quarantine:

1. **Host-side FETCH (pull), never foreign push**: the lane fetches
   `refs/heads/*` from the foreign clone by path. The foreign session holds no
   credentials and dials nothing (X1). Matches the platform's pull-everywhere
   posture.
2. **Quarantine ODB first** (git's own receive-pack quarantine pattern): fetch
   into a scratch bare repo alternated on the hive ODB, so only NEW objects
   land in quarantine. Enforce the X4 admission there: object-count/size delta
   + per-blob cap (borrow github-egress's large-blob-skip) + secrets-guard
   scan. Oversize/secret → REFUSE + receipt naming the blob; the shared ODB
   never sees the object.
3. **Early identity check**: call `admitForeignMergeHead` (P-110) over the
   quarantine — a spoofed identity is refused HERE, loudly, before the ref
   ever federates (M15: early receipts beat late surprises). This call is
   advisory-early; the merge-time call (below) is the invariant.
4. **Publish into the results channel** with the executor's signature
   carrying the ORIGIN CLAIM (C8). **LANE-C INTERLOCK (2026-07-03 amendment,
   su-c88ac's DESIGN-P-006 FS-D3 + DESIGN-P-108 RC-D1, both pending the same
   ratification):** if option (b) ratifies, the publish TARGET is the
   per-scope bare repo (`<hive-git-root>/<hive>/scopes/<scope_id>/repo.git`),
   NOT a marked namespace inside the hive-wide repo — M14/H16 then hold by
   construction and the C8 sigref extension confines to scope repos. This
   lane composes cleanly with either outcome:
   - **Under (b)**: mirror lane quarantine-fetches from the foreign clone and
     pushes to the LOCAL scope repo (RC-2 admission = this lane's caps+scan;
     repo-local per RC-D3, so it need not wait for P-006's federation half).
     When the ORIGIN later merges a result into canonical staging, it first
     fetches the result commit into the canonical repo's ODB under a LOCAL
     TRACKING REF named in the foreign-marked family
     (`refs/foreign/<scope>/…`) — so P-110's `isForeignMarkedRef` contract
     holds unchanged and RC-4's "provenance marker" is realized as the
     tracking-ref name at the only place path-parsing still occurs.
   - **Under (a)** (rejected by lane C, kept for completeness): publish under
     `refs/namespaces/<executor-hex>/refs/foreign/<fleet>/…` — P-110 already
     matches this shape natively.
   Proposed sigref mechanism (open question 2, unchanged but (b)-confined):
   bump `SIGREFS_SCHEMA_VERSION` and add an optional per-entry
   `originClaim {offerId, originGithubUserId, executionEpoch}` — the host
   signs AS EXECUTOR (its device key) while the claim names the author it did
   NOT author. Extends the existing sigref surface rather than growing a
   parallel foreign-sigref family (reuse-first).
5. **Completion receipt** references the ref + execution epoch (H9) and
   threads the offer id (M21). coord never carries artifacts.

**P-110 call sites (the X2 invariant, stated once):** any code path that
merges a foreign-marked ref into canonical staging MUST call
`admitForeignMergeHead` first and refuse on `admit:false` —
(a) the mirror lane's early check (step 3, advisory), and
(b) the canonical integration step itself (mandatory; the github-bridge-tick
precedent: the integrator only consumes what the gate admits). LIVE-2 proves
the refusal leg end-to-end (P-305: `--author=<owner>` refused at the boundary).

## 5. Failure modes (all loud, all receipted — P-004 posture)

- Quota exhaustion mid-clone/mid-run → P-107 graceful wind-down + receipt.
- Attestation unresolvable at commit time → park + receipt (never host-attribute).
- Oversize blob at quarantine → refuse + receipt naming blob + counter; absent
  from shared ODB (LIVE-2 leg, X4).
- Guard denial (either direction) → deny message names offer id + counter.
- Registry row missing for a live foreign session → fail-closed deny-all + escalation receipt.

## 6. Acceptance (feeds P-306 simulation + LIVE-2/P-305)

1. P-110 spoof refusal at canonical merge — landed, 16 tests green.
2. Disjoint-scope regression test (canonical sweep vs foreign lane) — §3.
3. Quarantine oversize-blob refusal; blob absent from shared ODB.
4. Guard matrix: foreign session denied outside root / host denied inside
   foreign root / foreign session with no registry row denied everywhere.
5. Commit-lane identity: commits carry origin author+committer + all four
   trailers; unresolvable attestation commits nothing.

## 7. Open questions for leader ratification (numbered for a one-line reply)

1. **Foreign root path** `~/.papercusp/foreign-work/<fleet>/<offer>/` — OK, or
   pin to P-105's quota mount point once chosen?
2. **Sigref origin-claim**: schema-version bump with optional `originClaim`
   (recommended) vs a parallel foreign-sigref ref family?
3. **Separate `foreign-git-sync` routine** (recommended) vs a phase of the
   git-sync tick?
4. **Host-side fetch (pull)** into quarantine (recommended) vs foreign-side push?
5. **`git clone --no-local` full clone** as the X4 resolution (recommended) —
   confirm; blobless-clone optimization explicitly post-v1.
6. *(added 2026-07-03)* **Lane-C interlock**: ratify §4's composition with
   FS-D3/RC-D1(b) — mirror lane publishes to the per-scope repo; canonical
   merges import via a `refs/foreign/<scope>/…` local tracking ref so the
   landed P-110 gate anchors on BOTH structural provenance (scope repo) and
   the in-repo marker. (If (b) is rejected, §4's (a) path stands as written.)

No build starts until 1–5 are ratified; the `p2p_foreign_workspaces` migration
sketch and the guard policy changes are drafted but unlanded.
