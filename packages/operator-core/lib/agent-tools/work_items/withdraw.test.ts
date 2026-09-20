/**
 * withdraw.test.ts — the work_items:withdraw HANDLER (frontier-remediation P-002).
 *
 * The item's own acceptance guard is "file, retract, then assert the item is absent from
 * work_items:claimable". These are mocked HANDLER unit tests (the house pattern for this
 * directory — see claimable.test.ts), so the "absent from claimable" half is pinned the
 * way that actually survives a refactor: the handler's written state is asserted against
 * the REAL `ISSUE_FAMILY_CLAIMABLE_STATES` allow-list, pulled with `vi.importActual` so the
 * module mock below cannot launder it. That is the true mechanism of exclusion — the
 * allow-list is `['open']`, so a `dropped` row is unservable by construction. If anyone
 * ever widens that constant to include the withdrawn terminal, this test goes red, which
 * is precisely the regression the acceptance criterion is about.
 *
 * The other half — "marks the claim withdrawn" — is the part nothing in the codebase did
 * before: no terminal path released the claim, so a retracted row stayed assigned to the
 * person who retracted it. Pinned here as an ORDERED composition, because a state flip
 * without the release is exactly the bug.
 *
 * Fixtures use the shared `workItemFixture` (a complete WorkItem with a Partial override
 * seam) rather than `as never`, so that when WorkItem gains a required field this file
 * fails at TYPECHECK instead of rotting invisibly into a fleet-wide gate red.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/work_items/withdraw.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../../work-items';
import { workItemFixture } from '../../testing/work-item-fixture';

const SETTLED = ['done', 'dropped', 'passed', 'deprecated', 'resolved', 'closed'];

vi.mock('../../work-items', () => ({
  getWorkItem: vi.fn(),
  setWorkItemState: vi.fn(),
  releaseWorkItem: vi.fn(),
  isSettledWorkItemState: (s: string | null | undefined) => !!s && SETTLED.includes(s),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'probe', workspaceId: 'ws-1' }),
}));
vi.mock('../../plan-items/agent-names', () => ({
  resolveAdoptedName: vi.fn(async () => null),
}));

import { getWorkItem, setWorkItemState, releaseWorkItem } from '../../work-items';
import tool from './withdraw';

const getM = vi.mocked(getWorkItem);
const setM = vi.mocked(setWorkItemState);
const relM = vi.mocked(releaseWorkItem);

/** The `bulkContent` envelope shape (see agent-tools/_bulk) — `{ data }`, not MCP `content`. */
type BulkOut = {
  results: { ok: boolean; id: string; error?: string; state?: string; previousAssignee?: string | null }[];
  counts: { ok: number; failed: number };
};

const run = async (args: unknown): Promise<BulkOut> =>
  ((await tool.handler(args as never, { ownerId: 'probe', workspaceId: 'ws-1' } as never)) as { data: BulkOut }).data;

/** A filed, open, self-held row — the thing a retraction acts on. */
const filed = (over: Partial<WorkItem> = {}): WorkItem =>
  workItemFixture({ id: 'WI-1', kind: 'bug', title: 'mistaken filing', state: 'open', assignee: 'probe', harness: 'h', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  getM.mockResolvedValue(filed());
  setM.mockResolvedValue(null);
  relM.mockResolvedValue(null);
});

describe('work_items:withdraw', () => {
  it('file → retract → the written state is absent from the REAL claimable allow-list', async () => {
    const out = await run({ id: 'WI-1', reason: 'premise falsified' });
    expect(out.counts).toMatchObject({ ok: 1, failed: 0 });

    const [, writtenState] = setM.mock.calls[0]!;
    expect(writtenState).toBe('dropped');

    // The mechanism of exclusion, read from the real module (not the mock above).
    const actual = await vi.importActual<typeof import('../../work-items')>('../../work-items');
    expect(actual.ISSUE_FAMILY_CLAIMABLE_STATES).toEqual(['open']);
    expect(actual.ISSUE_FAMILY_CLAIMABLE_STATES).not.toContain(writtenState);
  });

  it('marks the CLAIM withdrawn: releases it, after the state flip (a flip alone was the bug)', async () => {
    await run({ id: 'WI-1', reason: 'duplicate' });

    expect(setM).toHaveBeenCalledTimes(1);
    expect(relM).toHaveBeenCalledTimes(1);
    // Ordering is load-bearing: the terminal record must be attributed before the release.
    expect(setM.mock.invocationCallOrder[0]!).toBeLessThan(relM.mock.invocationCallOrder[0]!);
    expect(relM.mock.calls[0]![1]).toMatchObject({ releasingOwnerId: 'probe' });
  });

  it('never announces a withdrawn row as claimable on either write', async () => {
    await run({ id: 'WI-1', reason: 'wrong' });
    // Default true would fire the pool-wide wake toward a terminal, unservable row.
    expect(setM.mock.calls[0]![2]).toMatchObject({ announceClaimable: false });
    expect(relM.mock.calls[0]![1]).toMatchObject({ announceClaimable: false });
  });

  it('records WHY it was withdrawn, distinguishably from an ordinary drop', async () => {
    await run({ id: 'WI-1', reason: 'premise falsified by EI-123' });
    const opts = setM.mock.calls[0]![2] as { completionRef?: string };
    expect(opts.completionRef).toContain('withdrawn:');
    expect(opts.completionRef).toContain('premise falsified by EI-123');
  });

  it('refuses a peer-held item, and writes nothing', async () => {
    getM.mockResolvedValue(filed({ assignee: 'someone-else' }));
    const out = await run({ id: 'WI-1', reason: 'not mine' });

    expect(out.counts).toMatchObject({ ok: 0, failed: 1 });
    expect(out.results[0].error).toContain('someone-else');
    expect(setM).not.toHaveBeenCalled();
    expect(relM).not.toHaveBeenCalled();
  });

  it('force:true overrides a peer hold', async () => {
    getM.mockResolvedValue(filed({ assignee: 'someone-else' }));
    const out = await run({ id: 'WI-1', reason: 'stale filing', force: true });

    expect(out.counts).toMatchObject({ ok: 1, failed: 0 });
    expect(setM).toHaveBeenCalledTimes(1);
  });

  it('refuses an already-terminal item rather than overwriting its completion record', async () => {
    getM.mockResolvedValue(filed({ state: 'done', assignee: 'probe' }));
    const out = await run({ id: 'WI-1', reason: 'oops' });

    expect(out.counts).toMatchObject({ ok: 0, failed: 1 });
    expect(out.results[0].error).toContain('already terminal');
    expect(setM).not.toHaveBeenCalled();
  });

  it('reports not_found without writing', async () => {
    getM.mockResolvedValue(null);
    const out = await run({ id: 'WI-nope', reason: 'x' });

    expect(out.results[0]).toMatchObject({ ok: false, error: 'not_found' });
    expect(setM).not.toHaveBeenCalled();
  });

  it('withdraws many in one call', async () => {
    const out = await run({ ids: ['WI-1', 'WI-2', 'WI-3'], reason: 'batch of duplicates' });

    expect(out.counts).toMatchObject({ ok: 3, failed: 0 });
    expect(setM).toHaveBeenCalledTimes(3);
    expect(relM).toHaveBeenCalledTimes(3);
  });
});
