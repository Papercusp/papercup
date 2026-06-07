import { describe, it, expect } from 'vitest';
import { captureImprovement, storageKindOf, type CaptureDeps } from './capture-core';
import { IMPROVEMENT_TOPIC } from './read-items';
import type { CreateIssueInput, EngineerIssue } from '../../issues-engineer';

function existing(p: Partial<EngineerIssue> & { id: string; title: string }): EngineerIssue {
  return {
    kind: 'bug',
    scope: 'operator',
    body: '',
    severity: 'minor',
    source: 'su',
    state: 'open',
    assignee: null,
    assignedBy: null,
    assignedAt: null,
    payload: null,
    foundDuring: null,
    linkedFeatureId: null,
    createdBy: null,
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    createdAt: '2026-06-04T00:00:00Z',
    updatedAt: '2026-06-04T00:00:00Z',
    ...p,
  };
}

function deps(opts: { found?: EngineerIssue[] } = {}): CaptureDeps & { created: CreateIssueInput[] } {
  const created: CreateIssueInput[] = [];
  return {
    created,
    searchIssues: async () => opts.found ?? [],
    createIssue: async (input) => {
      created.push(input);
      return existing({ id: 'EI-100', title: input.title, kind: (input.kind as 'bug' | 'change') ?? 'bug' });
    },
  };
}

describe('storageKindOf — the native column mapping (close-loop D-002)', () => {
  it('bug → bug; change → change; feature → change (payload refinement)', () => {
    expect(storageKindOf('bug')).toBe('bug');
    expect(storageKindOf('change')).toBe('change');
    expect(storageKindOf('feature')).toBe('change');
  });
});

describe('captureImprovement — native kind + paths (close-loop D-002)', () => {
  it('writes the REAL kind column and a CLEAN title (no [kind] prefix)', async () => {
    const d = deps();
    const res = await captureImprovement({ title: 'presence list dumps stale rows', kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(d.created[0].kind).toBe('bug');
    expect(d.created[0].title).toBe('presence list dumps stale rows'); // no prefix
    expect(d.created[0].topics).toContain(IMPROVEMENT_TOPIC);
  });

  it('kind=feature stores as change + payload.improvementKind (engineer_issues kinds are bug|change|task)', async () => {
    const d = deps();
    await captureImprovement({ title: 'a net-new capability', kind: 'feature' }, d);
    expect(d.created[0].kind).toBe('change');
    expect(d.created[0].payload).toMatchObject({ improvementKind: 'feature' });
  });

  it('stores candidate paths in the payload (the protected-path gate feed)', async () => {
    const d = deps();
    await captureImprovement({ title: 'x y z broken', kind: 'bug', paths: ['libs/flags/src/types.ts'] }, d);
    expect(d.created[0].payload).toMatchObject({ paths: ['libs/flags/src/types.ts'] });
  });

  it('defaults severity by kind (bug → major, others → minor)', async () => {
    const d = deps();
    await captureImprovement({ title: 'broken thing one', kind: 'bug' }, d);
    await captureImprovement({ title: 'nicer thing two', kind: 'change' }, d);
    expect(d.created[0].severity).toBe('major');
    expect(d.created[1].severity).toBe('minor');
  });
});

describe('captureImprovement — search-first dedup (D-001)', () => {
  const dup = existing({ id: 'EI-7', title: 'presence list dumps stale rows', state: 'open' });

  it('declines a likely duplicate by default (link instead)', async () => {
    const d = deps({ found: [dup] });
    const res = await captureImprovement({ title: 'presence list dumps stale rows', kind: 'bug' }, d);
    expect(res.created).toBe(false);
    expect(res.reason).toBe('likely-duplicate');
    expect(res.possibleDuplicates[0].id).toBe('EI-7');
    expect(d.created).toHaveLength(0);
  });

  it('force overrides the decline', async () => {
    const d = deps({ found: [dup] });
    const res = await captureImprovement({ title: 'presence list dumps stale rows', kind: 'bug', force: true }, d);
    expect(res.created).toBe(true);
  });

  it('checkDuplicatesOnly never creates', async () => {
    const d = deps({ found: [dup] });
    const res = await captureImprovement({ title: 'presence list dumps stale rows', kind: 'bug', checkDuplicatesOnly: true }, d);
    expect(res.created).toBe(false);
    expect(d.created).toHaveLength(0);
  });

  it("dedupScope:'open' — a RESOLVED duplicate does NOT decline (a regression re-files)", async () => {
    const resolved = existing({ id: 'EI-7', title: 'presence list dumps stale rows', state: 'resolved' });
    const d = deps({ found: [resolved] });
    const res = await captureImprovement(
      { title: 'presence list dumps stale rows', kind: 'bug', dedupScope: 'open' },
      d,
    );
    expect(res.created).toBe(true);
    // ...but the dup is still REPORTED for visibility.
    expect(res.possibleDuplicates[0].id).toBe('EI-7');
  });

  it("dedupScope:'open' — an OPEN duplicate still declines", async () => {
    const d = deps({ found: [dup] });
    const res = await captureImprovement({ title: 'presence list dumps stale rows', kind: 'bug', dedupScope: 'open' }, d);
    expect(res.created).toBe(false);
  });

  it('an unrelated existing item does not decline', async () => {
    const d = deps({ found: [existing({ id: 'EI-8', title: 'completely different subject entirely' })] });
    const res = await captureImprovement({ title: 'presence list dumps stale rows', kind: 'bug' }, d);
    expect(res.created).toBe(true);
  });
});

describe('captureImprovement — "already decided" recall (self-learning P-003)', () => {
  it('surfaces a prior RESOLVED same-signature item as already-decided, with its reason', async () => {
    const decided = existing({
      id: 'EI-7',
      title: 'presence list dumps stale rows',
      state: 'resolved',
      payload: { decidedReason: 'fixed by the TTL sweep in PR-x' },
    });
    // dedupScope:'open' so the resolved dup does not BLOCK the create — we want to
    // assert the recall fires even on a created capture (it is recall, not a gate).
    const d = deps({ found: [decided] });
    const res = await captureImprovement(
      { title: 'stale rows dumps presence list', kind: 'bug', dedupScope: 'open' },
      d,
    );
    expect(res.created).toBe(true);
    expect(res.alreadyDecided?.[0]).toMatchObject({
      id: 'EI-7',
      matchKind: 'signature',
      reason: 'already decided: fixed by the TTL sweep in PR-x',
    });
  });

  it('does NOT recall when the only prior same-signature item is OPEN', async () => {
    const open = existing({ id: 'EI-7', title: 'presence list dumps stale rows', state: 'open' });
    const d = deps({ found: [open] });
    const res = await captureImprovement(
      { title: 'stale rows dumps presence list', kind: 'bug', force: true },
      d,
    );
    expect(res.created).toBe(true);
    expect(res.alreadyDecided).toBeUndefined();
  });
});

describe('captureImprovement — P-010 source-tag and per-Hive scope', () => {
  it('stores sourceRole in payload when not human (P-010 source-tag)', async () => {
    const d = deps();
    const res = await captureImprovement({ title: 'broken watchdog signal', kind: 'bug', sourceRole: 'system' }, d);
    expect(res.created).toBe(true);
    expect(d.created[0].payload).toMatchObject({ sourceRole: 'system' });
  });

  it('does not store sourceRole in payload when human (default)', async () => {
    const d = deps();
    const res = await captureImprovement({ title: 'broken thing', kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(d.created[0].payload?.sourceRole).toBeUndefined();
  });

  it('adds improvement-source topic tag when sourceRole is Queen or bee (P-010)', async () => {
    const d1 = deps();
    await captureImprovement({ title: 'queen-filed idea', kind: 'bug', sourceRole: 'Queen' }, d1);
    expect(d1.created[0].topics).toContain('improvement-source:Queen');

    const d2 = deps();
    await captureImprovement({ title: 'bee-filed idea', kind: 'bug', sourceRole: 'bee' }, d2);
    expect(d2.created[0].topics).toContain('improvement-source:bee');
  });

  it('respects per-Hive scope (harness:<slug>) alongside sourceRole (P-010)', async () => {
    const d = deps();
    const res = await captureImprovement({
      title: 'harness-specific bug',
      kind: 'bug',
      scope: 'harness:sheets',
      sourceRole: 'bee',
    }, d);
    expect(res.created).toBe(true);
    expect(d.created[0].scope).toBe('harness:sheets');
    expect(d.created[0].payload?.sourceRole).toBe('bee');
  });
});
