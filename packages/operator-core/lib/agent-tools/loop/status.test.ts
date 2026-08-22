/**
 * loop:status distinguishes "no loop exists" from "this read may be from the wrong
 * database" (EI-19384072467112035, following plan outage-must-not-be-silent-2026-08-02).
 *
 * `getLoopStatus` reads through `getOrgPg()`, which can be talking to a different,
 * freshly-initdb'd embedded Postgres than the one this process pinned (a captured
 * discovery file, a per-session sidecar restarted onto a fresh empty store). In that
 * state "no row for this owner" is a correct answer from the WRONG database, not
 * evidence the loop is gone — and an agent that reads `loop:null` and re-arms on the
 * strength of it risks a duplicate loop the moment the real store becomes reachable
 * again. This only ever augments a null/negative result; a found loop row is always
 * reported as-is, unannotated.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/loop/status.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({
    ownerId: 'su-caller-own-id',
    ownerLabel: 'su · caller',
    source: 'omp-hook-session',
    workspaceId: 'ws-1',
    userId: null,
  })),
}));
vi.mock('../../events/await/wake-reachability', () => ({
  probeWakeReachability: vi.fn(async () => ({
    reachable: true,
    channel: 'inject',
    durableWhileAlive: true,
    summary: 'ok',
  })),
}));

vi.mock('../../events/await/store', () => ({ listWakeAwaitsForSubscriber: vi.fn(async () => []) }));

vi.mock('../../harness/routines/loop', () => ({ getLoopStatus: vi.fn() }));

import { _resetStoreIdentityForTests, pinOrVerifyStoreIdentity } from '@papercusp/db-org';
import { getLoopStatus } from '../../harness/routines/loop';
import { listWakeAwaitsForSubscriber } from '../../events/await/store';
import statusTool from './status';

const getLoopStatusMock = getLoopStatus as unknown as ReturnType<typeof vi.fn>;
const listWakeAwaitsMock = listWakeAwaitsForSubscriber as unknown as ReturnType<typeof vi.fn>;

const OURS = { systemIdentifier: '7635091775813704249', database: 'papercusp' };
const IMPOSTOR = { systemIdentifier: '7111222333444555666', database: 'papercusp' };

// Via `unknown`: the tool's declared arg/event generics do not overlap this narrowed
// shape, and TS2352 correctly refuses the direct assertion (same pattern as pg_health.test.ts).
const run = (args: Record<string, unknown> = {}) =>
  (statusTool as unknown as {
    handler: (a: unknown, ctx: unknown) => Promise<{ content: [{ type: 'text'; text: string }] }>;
  }).handler(args, {}).then((r) => JSON.parse(r.content[0].text));

describe('loop:status — ambient workspace transaction safety (EI-20229292848756531)', () => {
  it('opts out because the handler owns independent DB reads and never consumes ctx.tx', () => {
    expect((statusTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

describe('loop:status owner-scoped argument contract (EI-20232692935534790)', () => {
  it('makes the intentional owner-only scope explicit and rejects misleading harness input', () => {
    const tool = statusTool as unknown as {
      description?: string;
      guidance?: { when?: string };
      args: {
        safeParse: (value: unknown) => { success: boolean };
        shape: { ownerId?: { description?: string } };
      };
    };

    expect(tool.description).toMatch(/owner-scoped/i);
    expect(tool.description).toMatch(/does not take a `harness` argument/i);
    expect(tool.guidance?.when).toMatch(/do not pass `harness`/i);
    expect(tool.args.shape.ownerId?.description).toMatch(/owner-scoped/i);
    expect(tool.args.safeParse({ ownerId: 'another-owner' }).success).toBe(true);
    expect(tool.args.safeParse({ harness: 'papercusp' }).success).toBe(false);
  });
});

describe('loop:status return guidance matches the emitted loop record', () => {
  it('documents lastFiredAt, the field emitted by loop:status', async () => {
    const emitted = {
      active: true,
      intervalSec: 60,
      parked: false,
      nextFireAt: null,
      lastFiredAt: '2026-08-22T09:15:00.000Z',
    };
    getLoopStatusMock.mockResolvedValue(emitted);

    const out = await run();
    const returns = (statusTool as unknown as { guidance?: { returns?: string } }).guidance?.returns ?? '';

    expect(out.loop).toMatchObject(emitted);
    expect(returns).toContain('lastFiredAt');
    expect(returns).not.toMatch(/\blastFireAt\b/);
  });
});

beforeEach(() => {
  _resetStoreIdentityForTests();
  getLoopStatusMock.mockReset();
  listWakeAwaitsMock.mockReset();
  listWakeAwaitsMock.mockResolvedValue([]);
});

describe('loop:status store-identity delivery', () => {
  it('OMITS storeIdentityWarning when no violation is latched, loop null', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    pinOrVerifyStoreIdentity(OURS, 'postgresql://localhost:5432/papercusp');

    const out = await run();

    expect(out.ok).toBe(true);
    expect(out.loop).toBeNull();
    expect(out).not.toHaveProperty('storeIdentityWarning');
  });

  it('OMITS storeIdentityWarning when a violation IS latched but a loop row WAS found', async () => {
    getLoopStatusMock.mockResolvedValue({ active: false, intervalSec: 60 });
    pinOrVerifyStoreIdentity(OURS, 'postgresql://localhost:5432/papercusp');
    pinOrVerifyStoreIdentity(IMPOSTOR, 'postgresql://127.0.0.1:22060/papercusp');

    const out = await run();

    // A found row is trustworthy regardless — only the null/negative path is annotated.
    expect(out.loop).toEqual({ active: false, intervalSec: 60 });
    expect(out).not.toHaveProperty('storeIdentityWarning');
  });

  it('SURFACES storeIdentityWarning on a null loop when a violation is latched', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    pinOrVerifyStoreIdentity(OURS, 'postgresql://localhost:5432/papercusp');
    pinOrVerifyStoreIdentity(IMPOSTOR, 'postgresql://127.0.0.1:22060/papercusp');

    const out = await run();

    expect(out.ok).toBe(true);
    expect(out.loop).toBeNull();
    const w = out.storeIdentityWarning;
    expect(w).toBeTruthy();
    expect(w.severity).toBe('critical');
    // The exact wrong conclusion this exists to stop.
    expect(w.whatThisMeans).toMatch(/do not treat this loop:null as/i);
    expect(w.whatThisMeans).toMatch(/re-arm/i);
    expect(w.detail).toContain('22060');
  });

  it('leaks no credentials into the surfaced warning', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    pinOrVerifyStoreIdentity(OURS, 'postgresql://harness_admin:secret@localhost:5432/papercusp');
    pinOrVerifyStoreIdentity(IMPOSTOR, 'postgresql://harness_admin:secret@127.0.0.1:22060/papercusp');

    const out = await run();

    expect(JSON.stringify(out)).not.toContain('secret');
  });
});

describe('loop:status pendingAwaits (EI-19415169477907694)', () => {
  it('reports status:none when the caller holds no live non-inbox-wake await', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    listWakeAwaitsMock.mockResolvedValue([]);

    const out = await run();

    expect(out.pendingAwaits).toEqual({ status: 'none' });
  });

  it('reports status:found with a sample of event keys when awaits are live', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    listWakeAwaitsMock.mockResolvedValue([
      { eventKey: 'work-item:claimable', expiresTs: null, rootId: null },
      { eventKey: 'release:green:papercusp', expiresTs: null, rootId: null },
    ]);

    const out = await run();

    expect(out.pendingAwaits).toEqual({
      status: 'found',
      count: 2,
      sample: ['work-item:claimable', 'release:green:papercusp'],
    });
  });

  it('degrades to status:unknown (never "none") when the lookup fails — a failed lookup must not fabricate a measurement', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    listWakeAwaitsMock.mockRejectedValue(new Error('pg unavailable'));

    const out = await run();

    expect(out.pendingAwaits).toEqual({ status: 'unknown' });
  });

  it('is computed even when no loop is armed (a bare events:await with no loop still deserves this answer)', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    listWakeAwaitsMock.mockResolvedValue([{ eventKey: 'lock:grant:t1', expiresTs: null, rootId: null }]);

    const out = await run();

    expect(out.loop).toBeNull();
    expect(out.pendingAwaits).toEqual({ status: 'found', count: 1, sample: ['lock:grant:t1'] });
  });
});
