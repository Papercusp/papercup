# worker-log — EI-8718 (implement / self-improvement auto-fix)

**Outcome: needs-human** — the fix touches a protected STOP surface (release/deploy machinery + DBOS routine).

## Bug
green-checkpoint re-dispatches a release-fixer for a stale/GC'd candidate on an already-green, fully-promoted gate. Symptom: a `green-checkpoint:red` dispatch fired a release-fixer for candidate `2e7f9d739348c3608615c1919b1ee933a328130d`, a SHA present in NO git tree (staging/main/checkpoint all at `1056dfc0db`, `origin/main == origin/staging`), with the last 4 checkpoint runs all green. >=2 fixers were spawned for that nonexistent candidate, each concluding "stale, no edit needed" — pure wasted spawns.

## Root cause (confirmed by reading the code)
- Dispatch site: `packages/operator-core/lib/harness/routines/release-actions.ts:323` →
  `if ((status === 'not-green' || status === 'advanced-prefix') && candidate) dispatchReleaseFixer(ctx, candidate, failingTests)`.
- `dispatchReleaseFixer` (release-actions.ts:828-931) fires the `release-fix` blueprint via the **DBOS-durable** `fireLaunchBlueprintForEvent('green-checkpoint:red', ...)` (line 903).
- Dedup is purely **failure-signature + liveness** based (line 836, `decideReleaseFixerDispatch` at ~722): within the 2h window it skips only if the prior fixer is still ALIVE; a dead/finished fixer **self-heals -> re-dispatches**.
- There is **no dispatch-time re-verification** that, right now:
  (a) the `candidate` SHA is still a valid git object, or
  (b) the gate is still actually red (`main` behind `staging`).
- So once a fixer is dispatched for a candidate that is later superseded + GC'd and the gate self-heals to green, the durable/self-heal dispatch keeps re-firing fixers that have nothing to fix.

## Recommended fix (for a human — protected surface)
Add a cheap, dispatch-time re-verify guard at the top of `dispatchReleaseFixer` (or immediately before the branch at release-actions.ts:323). Skip the dispatch — and record a `release_fixer` pipeline event with status `no-op` / `resolved-red` for auditability — when EITHER:
1. `main` is fully caught up to `staging` (`git merge-base --is-ancestor staging main` in the integration root, i.e. nothing left to promote -> gate is green), OR
2. the `candidate` SHA is no longer a valid git object (`git cat-file -e <candidate>` / `revParse` fails).
Both conditions mean there is nothing for a release-fixer to fix.

Helpers already exist: `isAncestor`, `refExists`, `revParse` in `apps/operator/lib/release/git-ops` (used by green-checkpoint.ts); release-actions.ts would shell the equivalents against the integration root (`ctx`/`toolingRoot`).

**Danger to avoid:** the guard must NEVER suppress a legitimate dispatch on a genuinely red gate (`main` behind `staging`, valid red candidate) — that would freeze the whole fleet's deploys (the multi-hour-freeze incident class these files' comments describe). This risk is exactly why the auto-fix STOP gate routes it to a human.

## Regression test suggestion
Unit-test the pure guard predicate (inject the two git checks): `shouldDispatchReleaseFixer({ candidateValid, mainCaughtUp })` returns false when `mainCaughtUp || !candidateValid`, true otherwise — alongside the existing `decideReleaseFixerDispatch` tests in `release-actions.test.ts`.

## Why needs-human (not could-not-fix)
The fix is well-understood and implementable — this is a protected-surface *policy* stop (release/deploy machinery + routines/DBOS scheduler), not an inability. Per the implement role contract + the Queen brief STOP condition.
