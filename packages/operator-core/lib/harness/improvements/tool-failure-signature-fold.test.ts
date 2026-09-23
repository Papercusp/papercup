import { describe, expect, it, vi } from 'vitest';

// Every storage seam (sql, merge, resolve) is injected below; nothing here reaches PG.
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

import { foldLegacyToolFailureRows, legacySignatureOf, type SignatureFoldDeps } from './tool-failure-signature-fold';
import { normalizeSuspectedToolFailure, toolFailureSignatureKey, type SuspectedToolFailure } from './tool-error-classifier';
import { metadataToolFailure } from '../../agent-tools/plans/coordination-metadata-fixtures';

/** A legacy per-build automatic row, exactly as the pre-D-010 path filed it. */
function legacy(id: string, build: string, repeatCount: number, extra: Record<string, unknown> = {},
  failure: Partial<SuspectedToolFailure> = {}) {
  const report = { ...metadataToolFailure, runtimeVersion: build, ...failure };
  const normalized = normalizeSuspectedToolFailure(report);
  return {
    id, harness_slug: 'papercusp', origin: 'organic',
    payload: {
      lane: 'observation', watchdogKey: normalized.classKey, repeatCount,
      toolFailureProbation: { ...normalized, watchdogKey: normalized.classKey, state: 'probation',
        reporters: [`su-${id}`], firstSeenAt: '2026-09-20T00:00:00Z', lastSeenAt: `2026-09-2${repeatCount % 10}T00:00:00Z`,
        report },
      toolInvocation: { workspaceId: 'ws' },
      ...extra,
    } as Record<string, unknown>,
  };
}

function harness(legacyRows: ReturnType<typeof legacy>[], existing: ReturnType<typeof legacy> | null = null,
  opts: { failMergeFor?: string } = {}) {
  const merges: Array<[string, Record<string, unknown>]> = [];
  const resolved: string[] = [];
  const deps: SignatureFoldDeps = {
    sql: { unsafe: async (text: string) => text.includes("NOT LIKE 'tool-failure-signature:%'")
      ? legacyRows : (existing ? [existing] : []) } as never,
    mergeIssuePayload: async (id, patch) => {
      if (id === opts.failMergeFor) throw new Error('merge refused');
      merges.push([id, patch]);
    },
    resolveDuplicate: async (id) => { resolved.push(id); },
  };
  return { deps, merges, resolved };
}

const SIGNATURE = toolFailureSignatureKey(metadataToolFailure, 'caller');

describe('foldLegacyToolFailureRows (review-system-rework-reduction D-010)', () => {
  it('reads the signature a legacy row would have been filed under', () => {
    expect(legacySignatureOf(legacy('EI-1', 'b1', 1).payload)).toBe(SIGNATURE);
    expect(legacySignatureOf({ lane: 'observation' })).toBeNull();
  });

  it('folds per-build rows onto the newest one, re-keyed, with summed counts and per-class tally', async () => {
    const rows = [legacy('EI-3', 'b3', 5), legacy('EI-2', 'b2', 3), legacy('EI-1', 'b1', 2),
      legacy('EI-9', 'b1', 4, {}, { toolName: 'coord:inbox' })];
    const h = harness(rows);
    const result = await foldLegacyToolFailureRows('ws', h.deps);
    expect(result).toEqual({ scanned: 4, groups: 2, folded: 2, rekeyed: 2, failedGroups: 0 });
    const survivor = h.merges.find(([id]) => id === 'EI-3')![1];
    expect(survivor).toMatchObject({ watchdogKey: SIGNATURE, repeatCount: 10,
      toolFailureProbation: { watchdogKey: SIGNATURE, signatureKey: SIGNATURE, deployedRevision: 'b3',
        reporters: ['su-EI-3'], state: 'probation' } });
    const classes = Object.values((survivor.toolFailureSignature as { classes: Record<string, { count: number }> }).classes);
    expect(classes.map((c) => c.count).sort()).toEqual([2, 3, 5]);
    for (const loser of ['EI-2', 'EI-1']) {
      expect(h.merges.find(([id]) => id === loser)![1]).toMatchObject({ signatureFoldedInto: 'EI-3',
        decidedReason: expect.stringContaining('duplicate of EI-3') });
    }
    expect(h.resolved.sort()).toEqual(['EI-1', 'EI-2']);
    // The other tool is its own signature: re-keyed alone, nothing resolved.
    expect(h.merges.find(([id]) => id === 'EI-9')![1]).toMatchObject({ repeatCount: 4 });
  });

  it('folds onto an existing signature row without re-keying it and keeps its tally', async () => {
    const existing = legacy('EI-SIG', 'b9', 7);
    existing.payload.watchdogKey = SIGNATURE;
    existing.payload.toolFailureSignature = { signatureKey: SIGNATURE, classes: { 'live-class': {
      reporters: ['su-live'], count: 7, firstSeenAt: '2026-09-23T00:00:00Z', lastSeenAt: '2026-09-23T01:00:00Z',
      contractFingerprint: 'c', deployedRevision: 'b9' } } };
    const h = harness([legacy('EI-1', 'b1', 2)], existing);
    expect(await foldLegacyToolFailureRows('ws', h.deps)).toMatchObject({ folded: 1, rekeyed: 0 });
    const patch = h.merges.find(([id]) => id === 'EI-SIG')![1];
    expect(patch.repeatCount).toBe(9);
    expect(Object.keys((patch.toolFailureSignature as { classes: object }).classes)).toHaveLength(2);
    expect(h.resolved).toEqual(['EI-1']);
  });

  it('only re-resolves a row an interrupted fold already marked, without counting it twice', async () => {
    const existing = legacy('EI-SIG', 'b9', 7);
    existing.payload.watchdogKey = SIGNATURE;
    const h = harness([legacy('EI-1', 'b1', 2, { signatureFoldedInto: 'EI-SIG' })], existing);
    await foldLegacyToolFailureRows('ws', h.deps);
    expect(h.merges.find(([id]) => id === 'EI-SIG')![1].repeatCount).toBe(7);
    expect(h.merges.find(([id]) => id === 'EI-1')).toBeUndefined();
    expect(h.resolved).toEqual(['EI-1']);
  });

  it('a failing group is left for the next tick and does not abort the others', async () => {
    const rows = [legacy('EI-3', 'b3', 5), legacy('EI-9', 'b1', 4, {}, { toolName: 'coord:inbox' })];
    const h = harness(rows, null, { failMergeFor: 'EI-3' });
    expect(await foldLegacyToolFailureRows('ws', h.deps)).toMatchObject({ groups: 2, failedGroups: 1, rekeyed: 1 });
    expect(h.merges.map(([id]) => id)).toEqual(['EI-9']);
    expect(h.resolved).toEqual([]);
  });
});
