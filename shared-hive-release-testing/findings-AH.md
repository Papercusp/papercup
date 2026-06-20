# Findings AH — Code plane: git-sync → `main` (E2E code federation)

**Author:** su-707ed · **Date:** 2026-06-19 · **Lane:** Brief AH (S1, S0 on the no-direct-push invariant)
**Verdict: 🟢 GREEN with one 🟡 YELLOW caveat** — the collaborator code→default-branch path is
end-to-end correct, conflict-convergent, branch-agnostic, and plane-independent; the S0
"a joiner can never direct-push the owner's main" invariant holds and is teeth-verified.
The single caveat: the **non-collaborator fork→PR LIVE leg** (real GitHub fork + cross-fork
PR) is logic-tested but has never run hermetically against GitHub — it needs a creds-gated
live witness before a public launch where non-collaborators contribute code.

---

## 0. What was already true vs. what this lane adds

The code plane's PIECES were already well-tested (seeding, eligibility, the push decision, the
run-git-sync pipeline, GAP-4 submodule-defer, oversized-blob exclusion, non-FF retry, two-peer
convergence). This lane (a) ties them into the literal **"a Bee writes code in a running member →
it lands on the shared origin's default branch → a peer pulls it → all converge"** end-to-end
claim with a **byte-for-byte content** assertion, (b) closes the **S0 joiner-no-direct-push**
invariant *with teeth* and *with a real upstream remote present* (the existing push:false test
only covered the no-upstream case), (c) adds the **plane-orthogonality** guards, and (d) the
**non-`main` default branch** edge that every existing rig hardcodes away.

**New test file (teeth-verified):**
`packages/operator-core/lib/harness/git-sync/code-plane-federation.test.ts` (real `git` + a local
bare repo as the shared-hive origin; no GitHub network, no PG) — 6 tests, all green.

**Run:** `cd packages/operator-core && npx vitest run lib/harness/git-sync/code-plane-federation.test.ts`

---

## 1. The two planes (confirmed)

- **Content plane** — plans / hive_members / presence / locks federate over the hyperbee
  substrate. Waves 1–5 cover it.
- **Code plane** — source files do NOT ride the substrate. Each member's `system:git-sync`
  routine (`run-git-sync.ts` → `runGitSync`, ~10-min jittered cron) commits the whole tree
  (`git add -A`) and `git push origin HEAD:<branch>` **directly to the shared repo's default
  branch** (collaborators), with non-FF retry so concurrent peers converge at the origin.

> **Terminology note for readers:** the brief says "main". In the SHARED-HIVE code plane the push
> target is the **member repo's own default branch** (`origin/HEAD`, often `main`, sometimes
> `trunk`/etc.) — resolved per-repo by the pipeline, NOT a literal hardcoded `main`. This is
> distinct from the *papercup* superproject, whose git-sync pushes `origin/staging` and whose
> `main` is green-automation-only. Brief AH is about the shared-hive member-repo plane. AH-4
> below proves the per-repo resolution.

## 2. The two contribution paths (confirmed in code)

Governed by `decideGitSyncPush()` (`decide-git-sync-push.ts`) + `handleFeaturePassed()`
(`fork-pr-on-feature-pass.ts`):

| Member | Push decision | Code reaches upstream via |
|---|---|---|
| **Collaborator WITH upstream write** (creator/owner) | `push:true` | git-sync direct-push `origin HEAD:<branch>` |
| **Non-collaborator WITHOUT write** (joiner) | `push:false` (rule 2, *before* the permission rules) | a **fork→cross-fork PR under the contributor's OWN account** (`ensureFork` → `openForkPr`), fired lazily at feature-pass (`fork-pr-on-feature-pass.ts`) |

**The S0 invariant: a non-collaborator can NEVER direct-push the owner's default branch.** Proven
below (AH-2).

---

## 3. Scenario-by-scenario verdict

### Scenario 1 — E2E happy path, collaborator (the headline) — 🟢 GREEN
A collaborator member writes a code file → git-sync tick → the file's **content** lands on the
shared origin's default branch byte-for-byte → a peer member's git-sync pulls it → both trees +
the origin converge.

- **NEW** `code-plane-federation.test.ts` › **AH-1**: asserts `git show <branch>:src/feature.ts`
  on the bare origin equals the exact bytes written (existing tests assert head-sha/filenames
  only — never the content), then the peer's clean-tree tick fetch-merges it and the file arrives
  intact in the peer's working tree; all three heads converge.
- **Prior art** (re-confirmed green this run): `seed-any-hive.integration.test.ts` S4
  "push:true tick: commit lands, push reaches the bare origin" (13/13);
  `two-peer-convergence.integration.test.ts` C1 "A pushes; B fetch-merges A and pushes; A merges
  back — union on origin" (6/6).

### Scenario 1b / Scenario 3 — joiner fork→PR + push-auth correctness (the SAFETY path, S0) — 🟢 GREEN (hermetic) / 🟡 YELLOW (live)
- **The no-direct-push half — 🟢 PROVEN + TEETH:** **NEW** AH-2: a member under the **joiner-side
  decision** (`decideGitSyncPush({ joinerSide:true, hasUpstreamRemote:true, permissionsPush:true })
  → push:false` — joiner-side wins outright, *even with a forged positive push permission*) writes
  code → git-sync commits **locally** but the owner's origin branch is **byte-identical to before**;
  the joiner file is absent on origin. **Teeth inline:** the *identical* write under the creator-side
  decision (`push:true`) DOES advance the origin — proving the "origin unchanged" assertion is
  load-bearing. **Teeth-verified at the source:** neutering the joiner rule in
  `decide-git-sync-push.ts` (`push:false`→`push:true`) turns the invariant RED.
  - This strictly strengthens the prior `seed-any-hive` S4 "push:false → origin untouched", which
    only covered the **no-upstream** case (`no_upstream_remote`) and carried **no teeth** — AH-2
    covers the actual S0 case: a joiner **with a real upstream remote present**.
  - **The invariant holds TREE-WIDE (submodules included):** **NEW** AH-6 — a joiner that writes
    code in BOTH a submodule and the superproject commits LOCALLY in both but advances **neither
    origin** (super OR submodule): `o.pushed === []`. Every prior joiner/push:false test was
    single-repo and every submodule test was push:true — AH-6 closes the gap that a joiner could
    otherwise leak commits to a *submodule's* origin even with the superproject held back.
    Teeth-verified at the source (forcing the submodule's `doPush` makes the joiner leak → RED) and
    inline (the creator variant pushes both origins, submodule-first then the pointer).
- **The fork→PR half — 🟢 logic-tested / 🟡 live-untested:** `handleFeaturePassed` gates fork-mode
  on `getPermission ∈ {read,none}` (non-collaborator) → `openForkPr`; `{write,maintain,admin}` →
  `integration_mode` (direct push, no PR). `ensureFork` short-circuits when the authed user owns
  the upstream and is idempotent + ready-polls a created fork. All unit-tested with mocked Octokit
  (`fork-pr-on-feature-pass.test.ts`, `open-fork-pr.test.ts`, `fork-pr-url-created-hive.test.ts`,
  re-confirmed green). **Gap:** no test drives a REAL fork creation + cross-fork PR against GitHub
  — the literal "a non-collaborator's code becomes a PR on the owner's repo" has never run
  end-to-end. → **the YELLOW caveat** (see §5).
- **Honesty (not a silent no-op):** the joiner's push:false carries an explicit, honest
  `pushReason` (`joiner_side — read-only member clone; fork-PR is the contribution path`) surfaced
  on the seed outcome — the user is not misled into thinking a push happened.

### Scenario 2 — multi-peer direct-to-main convergence under REAL conflict — 🟢 GREEN (prior art)
Fully covered by `two-peer-convergence.integration.test.ts` (re-confirmed green, 6/6):
- **No lost commit** under a concurrent push race: P0 "disjoint peer push in the window → the
  non-FF retry re-fetches, re-merges, lands BOTH (synced)" + C1 union-on-origin.
- **A true overlapping-line conflict is handled deterministically, never silently dropped or
  force-pushed:** P0 "CONFLICTING peer push → the retry re-merge conflicts, **aborts CLEAN**,
  reports" (no half-merge, no `MERGE_HEAD` left behind); C2 "loser escalates + dispatches a
  resolver, converges"; C3 racing resolvers are bounded at one extra pass (origin serializes); C4
  three rounds, no wedged dedup. `seed-any-hive` S4 "conflict tick → escalation at the constant
  `git-sync` phase, clean pass clears it". The pipeline **never force-pushes** (only
  `push HEAD:<branch>`; non-FF → fetch+merge+retry).

### Scenario 4 — EI-382 (link-join silent no-sync) — 🟢 GREEN (already fixed; the brief's "RED today" is STALE)
**The brief assumed EI-382 is open. It is FIXED.** `join-link.ts` (the bare invite-link join
handler) explicitly seeds the joined clone's git-sync routine **joiner-side** (`joinerSide:true →
push:false`, salted cron, github coords from the link) — see lines 151–179, which cite "EI-382" by
name. Covered + teeth-able in `join-link.test.ts` (re-confirmed green): "seeds the joined clone
git-sync routine joiner-side with github coords + salted cron", "does NOT seed when cloneDir
missing", "swallows seed errors — the join still returns 200". A link-joined member therefore DOES
sync (as a local mirror; it never direct-pushes — consistent with the S0 invariant).

- **Residual (S2, not a blocker):** the registered link-join entry carries **no `hive_slug`**, so
  the boot reconcile (`reconcileGitSyncRoutines`, which iterates `projects.filter(p => p.hive_slug)`)
  will NOT auto-backfill a link-joined member whose **join-time seed failed** (the seed is
  best-effort — e.g. PG down at join). Such a member is only **surfaced** as an `unseeded` ALARM by
  the P-014 blind-spot detector, not auto-seeded. Common path: fixed. Rare seed-failure path:
  degrades to an alarm a human must action, not an auto-heal. Filed as an improvement (see §5).

### Scenario 5 — credential resolution per-repo — 🟢 GREEN (decision) / 🟡 live-gated (resolution)
- **Fails CLOSED, honestly:** `decideGitSyncPush` rule 3 `permissions.push===false →
  github_permissions_push_false — push:false` (unit-tested, `decide-git-sync-push.test.ts`); a member
  with no push permission gets a quiet commit-only local mirror, NOT a hang and NOT a per-tick
  error-escalation (the asymmetry the decider exists for, documented in its header). The unknown
  case is loud-optimistic (`permissions_unknown_optimistic → push:true`) and surfaces a wrong guess
  via the existing `git-sync-error` escalation.
- **The probe itself is teeth-tested to fail closed without hanging** —
  `github-repo-permissions.test.ts` (re-confirmed) covers `fetchRepoPushPermission` returning `null`
  and NEVER throwing across 404, rate-limit (403), network ETIMEDOUT, unauthenticated
  (`getOctokit→null`), no-permissions-block, and even the client-getter itself throwing — and
  asserts it resolves the RIGHT repo (`repos.get` called with the exact `{owner,repo}`). So a
  no-permission member fails closed with an honest `null`→`push:false`, not a silent skip or a hang.
- **Live-gated:** the actual `gh` credential-helper resolution at push time (the in-process-token-free
  path) is creds-gated and not exercised hermetically. The DECISION layer is fully tested; the
  resolution layer needs the live witness (same gate as §5's fork-PR leg).

### Scenario 6 — plane orthogonality (both directions) — 🟢 GREEN
- **Code reaches the origin independent of the content plane:** AH-1 (and every git-sync test)
  runs git-sync with **NO substrate booted** — the code plane reaching the origin is direct proof
  it does not depend on the content-federation substrate. **NEW** AH-3(a) adds a **structural
  decoupling guard**: `run-git-sync.ts` imports NOTHING from the substrate
  (`sync/hyperbee`/`corestore`/`wire-outbox`/`boot`) — so a content-federation stall (the EI-681
  class) cannot wedge code reaching the origin. Teeth-verified (injecting a substrate reference
  turns it RED).
- **A code-plane fault cannot cascade into content federation:** **NEW** AH-3(b): a git-push
  failure (broken remote) surfaces as a structured `status:'error'` (fails CLOSED) and `runGitSync`
  **never throws** — the work is committed locally (not lost), only the push failed. A code-plane
  error stays a recorded routine/escalation outcome; it does not unwind a caller's content path.

### Scenario 7 — branch + safety edges — 🟢 GREEN
- **Non-`main` default branch:** **NEW** AH-4 — a repo whose default branch is `trunk` pushes to
  `trunk` (resolved from `origin/HEAD`/HEAD), and git-sync does **not** invent a `main` ref. Every
  existing rig hardcodes `main`; this closes the brief's explicit edge. Teeth-verified (forcing the
  last-resort `defaultBranch` turns it RED).
- **Oversized file (>95 MB):** covered with **real git E2E** — `run-git-sync.test.ts`
  "EXCLUDES an oversized file from the auto-commit, still syncs the rest, and reports it"
  (asserts the oversized `big.bin` is absent on the bare origin while the rest is pushed, and the
  blob stays untracked locally), plus the untracked-dir bypass guard (`-uall`; the EI-18 class) and
  the oversized-only "nothing" case. Boundary unit: `oversized-blob-boundary.test.ts` +
  `findOversizedDirtyFiles` (strict `>` ).
- **Content-guard exclusions:** covered with **real git E2E** — `run-git-sync.test.ts` asserts a
  broken file (`bad.md`) does NOT reach the origin (quarantined) while the rest federates; unit
  coverage in `content-guard.test.ts`.
- **GAP-4 superproject-waits-for-submodules (never publish a gitlink to an unpushed submodule
  commit):** covered with **real git** — `run-git-sync.test.ts` "GAP-4: a submodule unreachable
  while ahead → errors + DEFERS the superproject (no broken gitlink)", plus submodule-push-first
  (deepest-first) and diverged-submodule reconcile.

---

## 4. Bugs found

**None new (S0/S1/S2).** No code-loss, wrong-repo-push, unauthorized-push, or silent-no-sync defect
was found in the code plane. The S0 invariant (joiners never direct-push) holds and is now
teeth-verified with a real upstream remote present. The brief's one suspected open bug (EI-382) is
already fixed.

## 5. Gaps left open (with why) + filed improvements

| # | Gap | Severity | Why open / disposition |
|---|---|---|---|
| G1 | **Fork→PR LIVE leg** (real GitHub fork + cross-fork PR) never run hermetically | S2 (logic-tested) | Needs GitHub creds + the `shared-hive-test` repo; gate behind the live-creds flag. The non-collaborator contribution path's LOGIC is fully unit-tested with mocked Octokit; the actual GitHub round-trip is not. **Recommend a creds-gated live witness before a public launch where non-collaborators contribute.** |
| G2 | **EI-382 reconcile residual**: a link-joined member whose best-effort join-time seed FAILS is not auto-backfilled (no `hive_slug` → reconcile skips it; only `unseeded` alarm) | S2 | Common path fixed; rare seed-failure path degrades to an alarm, not auto-heal. Filed as an improvement (link-join should either stamp `hive_slug`, or the reconcile should also backfill the `unseeded` set it already detects). |
| G3 | **`gh` credential resolution at push time** (in-process-token-free path) not hermetically exercised | S2 | Decision layer (fail-closed, honest) fully tested; live resolution shares G1's live-creds gate. |

These are all **S2 / live-gated**, not launch-blockers for the **collaborator** code plane. G1 is
the one to close before relying on the **non-collaborator** contribution path in a public launch.

## 6. Release-readiness verdict

**🟢 GREEN** for the **collaborator** code plane: a member's code reaches the shared repo's default
branch end-to-end (content byte-for-byte), concurrent multi-peer pushes converge including real
conflicts (no lost commit, no force-push, clean-aborts), the code plane is independent of the
content plane (and fails closed, contained), git-sync is branch-agnostic, and link-joined members
DO sync (EI-382 fixed).

**🟢 GREEN** for the **S0 safety invariant**: a joiner can never direct-push the owner's branch —
proven with a real upstream remote present and teeth-verified.

**🟡 YELLOW caveat** for the **non-collaborator contribution path**: the fork→PR LIVE leg (G1) is
logic-tested but never run against GitHub. Close it with a creds-gated live witness before a public
launch where untrusted members contribute code.

---

## 7. Evidence (all green this run, 2026-06-19)

| Suite | Result | Covers |
|---|---|---|
| `code-plane-federation.test.ts` (**NEW**) | 8/8 | AH-1 headline content round-trip; AH-2 S0 no-direct-push + teeth; AH-3 orthogonality; AH-4 non-main branch; AH-6 S0 holds tree-wide (joiner never leaks to a submodule origin) + teeth |
| `two-peer-convergence.integration.test.ts` | 6/6 | scenario 2 conflict convergence (P0/C1–C4) |
| `seed-any-hive.integration.test.ts` | 13/13 | scenarios 1/3 (push lands; push:false origin untouched; reconcile; conflict tick) |
| `join-link.test.ts` + `fork-pr-on-feature-pass.test.ts` + `decide-git-sync-push.test.ts` | 33/33 | EI-382 fix; fork-mode gate; push decision |

**Teeth-verify ledger** (neuter source invariant → confirm RED → restore → confirm GREEN; all
confirmed): AH-1 ← neuter the push exec; AH-2 ← neuter the joiner `push:false` rule; AH-3(a) ←
inject a substrate reference; AH-4 ← force the last-resort `defaultBranch`; AH-6 ← force the
submodule's `doPush` (makes the joiner leak a commit to the submodule origin → RED). AH-2 and AH-6
additionally carry their teeth inline (creator-push variant). AH-3(b) is teeth-verified by
positive-control contrast (working remote → `synced`; broken remote → `error`).
