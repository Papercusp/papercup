# findings — backbone suite flake in the S0/D-001 area (pr3-impl, 2026-06-20)

**Priority-0 reflection finding** (loop autonomous mode; coord MCP down → posting here).
Surfacing for the **D-001 / test-infra owner (J / su-46b7a)**. Not fixing unilaterally — it's the
S0 ordering lane's core test infra, and the right fix is theirs to choose.

## What I found
Independently re-ran the ROLLUP's federation backbone suite on the CURRENT (heavily-churned) tree:
`cd packages/operator-core && npx vitest run lib/sync/hyperbee lib/shared-pot-loop`
→ **2 failed | 1156 passed | 1 expected-fail | 2 skipped** (1 file failed of 146).

The failing file: **`lib/sync/hyperbee/lww-transitivity.test.ts`** (EI-1698) — its two transitivity
tests ("order-independent fold" + "pairwise acyclic") failed with the documented cycle assertion
(`NOT (X>Z ∧ Z>Y ∧ Y>X)`).

## It is NOT a logic regression (ruled out)
- Run **alone**: 4/4 PASS. Repeated **3×**: 4/4 each. With its sibling
  `__tests__/fed-hlc-transitivity-fix-proof.test.ts`: 8/8 PASS.
- The unit under test, `lwwPick` (projection.ts), is **PURE** — single derived-key order
  (`op.hlc ?? encodeHlc({ms: op.ts, count: 0})`), the EI-1698 fix is in; it reads **no env, no
  module-global, no singleton**. X/Y/Z are fixed consts.
- **No** hyperbee test `vi.mock`s `./projection` or `@papercusp/locks-core`; no module-level mutable
  state in projection.ts. So mock/state pollution is ruled out too.
- The failing full run was under heavy load (transform 232s + **import 386s** — the box resource
  starvation the ROLLUP has flagged all session: PG OOM, load 60). A pure deterministic test that
  passes 4/4 alone but fails only in a 146-file run under that load ⇒ **environmental / worker
  isolation flake**, not a real intransitivity.

## Why it matters (release confidence)
The "backbone 891 green" line is the ROLLUP's release-readiness signal for the S0 federation core.
If a full backbone run can spuriously go RED in the D-001 transitivity area, the verdict is
**non-deterministic** — it can (a) erode confidence in a genuinely-green core, or worse (b) be
dismissed as "just the known flake" when a REAL regression lands. Either way the gate is unreliable.

## Recommendation (for J / test-infra)
- Reproduce under load and check vitest worker isolation/parallelism for `lib/sync/hyperbee` (e.g.
  `--no-file-parallelism` or `poolOptions` single-fork for this dir), or pin the backbone run to a
  lower-load window / bounded `maxWorkers`.
- If it recurs deterministically under a specific co-runner, that co-runner is the pollution source —
  worth a `--sequence.shuffle`/bisect. My isolation runs (above) found none, pointing to resources.
- Net: the FIX is green + correct; the SUITE's full-run determinism under load needs hardening so the
  release gate is trustworthy.

— pr3-impl (PR-3 lane; flagged en route to verifying release-readiness, my lane already green)
