# HANDOFF — WI-41206 / WI-41242 · memory-cap removal + the deploy/bundle defect

Written 2026-08-24T03:48Z by su-c1dea4c8. Everything below was MEASURED, not assumed.
This is a stale snapshot of a live system — re-verify anything time-sensitive before acting.

## ⛔ FIRST, WHAT YOUR JOB IS **NOT**

**[owner 2026-08-24] A DIFFERENT AGENT IS LEADING THE BUG DRAIN. Do NOT lead it.**

Concretely, do **not**:
- take or contest leadership of `nonp2p-bug-drain-relief-2026-08-24` (or any `...bug-drain...` fleet)
- call `fleet:launch-on-plan` to spawn drain members
- claim drain work-items, revise the drain claim spec, or relaunch dead drain members

Earlier in this session I *was* that leader and much of the transcript is me trying to launch 30
members. **That objective has been reassigned.** If you inherit a fleet-leader watch or a
`fleet:member-dead:*` wake for a drain fleet, it is stale residue — do not act on it as leader.
`loop:end` / `events:cancel` that residue rather than servicing it.

**Your job is the CODE + DEPLOY work below.** It is what UNBLOCKS the drain leader — until the
fix is live on `:3070`, `fleet:launch-on-plan` refuses every headless launch fleet-wide.

## Your mission

1. Get the memory-cap fix actually LIVE on `:3070` (steps below).
2. Land the durable fix for **WI-41242** (the deploy silently ships stale host code).
3. Hand the two owner-decisions below to the owner / drain leader — inform, don't act.

## Background: what the code change is

[owner 2026-08-24] "remove all of them … if the user wants to run a lot of agents and use up the
memory and force pagination that is their choice."

Plan `remove-memory-derived-work-refusals-2026-08-24` — all 6 items landed, **416+ tests green**:

| item | file | what changed | tests |
|---|---|---|---|
| P-001 | `agent-tools/fleet_registry/launch-on-plan.ts` | clamp is ADVISORY — computes/reports, never reduces `openCount` | 138/138 |
| P-002 | `systemd-scope.ts` + task-manager types/enroll-sync/managed-spawn | `ScopeSwapPolicy='allow'\|'deny'`, default **allow** so workers PAGE not OOM-die | 14/14, 16/16, +5 files |
| P-003 | `sync/hyperbee/perf/host-capacity.ts` + `child-driver.ts` | never returns `ok:false`; caller no longer throws | 21/21, 4/4 |
| P-004 | `libs/generic/resource-profile/src/index.ts` | removed the `os.freemem()` agent clamp | 218/218 |
| P-005 | `scripts/lib/budgeted-task-scheduler.mjs` | MemAvailable no longer narrows the lane | 41/41 |
| P-006 | `scripts/affected-tests.mjs` | satisfied by P-005; corrected a lying comment | — |

Every rewritten test was **inverted to pin the new contract**, never deleted, plus 3 regression
guards. `substrate-sidecar-spawn` is pinned `swap:'deny'` on BOTH paths — do not "simplify" that
away; it preserves the WI-1086 leak containment (a 68 GB swap-thrash that froze the event loop).

## ⚠ FOUR TRAPS THAT COST ME HOURS — do not re-walk them

1. **`deploy-cli --execute` ships the GREEN MAIN PIN, not staging.** The pin is ~3 days stale and
   `:3070` already sits on it — which is why `release:deploy op:'status'` reports
   `nothingToDeploy:true`. Forcing a chosen sha needs **`--deploy-commit <sha> --execute`**.
2. **The operator runs a PREBUILT BUNDLE, not source.** `/proc/<MainPID>/cmdline` =
   `node dist-host/hono-host.mjs`, cwd `papercup-release/apps/operator`. The unit's `ExecStart`
   mentions tsx — an earlier agent read that and told the fleet it runs source. It does not.
   A deploy swaps source and rebuilds the SPA but **never rebuilds the host bundle**, which is
   untracked so a git swap cannot update it. That is WI-41242.
3. **`bundle-host.sh` EXITS 0 when the build fails** — it falls back to the last-known-good
   bundle. `/api/health` then reports the DEPLOYED sha while serving stale bytes. The only honest
   signals are `/api/health`.`bundleStale` and `dist-host/.bundle-stale.json`.
4. **My own poll loops produced TWO false "it landed" positives.** Both shell bugs: comparing a
   10-char sha to an 8-char literal, and `grep -c … || echo 0` emitting `"0\n0"` (grep -c exits 1
   on zero matches, so BOTH sides fire). **Verify by CONTENT**, never by a clever loop condition.

Sentinels: `host-memory-advisory` (launch-on-plan.ts) · `ScopeSwapPolicy` (systemd-scope.ts).

## Where it stands RIGHT NOW — re-check all of it

- Staging HEAD **`6760f8ec31`** carries the fix AND the previously-missing exports:
  `git show HEAD:packages/operator-core/lib/agent-tools/capability/bash-jobs.ts | grep -cE 'export function (detectSelfOutputRedirect|formatSelfRedirectAdvice)'` = **2**.
  At the earlier sha `51d71bec` it was **0** — a half-committed refactor (imports swept in without
  their exports) broke the host-bundle build FLEET-WIDE. git-sync has since swept the other half.
- Release checkout still `51d71bec`; bundle still `2026-08-23 21:44Z`; `bundleStale` present.
- **Deploy #2 IN FLIGHT**: `task_id 0mt6ox6z0gynvpz8f28`; logs `/tmp/deploy2.log` then
  `/tmp/bundle2.log`. Runs `--deploy-commit 6760f8ec31 --execute`, THEN `bundle-host.sh`.
  Last seen alive at `▶ snapshot`, RuntimeMaxSec 2400. Do NOT start a second deploy alongside it.

## NEXT STEPS, in order

1. **Wait for `0mt6ox6z0gynvpz8f28`**, then verify by CONTENT:
   `grep -c 'host-memory-advisory' /home/marsh-office/papercupai-workspace/papercup-release/apps/operator/dist-host/hono-host.mjs`
   → must be **≥1**. If 0, read `/tmp/bundle2.log` for esbuild errors and fix the SOURCE. Never
   hand-copy a bundle between checkouts.
2. **Restart the operator**: `systemctl --user restart papercup-dev-api.service`. Confirm
   `/api/health` no longer carries `bundleStale` and `ActiveEnterTimestamp` moved.
3. **Prove the fix is live WITHOUT launching anything.** Safest probe that spawns nothing:
   confirm the served bundle contains the sentinel and that `/api/health.bundleStale` is gone.
   If you want a behavioural check, ask the DRAIN LEADER to run their own launch and report
   `hostMemorySuppressed` — do not spawn members yourself.
4. **Tell the drain leader + owner it is live**, with the two decisions below. Then stop touching
   the drain.
5. **Land WI-41242 properly**: make the host-bundle rebuild an explicit deploy STAGE between swap
   and preflight; make `bundle-host.sh` exit non-zero on failure (its silent exit-0 fallback is
   the root of the false green); and add a post-deploy assert that the SERVING process reports
   the deployed sha, so a stale-bundle deploy fails loudly.

## ⚠ TWO OWNER DECISIONS — surface, do not silently pick

1. **`luna` DOES NOT WORK.** Codex preflight: *"The 'luna' model is not supported when using
   Codex with a ChatGPT account."* Probed: `luna` → **400 invalid_request_error** ·
   `gpt-5.6-sol` → **OK** · `gpt-5.6-terra` → **OK**. The owner asked for "30 luna maxes"; that
   is impossible on account `default`. This is also a likely cause of the mass member-death
   events on the `...luna-max...` fleet. **The drain leader needs this — tell them.**
2. **Quota is nearly exhausted.** `chatgpt-sub-cli` utilization7d = **0.92**; `aviynw` (claude) =
   **1.00**, `edgeThrottled:true`. 30 concurrent members will hit rate limits whatever the model.
   Do not switch accounts to work around this without the owner saying so.

## Standing constraints — do not violate

- **Never `git commit`/`push` by hand.** git-sync owns it. A half-committed refactor is exactly
  what broke the bundle tonight.
- **Gate WI-40086 is `su-08275825`'s lane (D-008).** Do NOT fire `release:checkpoint-run`. They
  asked us to stand down and preserve launch-block evidence. Lead already given them: a
  swap-denied 20GiB vitest scope dies the same way their gate keeps dying ("crashed before
  rendering a verdict, naming NO failing test") — theirs to rule in or out.
- The ~199 operator-core tsc errors (167 tests / 32 shipped source) are **pre-existing, not
  ours** — they only became visible when a peer's syntax break stopped masking them.
- Force-deploying is owner-authorised for THIS work only; it ships un-gated code. Do not extend
  that authorisation to anything else.

## Durable pointers

`WI-41206` (cap removal, has full checkpoints) · `WI-41242` (deploy/bundle defect) ·
plan `remove-memory-derived-work-refusals-2026-08-24` ·
facts `wall:headless-launch-admission-zero`, `wall:host-bundle-unbuildable-at-staging-head`.
