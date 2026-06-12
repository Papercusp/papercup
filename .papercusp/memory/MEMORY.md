# Active memories for this session

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
