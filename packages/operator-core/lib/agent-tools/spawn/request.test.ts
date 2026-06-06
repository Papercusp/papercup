/**
 * request.test.ts — new_subagent:request handler behavior (P-005 / P-009 / P-016).
 *
 * Two admission paths at the tool layer:
 *   • a trusted stream WITH budget → `tryConsumeSpawnCredit` consumes one and the
 *     request AUTO-APPROVES (`via:'budget'`), opening NO escalation — no brain
 *     round-trip (P-009).
 *   • no budget → it opens a `meta.spawnRequest` escalation routed to the brain and
 *     returns the `events:await` key, so the requester sleeps until the brain decides
 *     (never a silent drop, D-004).
 * The brain-only approve gate is locked separately in spawn-approval.test.ts; this
 * exercises the REQUEST side's branching + that the live headroom is surfaced (P-007).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  consume: vi.fn(async () => false),
  openEscalation: vi.fn(async () => ({ msg_id: 'esc-123' })),
  getSpawnHeadroom: vi.fn(async () => ({ ceiling: 16, running: 2, headroom: 14 })),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'worker-1', ownerLabel: 'Worker 1' }),
}));
vi.mock('../coordination/escalations', () => ({ openEscalation: h.openEscalation }));
vi.mock('../../fleet/operator-spawn', () => ({ getSpawnHeadroom: h.getSpawnHeadroom }));
// Partial mock — agent-mcp's bootstrap statically imports db-org's `generated`, so
// keep the real module and override only getOrgPg (the handler dynamically imports it).
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../fleet/governor', () => ({
  tryConsumeSpawnCredit: h.consume,
  spawnBudgetScopeKey: (owner: string) => `spawn-budget:${owner}`,
}));

import requestTool from './request';

const ARGS = { role: 'worker', harness: 'papercup', reason: 'help with chunk X' };
const CTX = { workspaceId: 'default' } as any;
const parse = (res: any) => JSON.parse(res.content[0].text);

beforeEach(() => {
  h.consume.mockReset().mockResolvedValue(false);
  h.openEscalation.mockReset().mockResolvedValue({ msg_id: 'esc-123' });
  h.getSpawnHeadroom.mockReset().mockResolvedValue({ ceiling: 16, running: 2, headroom: 14 });
});
afterEach(() => vi.restoreAllMocks());

describe('new_subagent:request handler (P-005 / P-009 / P-016)', () => {
  it('AUTO-APPROVES from a stream budget when a credit is available — no brain round-trip, no escalation', async () => {
    h.consume.mockResolvedValue(true);
    const out = parse(await (requestTool as any).handler(ARGS, CTX));
    expect(out).toMatchObject({ ok: true, approved: true, via: 'budget', budget_scope: 'spawn-budget:worker-1' });
    expect(h.openEscalation).not.toHaveBeenCalled();
  });

  it('routes to the BRAIN when no budget — opens a spawnRequest escalation + returns the await key (no silent drop)', async () => {
    const out = parse(await (requestTool as any).handler(ARGS, CTX));
    expect(h.openEscalation).toHaveBeenCalledTimes(1);
    const esc = (h.openEscalation.mock.calls[0] as any[])[1];
    expect(esc.meta).toMatchObject({ spawnRequest: true, requestedRole: 'worker', requester: 'worker-1' });
    expect(out).toMatchObject({ ok: true, request_id: 'esc-123', await_event: 'escalation:resolved:esc-123' });
  });

  it('surfaces the live spawn headroom to inform the brain (P-007)', async () => {
    const out = parse(await (requestTool as any).handler(ARGS, CTX));
    expect(out.headroom).toEqual({ ceiling: 16, running: 2, headroom: 14 });
  });
});
