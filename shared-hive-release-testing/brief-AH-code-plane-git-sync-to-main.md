# Brief AH — Code plane: git-sync → `main` branch (E2E code federation)

**Priority: S1 lane (S0 if code loss / wrong-repo push / unauthorized push).** Integration
+ live. The SECOND federation plane — untested end-to-end. Added at owner request
(2026-06-19): "how does code make it to main in a shared hive, and is it tested?"

## The gap (why this brief exists)
Shared hives have **two orthogonal planes** (git-sync plan D-003):
- **Content plane** — plans / hive_members / presence / locks federate over the hyperbee
  substrate (swarm topic from the hive pubkey). **Waves 1–5 test this exhaustively.**
- **Code plane** — the actual source files do NOT ride the substrate. Each member harness's
  **git-sync routine** (`git-sync`, ~10-min jittered cron) commits its working tree
  (`git add -A`) and `git push origin HEAD:<branch>` **directly to `main`** (no PR), with
  non-FF retry so concurrent peers converge at the GitHub origin.

The PIECES are unit/integration tested (seeding, eligibility, push-decision, run-git-sync
pipeline, two-peer-convergence racing the same origin). **What is NOT tested: the literal
end-to-end "a Bee writes code in a RUNNING shared-hive member → it lands on GitHub `main`",
nor several correctness/safety edges of multi-peer direct-to-main pushing.** For a public
release where members on different machines push to one shared repo, the code plane is as
load-bearing as the content plane — and it's the plane that can lose or mis-route *code*.

## Scope / scenarios
1. **E2E happy path (the headline):** a running shared hive, 2 members on 2 machines; a
   Bee writes code in member-A's working tree → git-sync tick → assert the commit lands on
   GitHub `main` (real or a controlled bare-repo origin) AND member-B's git-sync pulls it
   → both trees + origin converge. The flow the owner asked about, proven.
2. **Multi-peer direct-to-main convergence under REAL conflict:** two Bees edit the SAME
   file on two members concurrently → both push to `main` → assert the non-FF retry
   (fetch+merge) converges with NO lost commit; a true merge CONFLICT (overlapping lines)
   → assert git-sync escalates/handles deterministically (doesn't silently drop or
   force-push). (two-peer-convergence covers racing; this adds genuine content conflict.)
3. **Push-authorization correctness (S0 if wrong):** creator-side with push permission →
   pushes; **joiner-side (`remote_hive`/read-only clone) → push:false**, code does NOT go
   to origin (the fork-PR path is the joiner's contribution route) — assert a joiner CANNOT
   push to the owner's `main`, and that this is honest in the UI (not a silent no-op the
   user thinks worked).
4. **EI-382 (known open gap):** a bare invite-LINK join registers the clone WITHOUT
   `hive_slug` → never seeded for git-sync → the member's code silently never syncs. Repro
   + assert (RED today); the fix seeds/reconciles link-joined members.
5. **Credential resolution per-repo:** the `gh` credential-helper path (no in-process
   token) resolves auth for the right repo; a member with no push permission fails CLOSED
   with an honest signal, not a hang or a silent skip.
6. **Plane orthogonality (both directions):** code-plane push still works when the
   content-plane substrate is degraded/stalled (and vice versa) — assert a content-federation
   stall (the EI-681 class) does NOT block code reaching `main`, and a git-push failure does
   NOT block content federation. They must fail independently.
7. **Branch + safety edges:** non-`main` default branch (repo's `origin/HEAD`); the
   oversized-file (>95 MB) + content-guard exclusions still federate the rest; the
   superproject-waits-for-submodules gap (GAP-4: never publish a gitlink to an unpushed
   submodule commit).

## Method
- Integration: real `git` + a **local bare repo as origin** (no GitHub network dependency)
  + real PG + locks, driving `runGitSync` / the git-sync routine tick directly. Reuse
  `seed-any-hive.integration.test.ts` + `two-peer-convergence.integration.test.ts` as prior
  art; extend to the E2E "write→tick→origin-main→peer-pull→converge" loop + the conflict +
  auth-deny + EI-382 cases. Live leg (real GitHub repo, the B9 `shared-hive-test` repo) for
  the headline path where a token is available; gate behind the live-creds flag.
- Teeth-verify each (neuter the push-decision → joiner-push test goes RED; neuter the
  non-FF retry → conflict-convergence RED).

## Deliverables
- `findings-AH.md`: the E2E code→main verdict, the conflict + auth + EI-382 + orthogonality
  results, any code-loss / wrong-repo-push / unauthorized-push / silent-no-sync (S0/S1).

## Done / verdict
GREEN only when a Bee's code in a running shared-hive member reaches `main` end-to-end,
concurrent multi-peer pushes converge (incl. real conflicts), joiners cannot push to the
owner's main, link-joined members DO sync (EI-382), and the code plane is independent of
the content plane.

## Key files (from the 2026-06-19 code trace)
- `packages/operator-core/lib/harness/git-sync/run-git-sync.ts` — `runGitSync()` (commit+push pipeline; `git push origin HEAD:<branch>`)
- `…/git-sync/git-sync-routine.ts` — `seedGitSyncRoutineForMember()`, `DEFAULT_GIT_SYNC_CRON` (10-min)
- `…/git-sync/decide-git-sync-push.ts` — `decideGitSyncPush()` (creator push vs joiner read-only)
- `…/git-sync/git-sync-eligibility.ts` — eligibility gates (the EI-382 surface)
- `…/git-sync/two-peer-convergence.integration.test.ts` + `seed-any-hive.integration.test.ts` — prior art to extend
