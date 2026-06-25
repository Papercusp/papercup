import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the flag read + the launch-fire so the doc-steward DISPATCH (P-008) is unit-testable
// without git-sync / the operator. The function dynamic-imports these; vi.mock intercepts the
// module either way.
const mockGetFlag = vi.fn();
const mockFire = vi.fn();
const mockSql = vi.fn();
vi.mock('@papercusp/flags/server', () => ({ getFlag: (...a: unknown[]) => mockGetFlag(...a) }));
vi.mock('@papercusp/flags', () => ({ FLAGS: { DOC_STEWARD: 'papercusp-doc-steward' } }));
vi.mock('../../blueprint/launch-blueprint', () => ({
  fireLaunchBlueprintForEvent: (...a: unknown[]) => mockFire(...a),
}));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: mockSql }) }));

import { dispatchDocStewardForDrift, type DriftedDoc } from './doc-steward-dispatch';

const docs: DriftedDoc[] = [
  // P-005: workItems (the change cause) rides along in the batch.
  { docId: 'agent-insights/a.mdx', anchorPaths: ['src/a.ts'], reason: 'src/a.ts changed', source: 'manual', workItems: ['WI-42'] },
  { docId: 'b.mdx', anchorPaths: ['src/b.ts', 'src/c.ts'], reason: 'src/b.ts changed', source: 'generated' },
];

describe('dispatchDocStewardForDrift (doc-steward P-008)', () => {
  beforeEach(() => {
    mockGetFlag.mockReset();
    mockFire.mockReset();
    mockSql.mockReset();
    mockSql.mockResolvedValue([{ n: '0' }]);
  });

  it('fires the `docs:drift` launch with the deduped drift batch when the flag is ON', async () => {
    mockGetFlag.mockResolvedValue(true);
    mockFire.mockResolvedValue({ blueprintId: 'doc-steward' });

    const dispatched = await dispatchDocStewardForDrift('h', 'ws-1', docs);

    expect(dispatched).toBe(true);
    expect(mockGetFlag).toHaveBeenCalledWith('papercusp-doc-steward', 'h');
    expect(mockFire).toHaveBeenCalledTimes(1);
    const [event, input] = mockFire.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('docs:drift');
    expect(input.installSlug).toBe('h');
    expect(input.workspaceId).toBe('ws-1');
    // the --doc-drift extra carries the serialized batch the doc-steward parses
    const extra = input.extra as string[];
    expect(extra[0]).toBe('--doc-drift');
    expect(JSON.parse(extra[1])).toEqual({ docs });
    // P-005: the change-cause work-item(s) ride along so the doc-steward knows WHY.
    expect(JSON.parse(extra[1]).docs[0].workItems).toEqual(['WI-42']);
    // the human kickoff names the docs
    expect(input.kickoff as string).toContain('agent-insights/a.mdx');
    expect(input.kickoff as string).toContain('b.mdx');
  });

  it('does NOT fire while an active doc-steward is already running for the harness', async () => {
    mockGetFlag.mockResolvedValue(true);
    mockSql.mockResolvedValue([{ n: '1' }]);

    const dispatched = await dispatchDocStewardForDrift('h', 'ws-1', docs);

    expect(dispatched).toBe(false);
    expect(mockFire).not.toHaveBeenCalled();
  });

  it('does NOT fire when the flag is OFF', async () => {
    mockGetFlag.mockResolvedValue(false);
    const dispatched = await dispatchDocStewardForDrift('h', 'ws-1', docs);
    expect(dispatched).toBe(false);
    expect(mockFire).not.toHaveBeenCalled();
  });

  it('does NOT fire (and never reads the flag) when there are no stale docs', async () => {
    const dispatched = await dispatchDocStewardForDrift('h', 'ws-1', []);
    expect(dispatched).toBe(false);
    expect(mockGetFlag).not.toHaveBeenCalled();
    expect(mockFire).not.toHaveBeenCalled();
  });

  it('is best-effort: a fire failure returns false instead of throwing (never wedges git-sync)', async () => {
    mockGetFlag.mockResolvedValue(true);
    mockFire.mockRejectedValue(new Error('invoke route down'));
    await expect(dispatchDocStewardForDrift('h', 'ws-1', docs)).resolves.toBe(false);
  });

  it('is best-effort: a flag-read failure returns false and never fires', async () => {
    mockGetFlag.mockRejectedValue(new Error('flags infra down'));
    await expect(dispatchDocStewardForDrift('h', 'ws-1', docs)).resolves.toBe(false);
    expect(mockFire).not.toHaveBeenCalled();
  });
});
