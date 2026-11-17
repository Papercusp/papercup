/**
 * EI-19397599078921465 — the unified lifecycle READ.
 *
 * These tests are weighted toward the ABSENCE semantics rather than the happy-path merge,
 * because the bug this module closes was never a merge failure: it was an empty result read
 * as an answer. `coverage` is what makes that misreading impossible, so `coverage` is what is
 * pinned hardest here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unsafe = vi.fn();

// Defensive partial mock (EI-362 / EI-14928): a bare factory that returns ONLY getOrgPg
// silently breaks the moment anything in the import graph reaches for another db-org export,
// and the failure surfaces at an unrelated call site. Spread the real module.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: { unsafe } }),
}));

const { getWorkItemLifecycleHistory } = await import('./work-item-lifecycle-history');

const WS = 'papercusp-workspace';

beforeEach(() => {
  unsafe.mockReset();
  unsafe.mockResolvedValue([]);
});

describe('getWorkItemLifecycleHistory', () => {
  it('merges audit_log and payload.reopenHistory into ONE newest-first timeline', async () => {
    unsafe.mockResolvedValue([
      { ts: 3_000, actor: 'su-aaa', action: 'work_items:claim_hold:set', details: { reason: 'blocked' } },
      { ts: 1_000, actor: 'su-bbb', action: 'work_items:claim_hold:clear', details: {} },
    ]);
    const out = await getWorkItemLifecycleHistory({
      id: 'WI-1',
      workspaceId: WS,
      family: 'issue',
      payload: {
        reopenHistory: [{ at: new Date(2_000).toISOString(), by: 'su-ccc', force: true, prevState: 'done' }],
      },
    });

    expect(out.events.map((e) => e.atMs)).toEqual([3_000, 2_000, 1_000]);
    expect(out.events.map((e) => e.source)).toEqual(['audit_log', 'reopenHistory', 'audit_log']);
    expect(out.coverage.auditRows).toBe(2);
    expect(out.coverage.reopenEntries).toBe(1);
    expect(out.coverage.degraded).toBe(false);
  });

  it("classifies an issue-family block as 'blocked', not 'held' — it reaches audit_log only as a claim-hold side effect", async () => {
    unsafe.mockResolvedValue([
      { ts: 2_000, actor: 'su-aaa', action: 'work_items:claim_hold:set', details: { reason: 'blocked' } },
      { ts: 1_000, actor: 'su-aaa', action: 'work_items:claim_hold:set', details: { reason: 'leader gating release' } },
    ]);
    const out = await getWorkItemLifecycleHistory({ id: 'WI-1', workspaceId: WS, family: 'issue' });

    // Same action, different meaning — surfacing both as `held` would hide every
    // issue-family block, which is the exact question this module answers.
    expect(out.events[0]?.kind).toBe('blocked');
    expect(out.events[1]?.kind).toBe('held');
  });

  it('reports a reopen with its force flag preserved', async () => {
    const out = await getWorkItemLifecycleHistory({
      id: 'WI-1',
      workspaceId: WS,
      family: 'change',
      payload: {
        reopenHistory: [
          { at: new Date(5_000).toISOString(), by: 'su-x', force: true, prevState: 'done', terminalOwner: 'su-y' },
        ],
      },
    });
    expect(out.events[0]).toMatchObject({
      kind: 'reopened',
      by: 'su-x',
      source: 'reopenHistory',
      detail: { force: true, prevState: 'done', terminalOwner: 'su-y' },
    });
  });

  it('passes an UNKNOWN reopenHistory field through instead of dropping it', async () => {
    // reopenHistory is actively growing (EI-19393880133572803 archives _completionEvidence
    // into these entries). A hardcoded key list would drop each new field as it lands —
    // the same "recorded but unsurfaced" defect this module exists to end, one layer down.
    const out = await getWorkItemLifecycleHistory({
      id: 'WI-1',
      workspaceId: WS,
      family: 'change',
      payload: {
        reopenHistory: [
          {
            at: new Date(1_000).toISOString(),
            by: 'su-x',
            prevState: 'done',
            _completionEvidence: { summary: 'archived by a later change' },
          },
        ],
      },
    });
    expect(out.events[0]?.detail).toMatchObject({
      prevState: 'done',
      _completionEvidence: { summary: 'archived by a later change' },
    });
    // `at`/`by` are lifted to typed event fields and must not be restated in `detail`.
    expect(out.events[0]?.detail).not.toHaveProperty('at');
    expect(out.events[0]?.detail).not.toHaveProperty('by');
    // An absent `force` still normalizes to a strict boolean — readers branch on it.
    expect(out.events[0]?.detail?.force).toBe(false);
  });

  it('ALWAYS reports what is not recorded, even when the timeline is non-empty', async () => {
    unsafe.mockResolvedValue([{ ts: 1_000, actor: 'su-a', action: 'work_items:claim_hold:set', details: {} }]);
    const out = await getWorkItemLifecycleHistory({ id: 'WI-1', workspaceId: WS, family: 'issue' });
    expect(out.coverage.notRecorded.length).toBeGreaterThan(0);
    expect(out.coverage.notRecorded.join(' ')).toMatch(/non-terminal/i);
  });

  it('names the feature-family gap specifically — a caveat that is true, not merely cautious', async () => {
    const issue = await getWorkItemLifecycleHistory({ id: 'WI-1', workspaceId: WS, family: 'issue' });
    const feature = await getWorkItemLifecycleHistory({ id: 'F-1', workspaceId: WS, family: 'feature' });

    expect(feature.coverage.notRecorded.join(' ')).toMatch(/feature-family/i);
    expect(issue.coverage.notRecorded.join(' ')).not.toMatch(/feature-family/i);
    expect(issue.coverage.notRecorded.join(' ')).toMatch(/needs-human/i);
  });

  it("distinguishes 'could not read' from 'nothing there' — the distinction the original bug turned on", async () => {
    unsafe.mockRejectedValue(new Error('connection refused'));
    const out = await getWorkItemLifecycleHistory({
      id: 'WI-1',
      workspaceId: WS,
      family: 'issue',
      payload: { reopenHistory: [{ at: new Date(1_000).toISOString(), by: 'su-x' }] },
    });

    expect(out.coverage.degraded).toBe(true);
    // The surviving source is still returned — a partial answer beats none, provided the
    // caller is told it is partial.
    expect(out.events).toHaveLength(1);
    expect(out.events[0]?.source).toBe('reopenHistory');
  });

  it('never fabricates an actor: the schema default and the writer sentinel both read as unrecorded', async () => {
    unsafe.mockResolvedValue([
      { ts: 3_000, actor: 'system', action: 'work_items:claim_hold:set', details: {} },
      { ts: 2_000, actor: 'user', action: 'work_items:claim_hold:clear', details: {} },
      { ts: 1_000, actor: 'su-real', action: 'work_items:claim_hold:set', details: {} },
    ]);
    const out = await getWorkItemLifecycleHistory({ id: 'WI-1', workspaceId: WS, family: 'issue' });
    expect(out.events.map((e) => e.by)).toEqual([null, null, 'su-real']);
  });

  it('keeps an unrecognized action in the timeline instead of dropping it', async () => {
    unsafe.mockResolvedValue([{ ts: 1_000, actor: 'su-a', action: 'work_items:some_future_verb', details: {} }]);
    const out = await getWorkItemLifecycleHistory({ id: 'WI-1', workspaceId: WS, family: 'issue' });
    expect(out.events).toHaveLength(1);
    expect(out.events[0]?.kind).toBe('other');
    expect(out.events[0]?.action).toBe('work_items:some_future_verb');
  });

  it('surfaces the new feature-family blocked audit row as a block', async () => {
    unsafe.mockResolvedValue([
      {
        ts: 1_000,
        actor: 'su-a',
        action: 'work_items:state:blocked',
        details: { from: 'open', to: 'blocked', family: 'feature' },
      },
    ]);
    const out = await getWorkItemLifecycleHistory({ id: 'F-1', workspaceId: WS, family: 'feature' });
    expect(out.events[0]?.kind).toBe('blocked');
    expect(out.events[0]?.detail).toMatchObject({ from: 'open', to: 'blocked' });
  });

  it('reads the current flags, accepting _claimHold as boolean or the string the jsonb merge writes', async () => {
    const stringy = await getWorkItemLifecycleHistory({
      id: 'WI-1',
      workspaceId: WS,
      family: 'issue',
      payload: { _claimHold: 'true', needsHuman: true, held_open_by: 'su-a', held_open_reason: 'blocked' },
    });
    expect(stringy.flags).toEqual({
      needsHuman: true,
      claimHold: true,
      heldOpenBy: 'su-a',
      heldOpenReason: 'blocked',
    });

    const boolish = await getWorkItemLifecycleHistory({
      id: 'WI-1',
      workspaceId: WS,
      family: 'issue',
      payload: { _claimHold: true },
    });
    expect(boolish.flags.claimHold).toBe(true);
    expect(boolish.flags.needsHuman).toBe(false);
  });

  it('tolerates a malformed payload without failing the read it decorates', async () => {
    const out = await getWorkItemLifecycleHistory({
      id: 'WI-1',
      workspaceId: WS,
      family: 'issue',
      payload: { reopenHistory: ['not-an-object', { at: 'not-a-date' }, null] },
    });
    expect(out.events).toEqual([]);
    // The raw entry count is still reported, so "3 entries, none parseable" stays visible
    // rather than looking like an item with no reopen history at all.
    expect(out.coverage.reopenEntries).toBe(3);
  });

  it('caps the returned timeline', async () => {
    unsafe.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        ts: 1_009 - i,
        actor: 'su-a',
        action: 'work_items:claim_hold:set',
        details: {},
      })),
    );
    const out = await getWorkItemLifecycleHistory({ id: 'WI-1', workspaceId: WS, family: 'issue', limit: 3 });
    expect(out.events).toHaveLength(3);
    expect(out.events[0]?.atMs).toBe(1_009);
    expect(out.coverage.truncated).toBe(true);
    expect(out.coverage.notRecorded.join(' ')).toMatch(/omitted by the display limit of 3/);
    expect(unsafe.mock.calls[0]?.[0]).toContain('ORDER BY ts DESC, id DESC');
    expect(unsafe.mock.calls[0]?.[1]).toEqual([WS, 'WI-1', 4]);
  });

  it('does not report omission when the audit result exactly fills the limit', async () => {
    unsafe.mockResolvedValue(Array.from({ length: 7 }, (_, i) => ({
      ts: 7_000 - i, actor: 'su-a', action: 'work_items:claim_hold:set', details: {},
    })));
    const out = await getWorkItemLifecycleHistory({ id: 'WI-1', workspaceId: WS, limit: 7 });
    expect(out.events).toHaveLength(7);
    expect(out.coverage).toMatchObject({ auditRows: 7, truncated: false, invalidEntries: 0, degraded: false });
    expect(unsafe.mock.calls[0]?.[1]).toEqual([WS, 'WI-1', 8]);
  });

  it('reports omission when merging retained reopen entries exceeds the limit', async () => {
    unsafe.mockResolvedValue([{ ts: 1_000, actor: 'su-a', action: 'work_items:claim_hold:set', details: {} }]);
    const out = await getWorkItemLifecycleHistory({
      id: 'WI-1', workspaceId: WS, limit: 2,
      payload: { reopenHistory: [2_000, 3_000].map(ms => ({ at: new Date(ms).toISOString() })) },
    });
    expect(out.events.map(event => event.atMs)).toEqual([3_000, 2_000]);
    expect(out.coverage).toMatchObject({ auditRows: 1, reopenEntries: 2, truncated: true });
  });

  it('marks invalid audit timestamps as degraded while preserving valid evidence', async () => {
    unsafe.mockResolvedValue([
      { ts: 'invalid', actor: 'su-a', action: 'work_items:claim_hold:set' },
      { ts: 9e15, actor: 'su-a', action: 'work_items:claim_hold:set' },
      { ts: '', actor: 'su-a', action: 'work_items:claim_hold:set' },
      { ts: null, actor: 'su-a', action: 'work_items:claim_hold:set' },
      { ts: 1_000, actor: 'su-a', action: 'work_items:claim_hold:set' },
    ]);
    const out = await getWorkItemLifecycleHistory({ id: 'WI-1', workspaceId: WS });
    expect(out.events.map(event => event.atMs)).toEqual([1_000]);
    expect(out.coverage).toMatchObject({ invalidEntries: 4, degraded: true, truncated: false });
  });

  it('distinguishes malformed reopen evidence from an empty source', async () => {
    for (const reopenHistory of [{ replaced: true }, [null, 'invalid', { at: 'invalid' }]]) {
      const out = await getWorkItemLifecycleHistory({ id: 'WI-1', workspaceId: WS, payload: { reopenHistory } });
      expect(out.events).toEqual([]);
      expect(out.coverage.degraded).toBe(true);
      expect(out.coverage.invalidEntries).toBeGreaterThan(0);
    }
    const empty = await getWorkItemLifecycleHistory({ id: 'WI-1', workspaceId: WS });
    expect(empty.coverage).toMatchObject({ invalidEntries: 0, degraded: false });
  });

  it.each([NaN, Infinity, -Infinity])('uses a finite default for invalid limit %s', async limit => {
    const out = await getWorkItemLifecycleHistory({ id: 'WI-1', workspaceId: WS, limit });
    expect(unsafe.mock.calls[0]?.[1]).toEqual([WS, 'WI-1', 51]);
    expect(out.coverage.degraded).toBe(false);
  });
});
