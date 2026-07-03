/**
 * Fleet-level claim-spec inheritance (fleet-scheduler-hardening-2026-07-03 P-002).
 *
 * Claim specs were keyed ONLY by bee ownerId, so a fleet relaunch (fresh ownerIds)
 * stranded the leader hand-authoring N per-bee specs before members pulled correctly —
 * and until then every member pulled under DEFAULT order. The fix stores a FLEET-level
 * spec under the `fleet:<slug>` sentinel bee_id (same table, no schema change) and
 * `getClaimSpec` resolves: bee spec → fleet spec (via the durable membership fact,
 * stamped at boot per WI-1893) → DEFAULT_CLAIM_SPEC.
 *
 * These tests pin the resolution order and the sentinel key at the store's IO seams
 * (sqlOverride + a mocked fleet-membership-store — no PG), plus the tool's
 * exactly-one-of-{beeId,fleet} arg contract.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ZodTypeAny } from 'zod';

const membershipMock = vi.fn(async (_ws: string, _owner: string) => null as {
  fleetSlug: string | null;
  fleetRole: string | null;
} | null);
vi.mock('../fleet-membership-store', () => ({
  latestFleetMembership: (ws: string, owner: string) => membershipMock(ws, owner),
  appendFleetMembershipEvent: vi.fn(async () => {}),
  appendFleetMembershipIfAbsent: vi.fn(async () => {}),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));

import { getClaimSpec, fleetSpecBeeKey } from './claim-spec-store';
import { DEFAULT_CLAIM_SPEC } from './claim-spec';
import setClaimSpecTool from '../agent-tools/scheduler/set_claim_spec';

/** A minimal spec that passes validateClaimSpec. */
const laneSpec = (specId: string) => ({
  specVersion: '1.0',
  specId,
  revision: 1,
  view: {},
  rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
});

/** Tagged-template sql stub: returns queued row-sets in call order, records queries. */
function makeSqlStub(queue: unknown[][]) {
  const calls: string[] = [];
  const sql = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(`${strings.join('␟')} :: ${vals.map(String).join(',')}`);
    return queue.shift() ?? [];
  };
  return { sql: sql as never, calls };
}

beforeEach(() => {
  membershipMock.mockReset();
  membershipMock.mockResolvedValue(null);
});

describe('fleetSpecBeeKey', () => {
  it('is the fleet:<slug> sentinel', () => {
    expect(fleetSpecBeeKey('backlog-clearance')).toBe('fleet:backlog-clearance');
  });
});

describe('getClaimSpec fleet inheritance (P-002)', () => {
  it('a per-bee spec WINS — no membership lookup at all', async () => {
    const beeSpec = laneSpec('bee-own-lane');
    const { sql } = makeSqlStub([[{ spec: beeSpec }]]);
    const got = await getClaimSpec({ beeId: 'su-abc', workspaceId: 'ws1' }, sql);
    expect(got.specId).toBe('bee-own-lane');
    expect(membershipMock).not.toHaveBeenCalled();
  });

  it('no bee spec + fleet membership + fleet spec ⇒ inherits the fleet spec', async () => {
    membershipMock.mockResolvedValue({ fleetSlug: 'backlog-clearance', fleetRole: 'member' });
    const fleetSpec = laneSpec('bc-general');
    const { sql, calls } = makeSqlStub([[], [{ spec: fleetSpec }]]);
    const got = await getClaimSpec({ beeId: 'su-new-member', workspaceId: 'ws1' }, sql);
    expect(got.specId).toBe('bc-general');
    expect(membershipMock).toHaveBeenCalledWith('ws1', 'su-new-member');
    // The second query keyed the sentinel, same workspace partition.
    expect(calls[1]).toContain('fleet:backlog-clearance');
    expect(calls[1]).toContain('ws1');
  });

  it('no bee spec + NO membership ⇒ DEFAULT_CLAIM_SPEC', async () => {
    const { sql } = makeSqlStub([[]]);
    const got = await getClaimSpec({ beeId: 'su-loner', workspaceId: 'ws1' }, sql);
    expect(got).toBe(DEFAULT_CLAIM_SPEC);
  });

  it('no bee spec + membership but NO fleet spec row ⇒ DEFAULT_CLAIM_SPEC', async () => {
    membershipMock.mockResolvedValue({ fleetSlug: 'ops-team', fleetRole: 'member' });
    const { sql } = makeSqlStub([[], []]);
    const got = await getClaimSpec({ beeId: 'su-member', workspaceId: 'ws1' }, sql);
    expect(got).toBe(DEFAULT_CLAIM_SPEC);
  });

  it('a membership-store failure degrades to DEFAULT (never wedges the bee)', async () => {
    membershipMock.mockRejectedValue(new Error('pg down'));
    const { sql } = makeSqlStub([[]]);
    const got = await getClaimSpec({ beeId: 'su-member', workspaceId: 'ws1' }, sql);
    expect(got).toBe(DEFAULT_CLAIM_SPEC);
  });
});

describe('scheduler:set_claim_spec args — exactly one of beeId | fleet', () => {
  const args = (setClaimSpecTool as { args: ZodTypeAny }).args;
  const spec = laneSpec('lane');

  it('accepts beeId-only and fleet-only', () => {
    expect(args.safeParse({ beeId: 'su-abc', spec }).success).toBe(true);
    expect(args.safeParse({ fleet: 'backlog-clearance', spec }).success).toBe(true);
  });

  it('rejects neither and both', () => {
    expect(args.safeParse({ spec }).success).toBe(false);
    expect(args.safeParse({ beeId: 'su-abc', fleet: 'backlog-clearance', spec }).success).toBe(false);
  });
});
