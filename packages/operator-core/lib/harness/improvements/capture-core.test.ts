import { describe, it, expect } from 'vitest';
import {
  captureImprovement,
  validateScoutEvidenceCitations,
  storageKindOf,
  DUP_THRESHOLD,
  CONTAINMENT_THRESHOLD,
  type CaptureDeps,
} from './capture-core';
import { titleSimilarity, titleContainment } from './digest';
import { IMPROVEMENT_TOPIC, OBSERVATION_TOPIC } from './read-items';
import type { CreateIssueInput, EngineerIssue } from '../../issues-engineer';
import {
  assessIssueAdmissionPressure,
  type RecordIssueOccurrenceInput,
} from '../../issue-occurrence-ledger';

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
    parent: null,
    createdBy: null,
    signalOrigin: 'organic',
    assigneeRank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    lastProgressAt: null,
    origin: 'local',
    terminalOwner: null,
    terminalCompletionRef: null,
    completionAuthority: null,
    featureOrder: null,
    createdAt: '2026-06-04T00:00:00Z',
    updatedAt: '2026-06-04T00:00:00Z',
    closedAt: null,
    goalId: null,
    ...p,
  };
}

function deps(
  opts: { found?: EngineerIssue[]; setCheckpoint?: CaptureDeps['setCheckpoint'] } = {},
): CaptureDeps & { created: CreateIssueInput[]; occurrences: RecordIssueOccurrenceInput[] } {
  const created: CreateIssueInput[] = [];
  const occurrences: RecordIssueOccurrenceInput[] = [];
  return {
    created,
    occurrences,
    searchIssues: async () => opts.found ?? [],
    setCheckpoint: opts.setCheckpoint,
    recordIssueOccurrence: async (input) => {
      occurrences.push(input);
      return null;
    },
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

describe('captureImprovement — initialState seam (observation-lane-scorecard-classification-2026-08-16 D-002/D-005)', () => {
  it("passes initialState:'done' through to createIssue.state — the scorecards:emit verdict path", async () => {
    const d = deps();
    await captureImprovement(
      { title: 'Scorecard: Test Rubric', kind: 'change', lane: 'observation', initialState: 'done' },
      d,
    );
    expect(d.created[0].state).toBe('done');
  });

  it('CONTROL: an ordinary capture passes NO state — createIssue defaults to open downstream', async () => {
    const d = deps();
    await captureImprovement({ title: 'plain observation', kind: 'change', lane: 'observation' }, d);
    // Absence, not 'open': the default lives in ONE place (createIssue's INSERT),
    // so this seam must not restate it. The conditionKey collapse
    // (EI-19325151590626958) depends on capture-route rows staying open.
    expect(d.created[0].state).toBeUndefined();
  });
});

describe('captureImprovement — filer-role attribution (close-observation-attribution-gap 2026-06-21)', () => {
  it('stamps payload.filedByRole on an observation when given (fixes the ~100% unknown bucket)', async () => {
    const d = deps();
    await captureImprovement(
      { title: 'pot-coordination-health scorecard', kind: 'change', lane: 'observation', filedByRole: 'kettle' },
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

describe('Scout evidence citations (EI-19450720466036446)', () => {
  it('records unresolved and same-role citations at capture time', async () => {
    const d = deps();
    d.getIssue = async (id) =>
      id === 'EI-200'
        ? existing({ id, title: 'Scout sibling', payload: { sourceRole: 'Scout' } })
        : null;

    await captureImprovement(
      {
        title: 'watchdog false-fire experiment',
        kind: 'change',
        body: 'Known incident evidence: EI-200 and EI-404.',
        sourceRole: 'Scout',
      },
      d,
    );

    const integrity = (d.created[0].payload as Record<string, unknown>).evidenceIntegrity as Record<string, unknown>;
    expect(integrity.checked).toBe(true);
    expect(integrity.citedIds).toEqual(['EI-200', 'EI-404']);
    expect(integrity.resolvedIds).toEqual(['EI-200']);
    expect(integrity.unresolvedIds).toEqual(['EI-404']);
    expect(integrity.circularIds).toEqual(['EI-200']);
    expect(integrity.lookupFailedIds).toEqual([]);
  });

  it('records resolver failures without rejecting the Scout capture', async () => {
    const d = deps();
    d.getIssue = async () => {
      throw new Error('temporary datastore outage');
    };
    const result = await captureImprovement(
      { title: 'watchdog evidence retry', kind: 'bug', body: 'See EI-405.', sourceRole: 'Scout' },
      d,
    );

    expect(result.created).toBe(true);
    const integrity = (d.created[0].payload as Record<string, unknown>).evidenceIntegrity as Record<string, unknown>;
    expect(integrity.checked).toBe(true);
    expect(integrity.unresolvedIds).toEqual([]);
    expect(integrity.lookupFailedIds).toEqual(['EI-405']);
  });

  it('returns no integrity record when a proposal has no work-item citations', async () => {
    const integrity = await validateScoutEvidenceCitations('No prior incident ids are named here.');
    expect(integrity).toBeUndefined();
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

describe('captureImprovement — correlated tool-failure probation (P-013)', () => {
  const key = 'repeated-tool-error:coord:send:caller:invalid-args-body-must-be';
  const probation = (reporter: string) => ({
    state: 'probation' as const,
    class: 'caller',
    watchdogKey: key,
    correlationFingerprint: 'coord:send|invalid_args|42|body|codex-1.2|invalid-args-body-must-be',
    intendedKind: 'change' as const,
    reporters: [reporter],
  });

  it('keeps the first report in the observation lane and preserves its correlation dimensions', async () => {
    const d = deps();
    await captureImprovement(
      {
        title: 'coord:send rejected a valid body',
        kind: 'change',
        lane: 'observation',
        watchdogKey: key,
        createdBy: 'su-a',
        payloadExtra: { toolFailureProbation: probation('su-a') },
      },
      d,
    );
    expect(d.created[0]).toMatchObject({ kind: 'change', severity: 'nit' });
    expect(d.created[0].payload).toMatchObject({
      lane: 'observation',
      watchdogKey: key,
      toolFailureProbation: { state: 'probation', reporters: ['su-a'] },
    });
  });

  it('promotes the same row in place when a second independent agent reports it', async () => {
    const prior = existing({
      id: 'EI-PROBATION',
      title: 'coord:send rejected a valid body',
      kind: 'change',
      severity: 'nit',
      payload: { lane: 'observation', watchdogKey: key, toolFailureProbation: probation('su-a') },
    });
    const mergedPatches: Record<string, unknown>[] = [];
    const tags: string[] = [];
    const untags: string[] = [];
    const d: CaptureDeps & { created: CreateIssueInput[]; occurrences: RecordIssueOccurrenceInput[] } = {
      ...deps(),
      findIssuesByWatchdogKeys: async () => [prior],
      updateIssuePatch: async (_id, patch) => existing({ ...prior, ...patch }),
      mergeIssuePayload: async (_id, patch) => {
        mergedPatches.push(patch);
        return existing({ ...prior, kind: 'change', severity: 'minor', payload: { ...(prior.payload as object), ...patch } });
      },
      tagIssue: async (_id, topic) => { tags.push(topic); },
      untagIssue: async (_id, topic) => { untags.push(topic); },
    };
    const res = await captureImprovement(
      {
        title: 'coord:send rejected a valid body',
        kind: 'change',
        lane: 'observation',
        watchdogKey: key,
        createdBy: 'su-b',
        payloadExtra: { toolFailureProbation: probation('su-b') },
      },
      d,
    );
    expect(res).toMatchObject({ created: false, reason: 'promoted', issue: { id: 'EI-PROBATION' } });
    expect(d.created).toHaveLength(0);
    expect(mergedPatches[0]).toMatchObject({
      lane: null,
      toolFailureProbation: { state: 'promoted', reporters: ['su-a', 'su-b'] },
    });
    expect(tags).toEqual([IMPROVEMENT_TOPIC]);
    expect(untags).toEqual([OBSERVATION_TOPIC]);
    expect(d.occurrences).toEqual([
      expect.objectContaining({
        canonicalId: 'EI-PROBATION',
        reporter: 'su-b',
        sourceTool: 'improvements:capture',
        reportKind: 'promoted',
      }),
    ]);
  });

  it('lets the invocation-ledger watchdog promote an exact-key probation row without minting a duplicate', async () => {
    const prior = existing({
      id: 'EI-PROBATION',
      title: 'one-off report',
      payload: { lane: 'observation', watchdogKey: key, toolFailureProbation: probation('su-a') },
    });
    const d: CaptureDeps & { created: CreateIssueInput[]; occurrences: RecordIssueOccurrenceInput[] } = {
      ...deps(),
      findIssuesByWatchdogKeys: async () => [prior],
      updateIssuePatch: async (_id, patch) => existing({ ...prior, ...patch }),
      mergeIssuePayload: async (_id, patch) => existing({ ...prior, kind: 'change', payload: { ...(prior.payload as object), ...patch } }),
      tagIssue: async () => {},
      untagIssue: async () => {},
    };
    const res = await captureImprovement(
      {
        title: 'Tool coord:send repeatedly rejecting caller input',
        kind: 'change',
        watchdogKey: key,
        createdBy: 'system:improvement-watchdog',
      },
      d,
    );
    expect(res).toMatchObject({ created: false, reason: 'promoted', issue: { id: 'EI-PROBATION' } });
    expect(d.created).toHaveLength(0);
    expect(d.occurrences).toEqual([
      expect.objectContaining({
        canonicalId: 'EI-PROBATION',
        reporter: 'system:improvement-watchdog',
        sourceTool: 'improvements:capture',
        reportKind: 'promoted',
      }),
    ]);
  });
});

describe('captureImprovement — auto-ratify-on-first-scorecard hook (WI-5415)', () => {
  it('calls autoRatifyRubric with the rubricRef + grader when a scorecard lands against it', async () => {
    const calls: Array<[string, string]> = [];
    const d: CaptureDeps = {
      ...deps(),
      autoRatifyRubric: async (rubricId, graderId) => {
        calls.push([rubricId, graderId]);
        return null;
      },
    };
    await captureImprovement(
      {
        title: 'scorecard for my-rubric',
        kind: 'change',
        lane: 'observation',
        createdBy: 'cup-42',
        payloadExtra: { observation: { rubricRef: 'my-rubric', ratings: {} } },
      },
      d,
    );
    expect(calls).toEqual([['my-rubric', 'cup-42']]);
  });

  it('does NOT call it when the observation carries no rubricRef', async () => {
    const calls: unknown[] = [];
    const d: CaptureDeps = {
      ...deps(),
      autoRatifyRubric: async (...args: [string, string]) => {
        calls.push(args);
        return null;
      },
    };
    await captureImprovement(
      { title: 'x', kind: 'change', lane: 'observation', createdBy: 'cup-1' },
      d,
    );
    expect(calls).toHaveLength(0);
  });

  it('does NOT call it for a non-observation (improvement lane) capture', async () => {
    const calls: unknown[] = [];
    const d: CaptureDeps = {
      ...deps(),
      autoRatifyRubric: async (...args: [string, string]) => {
        calls.push(args);
        return null;
      },
    };
    await captureImprovement({ title: 'x', kind: 'bug', createdBy: 'cup-1' }, d);
    expect(calls).toHaveLength(0);
  });

  it('never fails the capture when auto-ratify rejects (best-effort side effect)', async () => {
    const d: CaptureDeps = {
      ...deps(),
      autoRatifyRubric: async () => {
        throw new Error('boom — plan lock busy');
      },
    };
    const res = await captureImprovement(
      {
        title: 'scorecard for my-rubric',
        kind: 'change',
        lane: 'observation',
        createdBy: 'cup-42',
        payloadExtra: { observation: { rubricRef: 'my-rubric', ratings: {} } },
      },
      d,
    );
    expect(res.created).toBe(true);
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
    const res = await captureImprovement({ title: 'a net-new capability', kind: 'feature' }, d);
    expect(d.created[0].kind).toBe('change');
    expect(d.created[0].payload).toMatchObject({ improvementKind: 'feature' });
    expect(res).toMatchObject({
      kind: 'change',
      improvementKind: 'feature',
      issue: { kind: 'change' },
    });
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

  it('seeds a successor checkpoint for an atomically claimed improvement', async () => {
    const checkpoints: Array<{ id: string; text: string }> = [];
    const d = deps({
      setCheckpoint: async (id, text) => {
        checkpoints.push({ id, text });
      },
    });

    await captureImprovement(
      { title: 'claimed capture needs continuity', kind: 'bug', assignee: 'su-a', createdBy: 'su-a' },
      d,
    );

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ id: 'EI-100' });
    expect(checkpoints[0].text).toContain('no implementation work has started');
  });

  it('keeps the capture successful when checkpoint seeding fails', async () => {
    const d = deps({ setCheckpoint: async () => { throw new Error('checkpoint store unavailable'); } });

    const result = await captureImprovement(
      { title: 'claimed capture survives checkpoint outage', kind: 'bug', assignee: 'su-a', createdBy: 'su-a' },
      d,
    );

    expect(result.created).toBe(true);
    expect(result.issue?.id).toBe('EI-100');
  });
});

describe('captureImprovement — search-first dedup (D-001)', () => {
  const dup = existing({ id: 'EI-7', title: 'presence list dumps stale rows', state: 'open' });

  it('declines a likely duplicate by default (link instead)', async () => {
    const d = deps({ found: [dup] });
    const res = await captureImprovement(
      { title: 'presence list dumps stale rows', kind: 'bug', body: 'fresh repro evidence', createdBy: 'su-reporter' },
      d,
    );
    expect(res.created).toBe(false);
    expect(res.reason).toBe('likely-duplicate');
    expect(res.possibleDuplicates[0].id).toBe('EI-7');
    expect(d.created).toHaveLength(0);
    expect(d.occurrences).toEqual([
      expect.objectContaining({
        canonicalId: 'EI-7',
        reporter: 'su-reporter',
        sourceTool: 'improvements:capture',
        reportKind: 'duplicate',
        reportedTitle: 'presence list dumps stale rows',
        admissionIdentity: expect.objectContaining({ schemaVersion: 'admission-identity-v1' }),
        evidence: expect.objectContaining({ body: 'fresh repro evidence' }),
      }),
    ]);
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

describe('captureImprovement — canonical occurrence recording (P-004)', () => {
  it('records the newly created issue as the canonical occurrence with its evidence', async () => {
    const d = deps();
    const res = await captureImprovement(
      {
        title: 'new canonical control-plane failure',
        kind: 'bug',
        body: 'journal evidence and reproduction steps',
        scope: 'harness:papercusp',
        createdBy: 'su-reporter',
        payloadExtra: { observation: { confidence: 'high' } },
      },
      d,
    );

    expect(res).toMatchObject({ created: true, issue: { id: 'EI-100' } });
    expect(d.occurrences).toEqual([
      expect.objectContaining({
        canonicalId: 'EI-100',
        canonicalHarness: 'papercusp',
        reporter: 'su-reporter',
        sourceTool: 'improvements:capture',
        reportKind: 'canonical-created',
        reportedTitle: 'new canonical control-plane failure',
        evidence: expect.objectContaining({
          body: 'journal evidence and reproduction steps',
          payloadExtra: { observation: { confidence: 'high' } },
        }),
      }),
    ]);
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
    expect((d.created[0].payload as Record<string, unknown> | undefined)?.sourceRole).toBeUndefined();
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
    expect((d.created[0].payload as Record<string, unknown> | undefined)?.sourceRole).toBe('cup');
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

describe('captureImprovement — P-011 semantic candidate widening (shared-embedding-sidecar-and-enrichment-2026-07-10)', () => {
  const semDeps = (
    d: ReturnType<typeof deps>,
    verdict: { hard: Array<{ id: string; similarity: number }>; soft: Array<{ id: string; similarity: number }> } | null,
    issues: EngineerIssue[],
  ): CaptureDeps & { created: CreateIssueInput[] } => ({
    ...d,
    findSemanticDupes: async () =>
      verdict === null
        ? null
        : {
            hard: verdict.hard.map((c) => ({ ...c, title: 't', state: 'open', harness: null })),
            soft: verdict.soft.map((c) => ({ ...c, title: 't', state: 'open', harness: null })),
            thresholds: { hard: 0.93, soft: 0.85 },
          },
    getIssue: async (id) => issues.find((i) => i.id === id) ?? null,
  });

  it('a HARD semantic hit declines the capture even when the lexical net misses it', async () => {
    const worded = existing({ id: 'EI-50', title: 'agents keep refiling identical tool bugs' });
    const d = semDeps(deps({ found: [] }), { hard: [{ id: 'EI-50', similarity: 0.95 }], soft: [] }, [worded]);
    const res = await captureImprovement({ title: 'duplicate friction reports flood the queue', kind: 'bug' }, d);
    expect(res.created).toBe(false);
    expect(res.reason).toBe('likely-duplicate');
    expect(res.possibleDuplicates[0]).toMatchObject({ id: 'EI-50', semantic: 'hard', similarity: 0.95 });
  });

  it('a SOFT semantic hit is advisory-only: surfaced in possibleDuplicates, capture still created', async () => {
    const worded = existing({ id: 'EI-51', title: 'similar-ish friction wording' });
    const d = semDeps(deps({ found: [] }), { hard: [], soft: [{ id: 'EI-51', similarity: 0.87 }] }, [worded]);
    const res = await captureImprovement({ title: 'a completely differently worded capture', kind: 'change' }, d);
    expect(res.created).toBe(true);
    expect(res.possibleDuplicates).toEqual([
      expect.objectContaining({ id: 'EI-51', semantic: 'soft', similarity: 0.87 }),
    ]);
  });

  it('P-005 coalesces a SOFT semantic sibling during a concentrated low-diversity burst', async () => {
    const worded = existing({ id: 'EI-57', title: 'similar queue admission failure' });
    const base = deps({ found: [] });
    const d = semDeps(base, { hard: [], soft: [{ id: 'EI-57', similarity: 0.91 }] }, [worded]);
    d.readIssueAdmissionPressure = async () => assessIssueAdmissionPressure({
      rawOccurrences: 455,
      duplicateOccurrences: 455,
      canonicalStock: 2_494,
      canonicalClusterCounts: [430, 5, 5, 5, 5, 5],
      emitterCounts: [430, 5, 5, 5, 5, 5],
    });

    const res = await captureImprovement({ title: 'differently worded queue admission failure', kind: 'bug' }, d);
    expect(res).toMatchObject({
      created: false,
      reason: 'coalesced',
      issue: { id: 'EI-57' },
      queueAdmission: { active: true, rawOccurrences: 455, canonicalStock: 2_494 },
    });
    expect(base.created).toHaveLength(0);
    expect(base.occurrences).toEqual([
      expect.objectContaining({
        canonicalId: 'EI-57',
        reportKind: 'coalesced',
        evidence: expect.objectContaining({
          queueAdmission: expect.objectContaining({ active: true, rawOccurrences: 455 }),
        }),
      }),
    ]);
  });

  it('P-005 never consults the burst circuit for a critical finding', async () => {
    const worded = existing({ id: 'EI-58', title: 'near critical finding' });
    const base = deps({ found: [] });
    const d = semDeps(base, { hard: [], soft: [{ id: 'EI-58', similarity: 0.91 }] }, [worded]);
    let pressureReads = 0;
    d.readIssueAdmissionPressure = async () => {
      pressureReads += 1;
      return assessIssueAdmissionPressure({
        rawOccurrences: 455,
        duplicateOccurrences: 455,
        canonicalStock: 2_494,
        canonicalClusterCounts: [455],
        emitterCounts: [455],
      });
    };

    const res = await captureImprovement(
      { title: 'novel critical queue failure', kind: 'bug', severity: 'critical' },
      d,
    );
    expect(res.created).toBe(true);
    expect(pressureReads).toBe(0);
    expect(base.created).toHaveLength(1);
  });

  // ── D-033 (learning-loop-identity-and-consumption-2026-08-08 P-008):
  // `semanticBlockBand:'soft'` lets a soft hit decline, for high-volume MACHINE
  // ideation only. The pair below is deliberate: the CONTROL pins the default so
  // a future change that makes soft blocking universal fails HERE rather than
  // silently costing agents their filings (owner constraint D-004).
  it('D-033: semanticBlockBand:"soft" lets a SOFT hit decline the capture', async () => {
    const worded = existing({ id: 'EI-54', title: 'similar-ish friction wording' });
    const d = semDeps(deps({ found: [] }), { hard: [], soft: [{ id: 'EI-54', similarity: 0.87 }] }, [worded]);
    const res = await captureImprovement(
      { title: 'a completely differently worded capture', kind: 'change', semanticBlockBand: 'soft' },
      d,
    );
    expect(res.created).toBe(false);
    expect(res.reason).toBe('likely-duplicate');
    expect(res.possibleDuplicates[0]).toMatchObject({ id: 'EI-54', semantic: 'soft', similarity: 0.87 });
  });

  it('D-033 CONTROL: the DEFAULT still lets a soft hit through — agent filings are never blocked by a soft band', async () => {
    const worded = existing({ id: 'EI-55', title: 'similar-ish friction wording' });
    const d = semDeps(deps({ found: [] }), { hard: [], soft: [{ id: 'EI-55', similarity: 0.87 }] }, [worded]);
    // Same inputs as the case above, minus the opt-in. Only the flag differs.
    const res = await captureImprovement({ title: 'a completely differently worded capture', kind: 'change' }, d);
    expect(res.created).toBe(true);
    expect(res.possibleDuplicates[0]).toMatchObject({ id: 'EI-55', semantic: 'soft' });
  });

  it('D-033: semanticBlockBand:"soft" does NOT widen blocking to CONTAINMENT hits (asymmetric, stays advisory in both modes)', async () => {
    // Calibration: proves the opt-in widens the SEMANTIC band specifically rather
    // than loosening blocking generally — otherwise both tests above would pass
    // for a predicate that simply blocks everything.
    const broad = existing({ id: 'EI-56', title: 'queue' });
    const d = semDeps(deps({ found: [broad] }), { hard: [], soft: [] }, [broad]);
    const res = await captureImprovement(
      { title: 'queue starves under fleet load', kind: 'change', semanticBlockBand: 'soft' },
      d,
    );
    expect(res.created).toBe(true);
  });

  it('a null verdict (guard disabled / embedder down) leaves the lexical behavior unchanged', async () => {
    const d = semDeps(deps({ found: [] }), null, []);
    const res = await captureImprovement({ title: 'anything at all', kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(res.possibleDuplicates).toEqual([]);
  });

  it('origin discipline holds: a drill-origin semantic hit never widens an organic capture', async () => {
    const drill = existing({ id: 'EI-52', title: 'drill row', signalOrigin: 'drill' });
    const d = semDeps(deps({ found: [] }), { hard: [{ id: 'EI-52', similarity: 0.97 }], soft: [] }, [drill]);
    const res = await captureImprovement({ title: 'an organic capture', kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(res.possibleDuplicates).toEqual([]);
  });

  it('a lexically-caught candidate keeps its lexical score and gains no semantic flag', async () => {
    const same = existing({ id: 'EI-53', title: 'docs search returns stale results' });
    const d = semDeps(
      deps({ found: [same] }),
      { hard: [{ id: 'EI-53', similarity: 0.96 }], soft: [] },
      [same],
    );
    const res = await captureImprovement({ title: 'docs search returns stale results', kind: 'bug' }, d);
    expect(res.created).toBe(false);
    expect(res.possibleDuplicates[0].semantic).toBeUndefined();
    expect(res.possibleDuplicates[0].similarity).toBe(1);
  });

  it('observations still skip the semantic net entirely (recurrence IS the signal)', async () => {
    let called = false;
    const d = {
      ...deps(),
      findSemanticDupes: async () => {
        called = true;
        return null;
      },
    };
    const res = await captureImprovement({ title: 'x', kind: 'change', lane: 'observation' }, d);
    expect(res.created).toBe(true);
    expect(called).toBe(false);
  });
});

describe('captureImprovement — observation coalescing by conditionKey (EI-15448)', () => {
  /** A stateful watchdogKey-aware store: findIssuesByWatchdogKeys/mergeIssuePayload/
   *  updateIssuePatch all operate on the SAME in-memory `store` array so a 2nd call
   *  in the same test genuinely finds the 1st call's row — exercising the real
   *  coalesce loop, not a canned return. */
  function coalesceDeps(): CaptureDeps & {
    created: CreateIssueInput[];
    store: EngineerIssue[];
    occurrences: RecordIssueOccurrenceInput[];
  } {
    const created: CreateIssueInput[] = [];
    const store: EngineerIssue[] = [];
    const occurrences: RecordIssueOccurrenceInput[] = [];
    let nextId = 100;
    return {
      created,
      store,
      occurrences,
      recordIssueOccurrence: async (input) => {
        occurrences.push(input);
        return null;
      },
      searchIssues: async () => [],
      createIssue: async (input) => {
        created.push(input);
        const issue = existing({
          id: `EI-${nextId++}`,
          title: input.title,
          kind: (input.kind as 'bug' | 'change') ?? 'change',
          payload: input.payload ?? null,
          // Faithful to the real writer (capture-core passes `createdBy: input.createdBy`
          // into createIssue) — without this the stored row is always unattributed, and
          // the cross-author coalesce below could never be exercised.
          createdBy: input.createdBy ?? null,
        });
        store.push(issue);
        return issue;
      },
      findIssuesByWatchdogKeys: async (keys) =>
        store.filter((i) => {
          const k = (i.payload as Record<string, unknown> | null)?.watchdogKey;
          return typeof k === 'string' && keys.includes(k);
        }),
      mergeIssuePayload: async (id, patch) => {
        const i = store.find((x) => x.id === id);
        if (!i) return null;
        i.payload = { ...(i.payload as Record<string, unknown> | null), ...patch };
        return i;
      },
      updateIssuePatch: async (id, patch) => {
        const i = store.find((x) => x.id === id);
        if (!i) return null;
        if (patch.title !== undefined) i.title = patch.title;
        if (patch.body !== undefined) i.body = patch.body;
        return i;
      },
    };
  }

  it('2 calls with the SAME watchdogKey + lane:observation → 1 row, repeatCount:2, reason:coalesced', async () => {
    const d = coalesceDeps();
    const first = await captureImprovement(
      { title: 'escalation-aging holding flat at 312', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:escalation-aging' },
      d,
    );
    expect(first.created).toBe(true);
    expect(d.created).toHaveLength(1);
    expect((d.store[0].payload as Record<string, unknown>).watchdogKey).toBe('overwatch:escalation-aging');

    const second = await captureImprovement(
      { title: 'escalation-aging holding flat at 318', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:escalation-aging' },
      d,
    );
    expect(second.created).toBe(false);
    expect(second.reason).toBe('coalesced');
    expect(d.created).toHaveLength(1); // still only ONE row ever created
    expect(d.store).toHaveLength(1);
    expect((d.store[0].payload as Record<string, unknown>).repeatCount).toBe(2);
    expect(d.store[0].title).toBe('escalation-aging holding flat at 318'); // title refreshed to latest reading
    expect(second.issue?.id).toBe(first.issue?.id);
    expect(d.occurrences.map((occurrence) => occurrence.reportKind)).toEqual(['canonical-created', 'coalesced']);
    expect(d.occurrences[1]).toMatchObject({
      canonicalId: first.issue?.id,
      sourceTool: 'improvements:capture',
      reportedTitle: 'escalation-aging holding flat at 318',
    });
  });

  // P-006/D-004: a coalesce used to return ok:true / created:false / reason:'coalesced'
  // and nothing more — identical whether the caller's text replaced the row's or was
  // silently dropped by the refresh's `.catch(() => null)`, and identical whether the
  // row was the caller's own or a peer's. `coalescedOnto` reports what actually happened.
  describe('coalescedOnto — what the write actually did (P-006/D-004)', () => {
    it('reports the row, the bumped count, and that the body PERSISTED', async () => {
      const d = coalesceDeps();
      const first = await captureImprovement(
        { title: 'reading 312', kind: 'change', lane: 'observation', watchdogKey: 'k', createdBy: 'agent-a' },
        d,
      );
      const second = await captureImprovement(
        { title: 'reading 318', kind: 'change', lane: 'observation', watchdogKey: 'k', createdBy: 'agent-a' },
        d,
      );
      expect(second.coalescedOnto).toMatchObject({
        id: first.issue?.id,
        repeatCount: 2,
        bodyPersisted: true,
        priorAuthor: 'agent-a',
        crossAuthor: false,
      });
      expect(second.coalescedOnto?.bodyDiscarded).toBeUndefined();
      expect(d.store[0].title).toBe('reading 318');
    });

    // The load-bearing case: the refresh fails, the row keeps the PREVIOUS text, and
    // the call still returns ok. Before this the caller had no way to know.
    it('reports bodyDiscarded when the title/body refresh FAILED — the silent write-loss', async () => {
      const d = coalesceDeps();
      await captureImprovement(
        { title: 'reading 312', kind: 'change', lane: 'observation', watchdogKey: 'k', createdBy: 'agent-a' },
        d,
      );
      d.updateIssuePatch = async () => {
        throw new Error('shrink guard tripped');
      };
      const second = await captureImprovement(
        { title: 'reading 318', kind: 'change', lane: 'observation', watchdogKey: 'k', createdBy: 'agent-a' },
        d,
      );
      expect(second.ok).toBe(true); // still not an error — the coalesce itself succeeded
      expect(second.coalescedOnto).toMatchObject({ bodyPersisted: false, bodyDiscarded: true, repeatCount: 2 });
      expect(String(second.coalescedOnto?.note)).toMatch(/DISCARDED/);
      expect(d.store[0].title).toBe('reading 312'); // the row really does still show the OLD reading
    });

    it("flags crossAuthor when the coalesce lands on ANOTHER agent's row", async () => {
      const d = coalesceDeps();
      await captureImprovement(
        { title: 'grade A', kind: 'change', lane: 'observation', watchdogKey: 'scorecard:r:h', createdBy: 'agent-a' },
        d,
      );
      const second = await captureImprovement(
        { title: 'grade B', kind: 'change', lane: 'observation', watchdogKey: 'scorecard:r:h', createdBy: 'agent-b' },
        d,
      );
      expect(second.coalescedOnto).toMatchObject({ crossAuthor: true, priorAuthor: 'agent-a' });
      expect(String(second.coalescedOnto?.note)).toMatch(/PEER'?’?s row/);
    });

    // crossAuthor must never be ASSERTED from missing data: an unattributed row is
    // "not established", not "a peer's" and not "your own".
    it('does NOT claim crossAuthor when either side is unattributed', async () => {
      const d = coalesceDeps();
      await captureImprovement({ title: 'a', kind: 'change', lane: 'observation', watchdogKey: 'k' }, d);
      const second = await captureImprovement(
        { title: 'b', kind: 'change', lane: 'observation', watchdogKey: 'k', createdBy: 'agent-b' },
        d,
      );
      expect(second.coalescedOnto?.priorAuthor).toBeNull();
      expect(second.coalescedOnto?.crossAuthor).toBe(false);
    });

    it('is absent entirely on a normal CREATE — it is a property of coalescing only', async () => {
      const d = coalesceDeps();
      const first = await captureImprovement(
        { title: 'fresh', kind: 'change', lane: 'observation', watchdogKey: 'k', createdBy: 'agent-a' },
        d,
      );
      expect(first.created).toBe(true);
      expect(first.coalescedOnto).toBeUndefined();
    });
  });

  it('a 3rd call with the same key bumps repeatCount to 3 (running count, not a flip-flag)', async () => {
    const d = coalesceDeps();
    await captureImprovement(
      { title: 'x', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:x' },
      d,
    );
    await captureImprovement(
      { title: 'x', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:x' },
      d,
    );
    const third = await captureImprovement(
      { title: 'x', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:x' },
      d,
    );
    expect(third.reason).toBe('coalesced');
    expect((d.store[0].payload as Record<string, unknown>).repeatCount).toBe(3);
    expect(d.created).toHaveLength(1);
  });

  it('a call WITHOUT watchdogKey always re-files, even when a same-titled observation already exists', async () => {
    const d = coalesceDeps();
    await captureImprovement({ title: 'a one-off reading', kind: 'change', lane: 'observation' }, d);
    const second = await captureImprovement({ title: 'a one-off reading', kind: 'change', lane: 'observation' }, d);
    expect(second.created).toBe(true);
    expect(d.created).toHaveLength(2); // no coalescing — 2 distinct rows
  });

  it('a DIFFERENT watchdogKey never coalesces onto another key\'s open row', async () => {
    const d = coalesceDeps();
    await captureImprovement(
      { title: 'condition A', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:a' },
      d,
    );
    const res = await captureImprovement(
      { title: 'condition B', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:b' },
      d,
    );
    expect(res.created).toBe(true);
    expect(d.created).toHaveLength(2);
  });

  it('a NON-observation keyed re-fire coalesces onto ITS OWN lane row, never into an observation row', async () => {
    const d = coalesceDeps();
    const first = await captureImprovement(
      { title: 'a real bug', kind: 'bug', watchdogKey: 'overwatch:not-an-observation' },
      d,
    );
    const second = await captureImprovement(
      { title: 'a real bug', kind: 'bug', watchdogKey: 'overwatch:not-an-observation' },
      d,
    );
    expect(first.created).toBe(true);
    // CONTRACT CHANGED TWICE. EI-20484430331973864 turned the re-file from a fresh
    // row (the 459-copy duplicate storm) into a DECLINE; WI-39594 turned the decline
    // into a COALESCE — same zero-new-rows guarantee, but the standing row now
    // carries repeatCount + the newest reading instead of the occurrence being
    // dropped on the floor. The invariant that SURVIVES both changes: the merge
    // target is the same-lane prior — a non-observation capture never merges into
    // an observation-lane row (see the WI-39594 cross-lane CONTROL below).
    expect(second.created).toBe(false);
    expect(second.reason).toBe('coalesced');
    expect(second.issue?.id).toBe(first.issue?.id);
    expect((d.store[0].payload as Record<string, unknown>).repeatCount).toBe(2);
    expect(d.created).toHaveLength(1);
  });

  it('a CLOSED/resolved row carrying the same key does not coalesce (only an OPEN prior does)', async () => {
    const d = coalesceDeps();
    const first = await captureImprovement(
      { title: 'condition C', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:c' },
      d,
    );
    d.store[0].state = 'resolved';
    const second = await captureImprovement(
      { title: 'condition C recurred', kind: 'change', lane: 'observation', watchdogKey: 'overwatch:c' },
      d,
    );
    expect(second.created).toBe(true);
    expect(second.reason).not.toBe('coalesced');
    expect(d.created).toHaveLength(2);
    expect(first.issue?.id).not.toBe(second.issue?.id);
  });
});

describe('captureImprovement — atomic claim-on-file (WI-5950)', () => {
  it('passes assignee through to createIssue so the filed item lands CLAIMED', async () => {
    const d = deps();
    await captureImprovement(
      { title: 'bug I am already fixing', kind: 'bug', assignee: 'su-abc', createdBy: 'su-abc' },
      d,
    );
    expect(d.created[0].assignee).toBe('su-abc');
  });

  it('stamps assignedBy from the filer, so the claim has a durable delegator', async () => {
    const d = deps();
    await captureImprovement({ title: 'x', kind: 'bug', assignee: 'su-abc', createdBy: 'su-abc' }, d);
    expect(d.created[0].assignedBy).toBe('su-abc');
  });

  it('leaves the item UNCLAIMED when assignee is omitted — filing stays cheap', async () => {
    const d = deps();
    await captureImprovement({ title: 'a finding for whoever picks it up', kind: 'bug', createdBy: 'su-abc' }, d);
    expect(d.created[0].assignee).toBeUndefined();
  });

  it('NEVER claims an observation — a sensor reading is not claimable work', async () => {
    const d = deps();
    await captureImprovement(
      {
        title: 'docs:search felt slow',
        kind: 'change',
        lane: 'observation',
        assignee: 'su-abc',
        createdBy: 'su-abc',
      },
      d,
    );
    expect(d.created[0].assignee).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────
// P-007 (knowledge-at-symptom-time-2026-08-09) — symptom-first dedup lookup.
//
// The MEASURED incident, 2026-08-09: I filed EI-19948333346987654, then ran the
// `checkDuplicatesOnly` lookup with a query that is a VERBATIM SUBSTRING of that item's
// own title. It returned `possibleDuplicates: []`. The exact full title returned it at
// similarity 1.0 — so the item was indexed and reachable; the NET was the problem.
//
// Root cause: titleSimilarity is token-set Jaccard, which divides by the UNION. A short
// query that is a perfect SUBSET of a longer stored title therefore scores |query|/|title|
// and can never clear DUP_THRESHOLD. That is a structural bias against the exact shape of
// a symptom-first lookup: at symptom time the query is SHORT (the error you just saw)
// while stored titles are LONG (written after diagnosis).
//
// A prior filing (EI-19502216864373653, dropped) attributed an identical empty result
// SOLELY to the embedder being down. That was one cause; this is a second, independent
// one that persists with a perfectly healthy semantic leg.
// ───────────────────────────────────────────────────────────────────────────────────────

/** The real stored title, verbatim. */
const REAL_TITLE =
  'No way to locate or focus an agent\'s desktop terminal window — GNOME Wayland makes wmctrl/xdotool return EMPTY with exit 0, indistinguishable from "no window exists"';
/** The real symptom-first query, verbatim — a literal substring of REAL_TITLE. */
const SYMPTOM_QUERY = "No way to locate or focus an agent's desktop terminal window";

describe('P-007 — symptom-first containment lookup', () => {
  it('FALSIFIABILITY CONTROL: the PRE-FIX metric (Jaccard alone) misses the real measured pair; containment catches it', () => {
    // This control is PERMANENT. Every assertion below would pass against an implementation
    // that quietly did nothing if the underlying pair were not actually hard for Jaccard —
    // so pin BOTH sides of the discrimination on the real strings.
    const jac = titleSimilarity(SYMPTOM_QUERY, REAL_TITLE);
    expect(jac).toBeLessThan(DUP_THRESHOLD); // CONTROL: the pre-fix net genuinely fails here
    const contained = titleContainment(SYMPTOM_QUERY, REAL_TITLE);
    expect(contained).toBeGreaterThanOrEqual(CONTAINMENT_THRESHOLD); // and the fix genuinely rescues it
  });

  it('surfaces the containment hit that Jaccard missed, flagged as such', async () => {
    const d = deps({ found: [existing({ id: 'EI-19948333346987654', title: REAL_TITLE })] });
    const res = await captureImprovement({ title: SYMPTOM_QUERY, kind: 'bug', checkDuplicatesOnly: true }, d);
    expect(res.possibleDuplicates.map((p) => p.id)).toEqual(['EI-19948333346987654']);
    expect(res.possibleDuplicates[0].lexical).toBe('containment');
    expect(res.possibleDuplicates[0].similarity).toBeGreaterThanOrEqual(CONTAINMENT_THRESHOLD);
  });

  it('SAFETY: a containment-only hit NEVER declines a capture — surfacing is widened, blocking is not', async () => {
    // The asymmetry matters: containment says "your short title is covered by this broad
    // one", which is true for many genuinely-distinct narrow items. Missing a duplicate
    // costs a duplicate; wrongly declining costs the FINDING.
    const d = deps({ found: [existing({ id: 'EI-19948333346987654', title: REAL_TITLE })] });
    const res = await captureImprovement({ title: SYMPTOM_QUERY, kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(d.created).toHaveLength(1);
    expect(res.possibleDuplicates[0].lexical).toBe('containment'); // still SHOWN, just not blocking
  });

  it('does not re-label a candidate the lexical net already caught (exact title keeps similarity 1, no containment flag)', async () => {
    const d = deps({ found: [existing({ id: 'EI-19948333346987654', title: REAL_TITLE })] });
    const res = await captureImprovement({ title: REAL_TITLE, kind: 'bug', checkDuplicatesOnly: true }, d);
    expect(res.possibleDuplicates[0].similarity).toBe(1);
    expect(res.possibleDuplicates[0].lexical).toBeUndefined();
  });

  it('a too-short query is NOT a containment match (below CONTAINMENT_MIN_TOKENS it would match half the backlog)', async () => {
    const d = deps({ found: [existing({ id: 'EI-1', title: REAL_TITLE })] });
    const res = await captureImprovement({ title: 'window focus', kind: 'bug', checkDuplicatesOnly: true }, d);
    expect(res.possibleDuplicates).toEqual([]);
  });
});

describe('P-007 — dedupCoverage: an empty result must disclose whether it could CHECK', () => {
  it('reports semantic UNAVAILABLE + degraded when the embedding leg returns no verdict', async () => {
    // The embedder fails OPEN (null on timeout / down / disabled). EI-19502216864373653
    // measured the cost of not saying so: an agent read a bare [] as "no duplicates",
    // filed, and retracted minutes later against an open major item from ~12h earlier.
    const d = { ...deps(), findSemanticDupes: async () => null };
    const res = await captureImprovement({ title: 'some novel symptom string', kind: 'bug', checkDuplicatesOnly: true }, d);
    expect(res.possibleDuplicates).toEqual([]);
    expect(res.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'unavailable', degraded: true });
  });

  it('reports semantic OK + not degraded when the embedding leg DOES answer — so [] is a real all-clear', async () => {
    const d = { ...deps(), findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.9, soft: 0.8 } }) };
    const res = await captureImprovement({ title: 'some novel symptom string', kind: 'bug', checkDuplicatesOnly: true }, d);
    expect(res.possibleDuplicates).toEqual([]);
    expect(res.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'ok', degraded: false });
  });

  it('CONTROL: the two cases above are DISTINGUISHABLE — pre-fix they were byte-identical', async () => {
    // Without dedupCoverage both calls return exactly `possibleDuplicates: []`. If this
    // assertion ever fails, the disclosure has been dropped and the ambiguity is back.
    const down = await captureImprovement(
      { title: 'some novel symptom string', kind: 'bug', checkDuplicatesOnly: true },
      { ...deps(), findSemanticDupes: async () => null },
    );
    const up = await captureImprovement(
      { title: 'some novel symptom string', kind: 'bug', checkDuplicatesOnly: true },
      { ...deps(), findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.9, soft: 0.8 } }) },
    );
    expect(down.possibleDuplicates).toEqual(up.possibleDuplicates); // the pre-fix payload: identical
    expect(down.dedupCoverage).not.toEqual(up.dedupCoverage); // the fix: no longer identical
  });

  it('the CREATE path carries coverage too — that is where the retraction incident happened', async () => {
    const d = { ...deps(), findSemanticDupes: async () => null };
    const res = await captureImprovement({ title: 'a brand new finding', kind: 'bug' }, d);
    expect(res.created).toBe(true);
    expect(res.dedupCoverage?.degraded).toBe(true);
  });
});

describe('EI-20275452450016416 — the achieved coverage is PERSISTED, not just reported', () => {
  const coverageOf = (d: ReturnType<typeof deps>) =>
    (d.created[0].payload as Record<string, unknown> | undefined)?.dedupCoverage;

  it('stamps payload.dedupCoverage when the semantic leg was DOWN — the re-dedup work-list', async () => {
    // Returning the degraded bit to the caller and then discarding it left no way to
    // find the rows admitted without a differently-worded-duplicate check. Measured
    // pre-fix: 0 of 6,179 rows in 7 days carried it.
    const d = deps();
    await captureImprovement({ title: 'a brand new finding', kind: 'bug' }, { ...d, findSemanticDupes: async () => null });
    expect(coverageOf(d)).toEqual({ lexical: 'ok', semantic: 'unavailable', degraded: true });
  });

  it('stamps it when the leg was HEALTHY too — absence must not be ambiguous', async () => {
    // Stamping only the degraded rows would make a missing key mean either "checked
    // clean" or "filed before this existed" — the same lost distinction the discard
    // created. Presence of the key is what makes the population measurable.
    const d = deps();
    await captureImprovement(
      { title: 'a brand new finding', kind: 'bug' },
      { ...d, findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.9, soft: 0.8 } }) },
    );
    expect(coverageOf(d)).toEqual({ lexical: 'ok', semantic: 'ok', degraded: false });
  });

  it('CONTROL: the two persisted rows are DISTINGUISHABLE — a stamp that never varies is not evidence', async () => {
    const down = deps();
    await captureImprovement({ title: 'a brand new finding', kind: 'bug' }, { ...down, findSemanticDupes: async () => null });
    const up = deps();
    await captureImprovement(
      { title: 'a brand new finding', kind: 'bug' },
      { ...up, findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.9, soft: 0.8 } }) },
    );
    expect(coverageOf(down)).not.toEqual(coverageOf(up));
  });

  it('does NOT stamp the observation lane — both legs are skipped by design, so the value is a constant', async () => {
    // An observation skips dedup entirely (recurrence IS its signal), so its coverage
    // is always {skipped, skipped, false}. Persisting a constant would add a column of
    // noise to the highest-volume lane and dilute the degraded work-list.
    const d = deps();
    await captureImprovement(
      { title: 'a sensor reading', kind: 'change', lane: 'observation' },
      { ...d, findSemanticDupes: async () => null },
    );
    expect(coverageOf(d)).toBeUndefined();
  });
});

describe('WI-38403 — stable identity + fail-closed DRAIN admission', () => {
  const payloadOf = (d: ReturnType<typeof deps>) =>
    d.created[0].payload as Record<string, unknown> | undefined;

  it('persists the server-authored normalized title identity and stronger signal key', async () => {
    const d = deps();
    const res = await captureImprovement(
      { title: '[bug] Agents file duplicate drain blockers', kind: 'bug', watchdogKey: 'drain:blocked:queue' },
      { ...d, findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.9 } }) },
    );
    expect(res.admissionIdentity).toEqual({
      schemaVersion: 'admission-identity-v1',
      titleKey: 'title:agents blockers drain duplicate file',
      signalKey: 'drain:blocked:queue',
    });
    expect(payloadOf(d)?.admissionIdentity).toEqual(res.admissionIdentity);
  });

  it('marks a failed lexical search unavailable instead of reporting a false all-clear', async () => {
    const d = deps();
    const res = await captureImprovement(
      { title: 'novel direct drain blocker', kind: 'bug', checkDuplicatesOnly: true },
      {
        ...d,
        searchIssues: async () => { throw new Error('search unavailable'); },
        findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.9 } }),
      },
    );
    expect(res.dedupCoverage).toEqual({ lexical: 'unavailable', semantic: 'ok', degraded: true });
  });

  it('rejects a DRAIN bug before persistence when any dedup leg is unavailable, even with force', async () => {
    const d = deps();
    await expect(
      captureImprovement(
        {
          title: 'direct drain blocker with no semantic verdict',
          kind: 'bug',
          force: true,
          requireCompleteDedupCoverage: true,
        },
        { ...d, findSemanticDupes: async () => null },
      ),
    ).rejects.toMatchObject({
      code: 'dedup_unavailable',
      coverage: { lexical: 'ok', semantic: 'unavailable', degraded: true },
    });
    expect(d.created).toHaveLength(0);
  });

  it('admits a DRAIN bug when both dedup legs returned real verdicts', async () => {
    const d = deps();
    const res = await captureImprovement(
      { title: 'verified unique direct drain blocker', kind: 'bug', requireCompleteDedupCoverage: true },
      { ...d, findSemanticDupes: async () => ({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.9 } }) },
    );
    expect(res.created).toBe(true);
    expect(payloadOf(d)?.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'ok', degraded: false });
  });
});

describe('exact watchdogKey is a first-class blocking dedup source (EI-20484430331973864)', () => {
  const noSemantic = async () => ({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.9 } });
  const KEY = 'routine-engine-death:engine:live';
  const DEAD_ENGINE = 'The routines engine is dead — every active routine is overdue';

  it('a standing re-file lands on the exact-key row even when the lexical search is UNAVAILABLE', async () => {
    // The 459-copy regression: the red-queen sentinel re-files a standing outage on a
    // stable key every 5 min. Blocking dedup used to rest entirely on the fuzzy title
    // search, which fails OPEN — so every pass where search was down minted a fresh
    // critical row. The exact key was fetched all along and then thrown away.
    // CONTRACT SHARPENED by WI-39594: the open exact-key row is now a COALESCE
    // target (repeatCount bump + refresh) rather than a bare decline — same
    // zero-new-rows guarantee, and the outcome no longer depends on the fuzzy
    // search at all (the coalesce runs before it).
    const d = deps();
    const prior = existing({ id: 'EI-900', title: DEAD_ENGINE, payload: { watchdogKey: KEY } });
    const res = await captureImprovement(
      { title: DEAD_ENGINE, kind: 'bug', severity: 'critical', watchdogKey: KEY, dedupScope: 'open' },
      {
        ...d,
        searchIssues: async () => {
          throw new Error('search unavailable');
        },
        findSemanticDupes: noSemantic,
        findIssuesByWatchdogKeys: async () => [prior],
        mergeIssuePayload: async (_id, patch) => existing({ ...prior, payload: { ...(prior.payload as object), ...patch } }),
        updateIssuePatch: async (_id, patch) => existing({ ...prior, title: patch.title ?? prior.title }),
      },
    );
    expect(res.created).toBe(false);
    expect(res.reason).toBe('coalesced');
    expect(res.issue?.id).toBe('EI-900');
    expect(d.created).toHaveLength(0);
  });

  it('lands on the KEY row even when the title is completely different', async () => {
    const d = deps();
    const prior = existing({ id: 'EI-901', title: 'totally unrelated wording', payload: { watchdogKey: KEY } });
    const res = await captureImprovement(
      { title: DEAD_ENGINE, kind: 'bug', watchdogKey: KEY, dedupScope: 'open' },
      {
        ...d,
        findSemanticDupes: noSemantic,
        findIssuesByWatchdogKeys: async () => [prior],
        mergeIssuePayload: async (_id, patch) => existing({ ...prior, payload: { ...(prior.payload as object), ...patch } }),
        updateIssuePatch: async (_id, patch) => existing({ ...prior, title: patch.title ?? prior.title }),
      },
    );
    expect(res.created).toBe(false);
    expect(res.reason).toBe('coalesced');
    expect(d.created).toHaveLength(0);
  });

  it('CONTROL — a DIFFERENT watchdogKey still creates (the key net must not become a blanket block)', async () => {
    const d = deps();
    const other = existing({
      id: 'EI-902',
      title: 'some other standing condition',
      payload: { watchdogKey: 'a-different-key' },
    });
    const res = await captureImprovement(
      { title: DEAD_ENGINE, kind: 'bug', watchdogKey: KEY, dedupScope: 'open' },
      { ...d, findSemanticDupes: noSemantic, findIssuesByWatchdogKeys: async () => [other] },
    );
    expect(res.created).toBe(true);
    expect(d.created).toHaveLength(1);
  });

  it('CONTROL — a DRILL-origin exact-key row never suppresses a real organic outage filing', async () => {
    const d = deps();
    const drill = existing({
      id: 'EI-903',
      title: DEAD_ENGINE,
      payload: { watchdogKey: KEY },
      signalOrigin: 'drill',
    });
    const res = await captureImprovement(
      { title: DEAD_ENGINE, kind: 'bug', watchdogKey: KEY, dedupScope: 'open' },
      { ...d, findSemanticDupes: noSemantic, findIssuesByWatchdogKeys: async () => [drill] },
    );
    expect(res.created).toBe(true);
  });

  it('CONTROL — a RESOLVED exact-key item does not block under dedupScope:open', async () => {
    const d = deps();
    const resolved = existing({
      id: 'EI-904',
      title: DEAD_ENGINE,
      payload: { watchdogKey: KEY },
      state: 'resolved',
    });
    const res = await captureImprovement(
      { title: DEAD_ENGINE, kind: 'bug', watchdogKey: KEY, dedupScope: 'open' },
      { ...d, findSemanticDupes: noSemantic, findIssuesByWatchdogKeys: async () => [resolved] },
    );
    expect(res.created).toBe(true);
  });

  it('a failed exact-key lookup marks coverage degraded instead of a false all-clear', async () => {
    const d = deps();
    const res = await captureImprovement(
      { title: 'novel condition with a key', kind: 'bug', watchdogKey: KEY, dedupScope: 'open' },
      {
        ...d,
        findSemanticDupes: noSemantic,
        findIssuesByWatchdogKeys: async () => {
          throw new Error('key lookup unavailable');
        },
      },
    );
    expect(res.dedupCoverage?.degraded).toBe(true);
  });
});

describe('captureImprovement — NON-observation coalescing by watchdogKey (WI-39594)', () => {
  /** Same stateful store shape as the observation-coalesce fixture above: a 2nd
   *  call genuinely finds the 1st call's row, exercising the real coalesce loop. */
  function keyDeps(): CaptureDeps & {
    created: CreateIssueInput[];
    store: EngineerIssue[];
    occurrences: RecordIssueOccurrenceInput[];
  } {
    const created: CreateIssueInput[] = [];
    const store: EngineerIssue[] = [];
    const occurrences: RecordIssueOccurrenceInput[] = [];
    let nextId = 500;
    return {
      created,
      store,
      occurrences,
      recordIssueOccurrence: async (input) => {
        occurrences.push(input);
        return null;
      },
      searchIssues: async () => [],
      createIssue: async (input) => {
        created.push(input);
        const issue = existing({
          id: `EI-${nextId++}`,
          title: input.title,
          kind: (input.kind as 'bug' | 'change') ?? 'change',
          payload: input.payload ?? null,
          createdBy: input.createdBy ?? null,
        });
        store.push(issue);
        return issue;
      },
      findIssuesByWatchdogKeys: async (keys) =>
        store.filter((i) => {
          const k = (i.payload as Record<string, unknown> | null)?.watchdogKey;
          return typeof k === 'string' && keys.includes(k);
        }),
      mergeIssuePayload: async (id, patch) => {
        const i = store.find((x) => x.id === id);
        if (!i) return null;
        i.payload = { ...(i.payload as Record<string, unknown> | null), ...patch };
        return i;
      },
      updateIssuePatch: async (id, patch) => {
        const i = store.find((x) => x.id === id);
        if (!i) return null;
        if (patch.title !== undefined) i.title = patch.title;
        if (patch.body !== undefined) i.body = patch.body;
        return i;
      },
    };
  }

  it('re-firing a keyed detector twice yields ONE open row — 2nd call coalesces (repeatCount 2, title refreshed)', async () => {
    const d = keyDeps();
    const first = await captureImprovement(
      {
        title: 'Gym champion promoted: judge@h-pao cycle 4 — consider generalizing',
        kind: 'change',
        lane: 'improvement',
        watchdogKey: 'gym-champion:h-pao:judge',
      },
      d,
    );
    expect(first.created).toBe(true);
    expect(d.created).toHaveLength(1);
    expect((d.store[0].payload as Record<string, unknown>).watchdogKey).toBe('gym-champion:h-pao:judge');

    const second = await captureImprovement(
      {
        title: 'Gym champion promoted: judge@h-pao cycle 5 — consider generalizing',
        kind: 'change',
        lane: 'improvement',
        watchdogKey: 'gym-champion:h-pao:judge',
      },
      d,
    );
    expect(second.created).toBe(false);
    expect(second.reason).toBe('coalesced');
    expect(d.created).toHaveLength(1); // ONE open item — the WI-39594 acceptance
    expect(d.store).toHaveLength(1);
    expect((d.store[0].payload as Record<string, unknown>).repeatCount).toBe(2);
    expect(d.store[0].title).toBe('Gym champion promoted: judge@h-pao cycle 5 — consider generalizing');
    expect(second.issue?.id).toBe(first.issue?.id);
    expect(second.coalescedOnto).toMatchObject({ id: first.issue?.id, repeatCount: 2 });
  });

  it('key-coalesce WINS over force:true — a forced detector re-fire refreshes, never forks (the champion-escalation dupe class)', async () => {
    const d = keyDeps();
    await captureImprovement(
      {
        title: 'Hive canary papercusp/WI-1 breached its 30min completion SLA',
        kind: 'bug',
        force: true,
        watchdogKey: 'hive-canary-sla:papercusp',
      },
      d,
    );
    const second = await captureImprovement(
      {
        title: 'Hive canary papercusp/WI-2 breached its 30min completion SLA',
        kind: 'bug',
        force: true,
        watchdogKey: 'hive-canary-sla:papercusp',
      },
      d,
    );
    expect(second.created).toBe(false);
    expect(second.reason).toBe('coalesced');
    expect(d.created).toHaveLength(1);
    expect((d.store[0].payload as Record<string, unknown>).repeatCount).toBe(2);
  });

  it('CONTROL: a different watchdogKey files fresh — coalesce is keyed identity, not a blanket suppressor', async () => {
    const d = keyDeps();
    await captureImprovement(
      { title: 'Hive canary a/WI-1 breached its SLA', kind: 'bug', watchdogKey: 'hive-canary-sla:a' },
      d,
    );
    const second = await captureImprovement(
      { title: 'Hive canary b/WI-9 breached its SLA', kind: 'bug', watchdogKey: 'hive-canary-sla:b' },
      d,
    );
    expect(second.created).toBe(true);
    expect(d.created).toHaveLength(2);
  });

  it('CONTROL: a RESOLVED prior with the same key never coalesces — under dedupScope:open a recurrence re-files fresh', async () => {
    const d = keyDeps();
    await captureImprovement(
      { title: 'live-federation-gate RED: content-matrix failed (t1)', kind: 'bug', dedupScope: 'open', watchdogKey: 'live-federation-gate-red:papercusp' },
      d,
    );
    d.store[0].state = 'resolved';
    const second = await captureImprovement(
      { title: 'live-federation-gate RED: content-matrix failed (t2)', kind: 'bug', dedupScope: 'open', watchdogKey: 'live-federation-gate-red:papercusp' },
      d,
    );
    expect(second.created).toBe(true);
    expect(d.created).toHaveLength(2);
  });

  it('CONTROL: an open OBSERVATION-lane row with the same key is NOT a coalesce target for a non-observation filing (pre-existing exact-key block stands)', async () => {
    const d = keyDeps();
    await captureImprovement(
      { title: 'sensor reading', kind: 'change', lane: 'observation', watchdogKey: 'shared:key' },
      d,
    );
    const second = await captureImprovement(
      { title: 'real improvement filing', kind: 'change', watchdogKey: 'shared:key' },
      d,
    );
    expect(second.reason).not.toBe('coalesced');
    expect(d.created).toHaveLength(1); // blocked as likely-duplicate — never merged INTO the observation row
  });
});
