/**
 * work_items:claim — claim-time checkpoint hint (EI-529).
 *
 * A NAMED claim (a leader/dispatcher assigning a SPECIFIC item to a SPECIFIC
 * agent) previously surfaced nothing about a prior holder's in-flight progress —
 * exactly the "brief dispatch re-assigns already-completed work" pattern EI-529
 * reported (hit 4x in one session: a fresh claimant silently re-implemented work
 * a prior, now-quiet holder had already shipped). This mirrors the EI-7252 fix
 * that did the same for work_items:get, but AT CLAIM TIME so the warning is
 * unmissable on the very call that starts the new claim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me', workspaceId: 'ws-1' as string | null }));
const fleetAdmission = vi.hoisted(() => ({
  decision: { allowed: true, scoped: false } as any,
  notify: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({
  SUPERUSER_FALLBACK_CLIENT_ID: 'su-loopback',
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId }),
}));
vi.mock('../../work-items', () => ({ claimWorkItem: vi.fn(), classifyClaimFailure: vi.fn(), getWorkItem: vi.fn() }));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitWorkItemForFleetTarget: vi.fn(async () => fleetAdmission.decision),
  notifyFleetScopeRefusal: fleetAdmission.notify,
}));
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));

const getClaimTimeCheckpointHint = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getClaimTimeCheckpointHint: (...a: unknown[]) => getClaimTimeCheckpointHint(...a),
}));

import { claimWorkItem, getWorkItem } from '../../work-items';
const claimM = vi.mocked(claimWorkItem);
const getWorkItemM = vi.mocked(getWorkItem);
const tool = (await import('./claim')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  identity.workspaceId = 'ws-1';
  fleetAdmission.decision = { allowed: true, scoped: false };
  claimM.mockImplementation(async (id: string) => ({ id, harness: 'papercup', assignee: 'me' }) as never);
  // WI-5946: claimOne now unconditionally pre-reads the item via getWorkItem to check
  // payload._claimHold before claiming. These tests exercise the checkpoint-hint path only
  // (no claim-hold scenario), so default to "no pre-existing item row" (null) — matches
  // assessClaimHoldGuard's own no-op-on-null-item behavior and keeps the claim path unaffected.
  getWorkItemM.mockResolvedValue(null as never);
  getClaimTimeCheckpointHint.mockResolvedValue(null);
});

describe('work_items:claim — checkpoint hint at claim time (EI-529)', () => {
  it('attaches checkpoint + a loud warning when a prior holder left one', async () => {
    getClaimTimeCheckpointHint.mockResolvedValue({ checkpoint: 'did: X; left: Y', checkpointAgeMs: 12_000 });
    const b = await body({ id: 'WI-1' });
    expect(getClaimTimeCheckpointHint).toHaveBeenCalledWith({ harness: 'papercup', workItemId: 'WI-1', workspaceId: 'ws-1' });
    expect(b.results[0]).toMatchObject({
      ok: true,
      id: 'WI-1',
      checkpoint: 'did: X; left: Y',
      checkpointAgeMs: 12_000,
    });
    expect(b.results[0].checkpointWarning).toMatch(/PRIOR holder/);
    expect(b.results[0].checkpointWarning).toMatch(/EI-529/);
  });

  it('omits checkpoint fields entirely on a normal fresh claim (no prior checkpoint)', async () => {
    getClaimTimeCheckpointHint.mockResolvedValue(null);
    const b = await body({ id: 'WI-2' });
    expect(b.results[0]).toEqual({ ok: true, id: 'WI-2', workItem: { id: 'WI-2', harness: 'papercup', assignee: 'me' } });
    expect(b.results[0].checkpoint).toBeUndefined();
    expect(b.results[0].checkpointWarning).toBeUndefined();
  });

  it('degrades to a normal claim (no crash) when the checkpoint lookup throws', async () => {
    getClaimTimeCheckpointHint.mockRejectedValue(new Error('pg down'));
    const b = await body({ id: 'WI-3' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-3' });
    expect(b.results[0].checkpoint).toBeUndefined();
  });

  it('surfaces the hint on EACH item of a multi-item batch independently', async () => {
    getClaimTimeCheckpointHint.mockImplementation(async ({ workItemId }: { workItemId: string }) =>
      workItemId === 'WI-HOT' ? { checkpoint: 'prior progress on WI-HOT', checkpointAgeMs: 500 } : null,
    );
    const b = await body({ ids: ['WI-COLD', 'WI-HOT'] });
    expect(b.results[0]).not.toHaveProperty('checkpoint');
    expect(b.results[1]).toMatchObject({ id: 'WI-HOT', checkpoint: 'prior progress on WI-HOT' });
  });
});
