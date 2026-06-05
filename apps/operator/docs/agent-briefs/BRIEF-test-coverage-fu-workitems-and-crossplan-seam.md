# BRIEF — Follow-up: work_items lifecycle + the cross-plan two-peer federation seam

**Parent:** BRIEF-test-coverage-2026-06-04 (lead: su-5cf8c). **Readiness: PARTLY READY** — su-0cbc678c **landed the unify-work-items CORE** (migration 142, `work_items:*` surface live, pipeline reads `work_items[kind=feature]`); **federation + retirement are DEFERRED** (plan `unify-work-items-2026-06-04` D-011). So the work_items lifecycle is now testable, but the federation seam waits on su-584a8's Track A. **Coord-check su-0cbc678c (work_items) + su-584a8 (federation) before starting; confirm which surfaces are settled.**

## Part A — work_items lifecycle (READY once you confirm su-0cbc678c's core is stable)
The parent brief did NOT test the issues/features/work_items surface because it was mid-unification. Now that the unified `work_items:*` tools are live, cover the lifecycle the old `issues-engineer` audit flagged, re-pointed at the new surface:
- `work_items:*` create → claim → link (the `blocks` edge via coord_links, EI-1) → promote → close/comment transitions, and the `kind` discriminator (bug|change|feature) routing.
- The error/edge paths: re-promote guard ("already promoted to <id>"), unknown-harness on promote, update + the `issue_updated`/work-item fan-out, the links projection for a non-`blocks` rel.
- Read the migration-142 schema + the `work_items:*` tool sources first; ground every assertion in the new surface, NOT the retired `issues-engineer` shape.
Home: Vitest integration (operator-core), `@papercusp/test-config`. NOTE: tests likely ship best **with su-0cbc678c's remaining phases** — offer to fold in rather than collide.

## Part B — the cross-plan two-peer federation seam (HOLD until su-584a8 Track A lands)
This is the parent brief's **marquee Step-3 seam, explicitly deferred**: *coordination substrate ↔ work_items ↔ federation — subscribe→inject end-to-end across two peers.* It cannot be written until the federation projection layer (su-584a8 `distributed-coordination-shared-harness`, Track A) is in. When it lands:
- Two simulated peers (two workspace/harness scopes against the testcontainer): peer A files a work_item / posts to a topic → the federation projection propagates it → peer B's subscribe→inject surface receives it. Assert the content round-trips across the peer boundary (the federation contract), and that a non-subscribed peer does NOT receive it.
- This is the integration test that structurally catches cross-plan bugs the per-domain tests miss. It is HIGH value but **blocked**; do not write speculative tests against an unbuilt projection API.

## Rules
- Part A is the parallelizable-now half (coordinate with su-0cbc678c); Part B is hold-until-landed (watch su-584a8).
- Do NOT test retired `issues-engineer` shapes — they're being collapsed; target the live `work_items:*` surface.
- Verify: `cd packages/operator-core && npx vitest run --config vitest.integration.config.ts <file>`; `cd apps/operator && npm run lint:tests`. Judge "green" from a clean checkout, not the churning shared tree.
