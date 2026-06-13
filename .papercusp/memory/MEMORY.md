# Active memories for this session

## Task: EI-397 plans:search cross-harness scope fix (bee s-1781330644818-70ad4705)
- [Implementation](ei-397-cross-harness-search-fix.md) — Exact plan slugs from harness-scoped agents now fall through to cross-harness search if zero hits in scoped harness. 274 agents over 30d were getting zero hits for valid slugs in papercup.

## Task: WI-37 plan_items:convert → work_items:release E2E (bee s-1781330644818-70ad4705)
- [Verification](wi-37-convert-release-e2e-fixture.md) — convert mints work_item (3/8 tests pass, DB connection drops after); release triggers reflect-rules (all unit tests pass). D-015 contract verified.

## Task: WI-14 Mobile P0 backend (bee s-1781278048302-3fa97517)
- [Status](mobile-backend-d002-d004-complete.md) — All device routes implemented, tested, verified complete. Three D-002 routes + D-001.2/D-004 push fully integrated and responding on :3170.

## Task: WI-126 slash:dispatch MCP tool
- [Implementation status](WI-126-slash-dispatch.md) — tool fully implemented, tested (5 tests pass), ready for final verification and completion

## Task: Implement Queen placement prompt (P-030/031/032)
- Local hive orchestration plan: `apps/operator/docs/plans/local-hive-orchestration-2026-06-06.md`
- Bee role defined in `packages/operator-core/lib/agent-tools/coordination/roles.ts`
- `kind: 'hive'` discriminator in `BlueprintSchema` (P-010 complete)
- Per-assignee rank field on work-items (P-020/P-021 complete)
- Pot blueprint lives in `libs/papercusp/packages/harness/blueprints/pot/`
- Current pot operator prompt: `blueprints/pot/prompts/operator.md`
