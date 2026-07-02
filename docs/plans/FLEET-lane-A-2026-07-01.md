# Lane A — Policy, canonical-ref rules, GC & scope (git-plan fleet)

You are **Lane A** of the `git-plan` fleet (model `claude-fable-5` @ xhigh). Leader:
**su-3700b**. Plan: `cross-machine-coord-parity-and-trust-2026-07-01` (harness `papercusp`).

**FIRST:** read `docs/plans/FLEET-git-briefs-2026-07-01.md` — the LEADER-LANDED FOUNDATION
(build ON `storage.ts` / `sigrefs.ts` / `integrator.ts`; do not reimplement them) and **§0
shared ground rules** (canonical tree only; `mcp-call.mjs`; test commands; fail-soft;
definition-of-done; SHARED-file coord:send). Then `plans:get` each item below for full text.

Work these items, in order, each with tests + `plans:set-status … done`:

1. **G-6 canonical-ref rules (P-030)** — extend `hive-policy-schema.ts` (mirror how `comms`
   was added in P-012) with `crefs: { rules: { "<ref-pattern>": { allow:[pubkey…], threshold } } }`.
   Validate + sign it like the rest of the policy (`coerceHivePolicyInput`). Add a PURE
   `resolveCanonicalRule(policy, refName) → {allow, threshold} | null`. This decides when a
   release-class ref (`refs/tags/releases/*`) becomes canonical (allow = green-bot key + owner
   key, threshold 2). **`hive-policy-schema.ts` is SHARED — coord:send su-3700b before editing.**
   Acceptance: a garbage crefs rule is rejected; `resolveCanonicalRule` returns the right rule
   for a pattern; round-trips through the signed policy.

2. **G-5c integration-requests queue (P-035)** — a bounded LOCAL table (mirror
   `coord_quarantine`'s migration + store shape) where a non-`steer`-tier member's namespace
   head lands for owner ratification instead of auto-integrating: a `list` reader + a one-call
   `ratify(device, sha)`. The code twin of P-013 quarantine-don't-drop. Acceptance: a below-tier
   head is queued (not applied); `ratify` promotes it; per-author bound enforced.

3. **G-9 namespace/ODB GC (P-042)** — `gcHiveGitRepo(repoPath)` in a new `sync/hive-git/gc.ts`:
   keep each device's `work` + last-N published refs + `refs/rad/sigrefs`, drop older; archive a
   departed member's namespace on membership removal; run `git gc` on a cadence. Use
   `listNamespaces`/`listNamespaceRefs` from `storage.ts`. Acceptance (integration test, real
   bare repo): GC bounds the ref/object set WITHOUT losing anything reachable from staging.

4. **G-1b scope (P-041)** — `storage.hiveGitRepoPath` is ALREADY per-(hive, repo). Verify no
   caller assumes per-hive-only; add a test asserting two repo keys under one hive get distinct
   bare repos. Close as covered if nothing else needs changing.

Report `coord:send { to:['su-3700b'], plan_slug:'cross-machine-coord-parity-and-trust-2026-07-01' }`
on each item green, on a blocker, or before editing a SHARED file. The leader reviews every diff.
