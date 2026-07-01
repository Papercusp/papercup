# Brief: green the `@papercusp/operator-core` gate

**For:** an agent picking up the release-gate greening.
**Goal:** get the green-checkpoint to produce a GREEN verdict so `release:deploy op:trigger` works again (no more force-deploys). Gate has been red ~101h / 124 reds.
**Owner context:** written 2026-06-30 by su-16121ed1 after diagnosing the gate + landing one class-fix.

---

## The one thing to know: the blocker is a single workspace

The authoritative checkpoint verdict (from `harness_shared.pipeline_events`, kind=`green_checkpoint`, against the current staging commit) fails on **exactly one workspace: `@papercusp/operator-core`**. Everything else greens. So this is bounded: **make operator-core's suite pass under the checkpoint's conditions.**

> ⚠️ Do NOT triage off `harness_shared.test_runs` alone — I wasted hours on that. Those rows are hours-stale and mix in the `papercup-checkpoint/` sibling tree + other hives (`@oddsmith/*`). Get the CURRENT red list from the freshest `pipeline_events` verdict or by running operator-core yourself (below).

## Get the authoritative current red list

```sql
-- freshest checkpoint verdicts (papercusp), with failing workspaces:
SELECT to_char(created_at,'MM-DD HH24:MI') at, status,
       left(detail->>'candidate',12) candidate,
       detail->>'failingTests' failing
FROM harness_shared.pipeline_events
WHERE kind='green_checkpoint' ORDER BY created_at DESC LIMIT 8;
```

Then reproduce operator-core the way the checkpoint runs it (8-fork load + the checkpoint env), NOT a bare `vitest run`:

```bash
cd packages/operator-core
# checkpoint conditions: capped forks + the longer unit timeout the gate sets
VITEST_MAX_FORKS=8 VITEST_UNIT_TIMEOUT_MS=180000 env -u TMPDIR npx vitest run 2>&1 | tail -40
```

A test that passes in isolation but fails here is a **suite-interaction** bug (pollution or load), not a real regression — triage accordingly.

## The three failure classes (each needs a different fix)

1. **Env-leak pollution (partly fixed — extend it).** Tests set a `process.env.*` key and don't restore it; vitest's `forks` pool reuses a worker across files, so the leak hits the next file → "passes alone, flakes in-suite."
   - I fixed the `PAPERCUSP_HIVE_HOME_SLUG` leak *centrally* in `libs/test-config/src/setup-hermetic-env.ts` (added it to the scrub list). **Look for OTHER leaked keys the same way** — grep tests for `process.env.PAPERCUSP_* =` without a matching `afterEach`/`afterAll` restore, and add proven-leaky keys to that scrub list (keep it tight — the file's own comment warns against broad wipes).
   - Symptom in the output: an assertion mismatch where the "actual" is another test's value (e.g. `expected 'ws-1' to be 'papercusp'`).

2. **Stale expectations (real reds).** The code changed, the test didn't. Example seen: `apps/operator/lib/psu-launcher.test.ts` — `expected {…26 keys} to deeply equal {…25 keys}` (a field was added to the parsed result; the test still asserts the old shape). These fail *deterministically* (every run) — they're the ones that KEEP the gate red, so prioritize them. Fix = update the expectation to match the intended current behavior (verify the code is right first).

3. **Load/timeout flakes.** Heavy `await import()` of the operator-core graph under 8 forks can exceed the timeout (see the long comment in `vitest-config.ts` — this is why the gate sets `VITEST_UNIT_TIMEOUT_MS=180000`). If a test only fails under load and is genuinely a cold-import cost, that's runner weather, not a bug. Options: confirm it passes at 180s; if a suite is pathologically slow, split/lazy-load it. **Quarantine only** a CONFIRMED-unrelated flake, accountably (reason + a de-quarantine follow-up work-item).

## Order of work

1. Pull the freshest `pipeline_events` failing list + reproduce operator-core under checkpoint conditions.
2. **Fix the DETERMINISTIC reds first** (class 2) — they're what pin the gate red every run; a flake only fails *some* runs.
3. Sweep the env-leak class (class 1) centrally in `setup-hermetic-env.ts`.
4. Address remaining load-flakes (class 3) — timeout headroom or accountable quarantine.
5. **Measure with the real lever:** `release:checkpoint-run` (now deployed) runs the full gate suite on demand — fire it after your fixes commit, watch `/admin/git` / `pipeline_events` for `advanced`/green instead of waiting up to an hour.
6. When green: `release:deploy { op:'status' }` → `op:'trigger', confirm:true` ships it normally.

## Gotchas
- git-sync auto-commit is currently BROKEN (separate incident — DBOS reaping its fires; a durable-fix plan is being written). Your edits may not auto-commit; verify they land (or hand-commit + note it) so the checkpoint actually evaluates them.
- The checkpoint evaluates the **committed** integration HEAD — uncommitted working-tree fixes won't be measured.
- `setup-hermetic-env.ts` is in the `libs/test-config` submodule — changes there need the submodule committed + pointer-bumped to reach the gate.
