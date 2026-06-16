# Worker log — EI-8 (plan_items:claim "require is not defined")

## Outcome: fixed (verified — bug no longer reproduces; added regression guard)

## What I found
- EI-8: `plan_items:claim` threw `require is not defined` because the CLAIM write
  path resolves the lock authority, which (per the bug + peer trace) eagerly
  loaded a holepunch/Hypercore CJS dep under the tsx ESM runtime on :3070.
  Vitest bundles, so unit tests never saw it.
- Current tree: `lockAuthorityFor` (packages/operator-core/lib/authority/lock-authority.ts)
  resolves self-authority via the lightweight identity layer (resolveUsageActor)
  + a PG `shared_presence` query, and only reaches the swarm RPC transport via
  `getPeerRpcTransport()` when a REMOTE peer exists (never on a single box).
  No static import of sync/hyperbee/holepunch remains in the chain. This is the
  fix the peer proposed (post #10, su-3854d); it landed via su-584a8's
  distributed-coordination work.

## Reproduction (under the exact tsx ESM runtime :3070 uses)
- Imported the production wiring (agent-tools/plan-items/index → installSwarmClaimAuthority
  + registerPlanItemClaimAuthorityOps) and ran `claimPlanItem` against the bug's
  plan/item (tui-workbench-ratatui-2026-06-04 / P-005). Result: CLAIM OK, no
  "require is not defined". Released the repro claim row afterward.

## Regression guard added (test-only — no production code touched)
- packages/operator-core/lib/__tests__/tsx-runtime-imports.test.ts: added
  `@papercusp/operator-core/lib/plan-items/claim-authority-swarm` to GUARDED_MODULES.
  This spawns a real tsx subprocess to import the claim→authority→identity chain;
  it fails if anyone re-introduces an eager CJS swarm import. (vitest can't catch
  this class because it bundles — hence this dedicated tsx-subprocess guard.)

## Tests run (all green)
- npx vitest run lib/__tests__/tsx-runtime-imports.test.ts → 5 passed (incl. new EI-8 guard)
- npx vitest run claim-discipline.test.ts reflect-rules.test.ts lock-authority.test.ts → 38 passed
- live tsx repro: claimPlanItem on tui-workbench P-005 → claimed OK

## For the validator to re-verify
- Confirm the tsx guard test stays green in CI (needs apps/operator workspace + npx tsx).
- Note: a *full-runtime* repro of the original require-trap needs the real tsx
  host + identity/PG; the import guard covers the eager-import vector that the
  original bug actually exhibited ("eagerly loads the swarm layer").
