import { describe, it, expect } from 'vitest';
import { captureImprovement, storageKindOf, type CaptureDeps } from './capture-core';
import { IMPROVEMENT_TOPIC, OBSERVATION_TOPIC } from './read-items';
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
    signalOrigin: 'organic',
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

describe('captureImprovement — filer-role attribution (close-observation-attribution-gap 2026-06-21)', () => {
  it('stamps payload.filedByRole on an observation when given (fixes the ~100% unknown bucket)', async () => {
    const d = deps();
    await captureImprovement(
      { title: 'hive-coordination-health scorecard', kind: 'change', lane: 'observation', filedByRole: 'kettle' },
      d,
    );
    expect((d.created[0].payload as Record<string, unknown>).filedByRole).toBe('kettle');
  });

  it('stamps payload.filedByRole on an improvement too', async () => {
    const d = deps();
    await captureImprovement({ title: 'docs:search friction', kind: 'bug', filedByRole: 'cup' }, d);
    expect((d.created[0].payload as Record<string, unknown>).filedByRole).toBe('cup');
  });

  it('omits filedByRole when not provided (no empty stamp)', async () => {
    const d = deps();
    await captureImprovement({ title: 'x', kind: 'change', lane: 'observation' }, d);
    expect((d.created[0].payload as Record<string, unknown> | undefined)?.filedByRole).toBeUndefined();
  });
});

describe('captureImprovement — observation lane (turn-end-reflection-observations-2026-06-14 D-005)', () => {
  it('files the OBSERVATION topic, NOT the improvement topic (invisible to the work pipeline)', async () => {
    const d = deps();
    const res = await captureImprovement(
      { title: 'docs:search returned stale results', kind: 'change', lane: 'observation' },
      d,
    );
    expect(res.created).toBe(true);
    expect(d.created[0].topics).toContain(OBSERVATION_TOPIC);
    expect(d.created[0].topics).not.toContain(IMPROVEMENT_TOPIC);
  });

  it('always stores as a non-bug nit + marks payload.lane (never auto-implement-eligible)', async () => {
    const d = deps();
    await captureImprovement({ title: 'x', kind: 'bug', lane: 'observation' }, d); // kind=bug is IGNORED for observations
    expect(d.created[0].kind).toBe('change');
    expect(d.created[0].severity).toBe('nit');
    expect(d.created[0].payload).toMatchObject({ lane: 'observation' });
  });

  it('carries NO auto-implement lifecycle / paths (it is never dispatchable)', async () => {
    const d = deps();
    await captureImprovement({ title: 'x', kind: 'change', lane: 'observation', paths: ['libs/x/y.ts'] }, d);
    const payload = d.created[0].payload as Record<string, unknown> | undefined;
    expect(payload?.ideaLifecycle).toBeUndefined();
    expect(payload?.paths).toBeUndefined();
  });

  it('SKIPS dedup — a recurring observation re-files even when a similar one exists (recurrence IS the signal)', async () => {
    const d = deps({ found: [existing({ id: 'EI-9', title: 'docs:search returned stale results' })] });
    const res = await captureImprovement(
      { title: 'docs:search returned stale results', kind: 'change', lane: 'observation' },
      d,
    );
    expect(res.created).toBe(true); // NOT declined as a likely-duplicate
    expect(d.created).toHaveLength(1);
  });

  it('merges the structured observation record via payloadExtra', async () => {
    const d = deps();
    await captureImprovement(
      {
        title: 'validator loop is confusing',
        kind: 'change',
        lane: 'observation',
        payloadExtra: { observation: { kind: 'friction', scope: 'role', confidence: 'med' } },
      },
      d,
    );
    expect(d.created[0].payload).toMatchObject({
      lane: 'observation',
      observation: { kind: 'friction', scope: 'role', confidence: 'med' },
    });
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

  it('adds improvement-source topic tag when sourceRole is Queen or cup (P-010)', async () => {
    const d1 = deps();
    await captureImprovement({ title: 'queen-filed idea', kind: 'bug', sourceRole: 'Queen' }, d1);
    expect(d1.created[0].topics).toContain('improvement-source:Queen');

    const d2 = deps();
    await captureImprovement({ title: 'cup-filed idea', kind: 'bug', sourceRole: 'cup' }, d2);
    expect(d2.created[0].topics).toContain('improvement-source:cup');
  });

  it('respects per-Hive scope (harness:<slug>) alongside sourceRole (P-010)', async () => {
    const d = deps();
    const res = await captureImprovement({
      title: 'harness-specific bug',
      kind: 'bug',
      scope: 'harness:sheets',
      sourceRole: 'cup',
    }, d);
    expect(res.created).toBe(true);
    expect(d.created[0].scope).toBe('harness:sheets');
    expect(d.created[0].payload?.sourceRole).toBe('cup');
  });
});

describe('captureImprovement — watchdogKey-aware dedup (watchdog-audit P-004 / D-001)', () => {
  it('stamps payload.watchdogKey on the created item', async () => {
    const d = deps();
    const res = await captureImprovement(
      { title: 'Test failing repeatedly: lib/a.test.ts', kind: 'bug', watchdogKey: 'red-test:lib/a.test.ts' },
      d,
    );
    expect(res.created).toBe(true);
    expect(d.created[0].payload).toMatchObject({ watchdogKey: 'red-test:lib/a.test.ts' });
  });

  it('stamps payload.findingClass — the taxonomy slug the rails route/count by (frontier P-044)', async () => {
    const d = deps();
    const res = await captureImprovement(
      {
        title: 'Resolution gap: plans searches for "x-2026-06-06" zero-hit although it exists',
        kind: 'bug',
        watchdogKey: 'negative-space:plans:x-2026-06-06',
        findingClass: 'negative-space:resolution-gap',
      },
      d,
    );
    expect(res.created).toBe(true);
    expect(d.created[0].payload).toMatchObject({ findingClass: 'negative-space:resolution-gap' });
  });

  it('a title-similar candidate with a DIFFERENT watchdogKey never declines (the subset-title edge)', async () => {
    // The nested-path shape: "lib/deep/a.test.ts" token-subsets "lib/a.test.ts"-style
    // titles enough to clear the Jaccard bar, but the keys differ — distinct signals.
    const other = existing({
      id: 'EI-9',
      title: 'Test failing repeatedly: packages/x/lib/sub/a.test.ts',
      state: 'open',
      payload: { watchdogKey: 'red-test:packages/x/lib/sub/a.test.ts' },
    });
    const d = deps({ found: [other] });
    const res = await captureImprovement(
      {
        title: 'Test failing repeatedly: packages/x/lib/sub/a.test.ts and more packages/x/lib',
        kind: 'bug',
        dedupScope: 'open',
        watchdogKey: 'red-test:packages/x/lib/sub-other/a.test.ts',
      },
      d,
    );
    expect(res.created).toBe(true);
  });

  it('a candidate WITHOUT a key stays in the net (legacy items still dedup)', async () => {
    const legacy = existing({ id: 'EI-9', title: 'Test failing repeatedly: lib/a.test.ts', state: 'open', payload: null });
    const d = deps({ found: [legacy] });
    const res = await captureImprovement(
      { title: 'Test failing repeatedly: lib/a.test.ts', kind: 'bug', dedupScope: 'open', watchdogKey: 'red-test:lib/a.test.ts' },
      d,
    );
    expect(res.created).toBe(false);
    expect(res.reason).toBe('likely-duplicate');
  });
});

describe('captureImprovement — resolved-dup evidence gate (watchdog-audit P-005 / D-002)', () => {
  const resolvedAt = '2026-06-09T00:00:00.000Z';
  const resolvedDup = existing({
    id: 'EI-7',
    title: 'presence list dumps stale rows',
    state: 'resolved',
    updatedAt: resolvedAt,
  });

  it("dedupScope:'open' + evidence OLDER than the resolution → declined as stale-evidence", async () => {
    const d = deps({ found: [resolvedDup] });
    const res = await captureImprovement(
      {
        title: 'presence list dumps stale rows',
        kind: 'bug',
        dedupScope: 'open',
        evidenceAt: '2026-06-08T00:00:00.000Z', // pre-fix lookback evidence
      },
      d,
    );
    expect(res.created).toBe(false);
    expect(res.reason).toBe('stale-evidence');
    expect(d.created).toHaveLength(0);
  });

  it("dedupScope:'open' + evidence NEWER than the resolution → re-files (real regression)", async () => {
    const d = deps({ found: [resolvedDup] });
    const res = await captureImprovement(
      {
        title: 'presence list dumps stale rows',
        kind: 'bug',
        dedupScope: 'open',
        evidenceAt: '2026-06-09T12:00:00.000Z',
      },
      d,
    );
    expect(res.created).toBe(true);
  });

  it('no evidenceAt (live-state signal) keeps the old regression semantics — re-file', async () => {
    const d = deps({ found: [resolvedDup] });
    const res = await captureImprovement(
      { title: 'presence list dumps stale rows', kind: 'bug', dedupScope: 'open' },
      d,
    );
    expect(res.created).toBe(true);
  });

  it('an unparseable resolution timestamp fails open (re-file beats suppressing a regression)', async () => {
    const weird = existing({ id: 'EI-7', title: 'presence list dumps stale rows', state: 'resolved', updatedAt: 'not-a-date' });
    const d = deps({ found: [weird] });
    const res = await captureImprovement(
      { title: 'presence list dumps stale rows', kind: 'bug', dedupScope: 'open', evidenceAt: '2026-06-08T00:00:00.000Z' },
      d,
    );
    expect(res.created).toBe(true);
  });
});

describe('captureImprovement — signal provenance (frontier P-002 / D-002)', () => {
  it('writes signal_origin=organic by default', async () => {
    const d = deps();
    const res = await captureImprovement({ title: 'a real friction', kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(d.created[0].signalOrigin).toBe('organic');
  });

  it('passes a frontier origin through to the column (drill)', async () => {
    const d = deps();
    const res = await captureImprovement({ title: 'planted flaky test', kind: 'bug', origin: 'drill' }, d);
    expect(res.created).toBe(true);
    expect(d.created[0].signalOrigin).toBe('drill');
  });

  it('an OPEN organic duplicate never declines a drill capture (the drill must file)', async () => {
    const organicDup = existing({ id: 'EI-7', title: 'presence list dumps stale rows', state: 'open' });
    const d = deps({ found: [organicDup] });
    const res = await captureImprovement(
      { title: 'presence list dumps stale rows', kind: 'bug', origin: 'drill' },
      d,
    );
    expect(res.created).toBe(true);
    expect(res.possibleDuplicates).toHaveLength(0); // cross-origin rows are not even surfaced
  });

  it('an OPEN drill duplicate never declines an ORGANIC capture (synthetic must not suppress real)', async () => {
    const drillDup = existing({
      id: 'EI-7',
      title: 'presence list dumps stale rows',
      state: 'open',
      signalOrigin: 'drill',
    });
    const d = deps({ found: [drillDup] });
    const res = await captureImprovement({ title: 'presence list dumps stale rows', kind: 'bug' }, d);
    expect(res.created).toBe(true);
  });

  it('same-origin dedup still declines (drill vs drill)', async () => {
    const drillDup = existing({
      id: 'EI-7',
      title: 'presence list dumps stale rows',
      state: 'open',
      signalOrigin: 'drill',
    });
    const d = deps({ found: [drillDup] });
    const res = await captureImprovement(
      { title: 'presence list dumps stale rows', kind: 'bug', origin: 'drill' },
      d,
    );
    expect(res.created).toBe(false);
    expect(res.reason).toBe('likely-duplicate');
  });

  it('already-decided recall is origin-scoped: a decided REPLAY row is not recalled for an organic capture', async () => {
    const decidedReplay = existing({
      id: 'EI-7',
      title: 'presence list dumps stale rows',
      state: 'resolved',
      signalOrigin: 'replay',
      payload: { decidedReason: 'replay counterfactual outcome — not a live decision' },
    });
    const d = deps({ found: [decidedReplay] });
    const res = await captureImprovement(
      { title: 'stale rows dumps presence list', kind: 'bug', dedupScope: 'open' },
      d,
    );
    expect(res.created).toBe(true);
    expect(res.alreadyDecided).toBeUndefined();
  });
});
