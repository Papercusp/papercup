import { describe, expect, it } from 'vitest';
import {
  buildBoundedPriorAttemptBrief,
  collectPriorAttempts,
  compilePriorAttempts,
  getClaimTimePriorAttemptBrief,
  type PriorAttemptSource,
} from './prior-attempt-context';
import type { WorkItem } from './work-items';

function source(overrides: Partial<PriorAttemptSource> = {}): PriorAttemptSource {
  return {
    scope: 'plan-wide',
    authority: 'comment',
    rawRef: 'WI-1#comment:1',
    at: '2026-08-20T12:00:00.000Z',
    text: 'Tried the first approach.',
    ...overrides,
  };
}

describe('compilePriorAttempts', () => {
  it('orders canonical authority first, then attempt scope before lower-authority prose', () => {
    const result = compilePriorAttempts([
      source({ rawRef: 'plan#D-001', authority: 'plan-decision', text: 'Plan-wide ruling.' }),
      source({ rawRef: 'WI-2#comment:1', scope: 'same-spec', text: 'Same-spec comment.' }),
      source({ rawRef: 'WI-2#checkpoint', scope: 'same-spec', authority: 'checkpoint', text: 'Checkpoint.' }),
      source({ rawRef: 'WI-2#comment:2', scope: 'same-spec', authority: 'retraction', text: 'False premise: helper was absent.' }),
      source({ rawRef: 'plan#SPEC-1@2', scope: 'same-spec', authority: 'current-spec', text: 'Current behavior.' }),
      source({ rawRef: 'WI-3#completion', scope: 'same-plan-item', authority: 'verified-completion', text: 'Passed.' }),
    ]);
    expect(result.records.map((record) => record.rawRef)).toEqual([
      'plan#SPEC-1@2',
      'plan#D-001',
      'WI-2#comment:2',
      'WI-2#checkpoint',
      'WI-2#comment:1',
      'WI-3#completion',
    ]);
  });

  it('keeps the newest/richer duplicate raw authority ref exactly once', () => {
    const result = compilePriorAttempts([
      source({ text: 'old', at: '2026-08-20T10:00:00Z' }),
      source({ text: 'new and richer', at: '2026-08-20T11:00:00Z' }),
    ]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.text).toBe('new and richer');
    expect(result.deduplicatedCount).toBe(1);
  });

  it('normalizes root cause, retraction, files, tests, and residue without inventing absent fields', () => {
    const result = compilePriorAttempts([
      source({
        authority: 'retraction',
        text: [
          'Approach: changed packages/operator-core/lib/foo.ts.',
          'Root cause: caller discarded the revision.',
          'False premise: there was no existing reader.',
          'Tests: npm run test:file -- packages/operator-core/lib/foo.test.ts',
          'Residue: migration verification remains.',
        ].join('\n'),
      }),
    ]);
    const record = result.records[0]!;
    expect(record.rootCauses).toEqual(['caller discarded the revision.']);
    expect(record.falsePremises).toEqual(['there was no existing reader.']);
    expect(record.touchedFiles).toEqual(expect.arrayContaining([
      'packages/operator-core/lib/foo.ts',
      'packages/operator-core/lib/foo.test.ts',
    ]));
    expect(record.tests.join(' ')).toContain('npm run test:file');
    expect(record.residue).toEqual(['migration verification remains.']);
    expect(record.outcome).toBeNull();
  });

  it('uses deterministic fingerprints independent of caller input order', () => {
    const a = source({ rawRef: 'a', scope: 'same-spec', text: 'A' });
    const b = source({ rawRef: 'b', authority: 'checkpoint', text: 'B' });
    expect(compilePriorAttempts([a, b]).fingerprint).toBe(compilePriorAttempts([b, a]).fingerprint);
  });
});

describe('buildBoundedPriorAttemptBrief', () => {
  it('keeps canonical authority and residue while disclosing large-history omissions', () => {
    const sources: PriorAttemptSource[] = [
      source({ rawRef: 'plan#SPEC-1@3', authority: 'current-spec', scope: 'same-spec', text: 'Current contract.' }),
      source({ rawRef: 'plan#D-008', authority: 'plan-decision', text: 'Canonical authority wins.' }),
      source({ rawRef: 'WI-2#comment:9', authority: 'retraction', scope: 'same-spec', text: 'False premise: the reader was absent.' }),
      source({ rawRef: 'WI-2#checkpoint', authority: 'checkpoint', scope: 'same-spec', text: 'Residue: live verification remains.' }),
      ...Array.from({ length: 80 }, (_, index) => source({
        rawRef: `WI-${index + 10}#comment:1`,
        text: `Attempt ${index} ${'x'.repeat(300)}`,
      })),
    ];
    const brief = buildBoundedPriorAttemptBrief(compilePriorAttempts(sources), {
      maxChars: 5_000,
      maxRecords: 12,
      maxTextChars: 300,
    })!;
    expect(brief.authority.map((record) => record.rawRef)).toEqual([
      'plan#SPEC-1@3', 'plan#D-008', 'WI-2#comment:9',
    ]);
    expect(brief.protectedRefs.authority.map((record) => record.rawRef)).toEqual([
      'plan#SPEC-1@3', 'plan#D-008', 'WI-2#comment:9',
    ]);
    expect(brief.residue).toEqual([{ rawRef: 'WI-2#checkpoint', workItemId: undefined, items: ['live verification remains.'] }]);
    expect(brief.omission.truncated).toBe(true);
    expect(brief.omission.omittedRecords).toBeGreaterThan(0);
    expect(brief.omission.omittedByAuthority.comment).toBeGreaterThan(0);
    expect(brief.serializedChars).toBeLessThanOrEqual(5_000);
    expect(brief.rawRefs).toEqual([...new Set(brief.rawRefs)]);
  });

  it('hard-bounds extreme protected history while retaining every protected raw ref', () => {
    const sources = Array.from({ length: 80 }, (_, index) => source({
      rawRef: `plan#D-${String(index + 1).padStart(3, '0')}`,
      authority: 'plan-decision',
      text: `Decision ${index}: ${'ruling '.repeat(100)}`,
    }));
    const brief = buildBoundedPriorAttemptBrief(compilePriorAttempts(sources), { maxChars: 5_000 })!;
    expect(brief.serializedChars).toBeLessThanOrEqual(5_000);
    expect(brief.protectedRefs.authority).toHaveLength(80);
    expect(brief.protectedRefs.authority.map((entry) => entry.rawRef)).toEqual(sources.map((entry) => entry.rawRef));
    expect(brief.omission.truncated).toBe(true);
  });
});

describe('collectPriorAttempts', () => {
  it('projects existing spec/decision/evidence/checkpoint/thread/completion stores without minting authority', async () => {
    const item = {
      id: 'WI-9',
      family: 'issue',
      harness: 'papercusp',
      sourcePlanItemIds: ['P-009'],
      payload: {},
      terminalCompletionRef: 'npm run test:file -- lib/prior.test.ts passed',
      terminalCompletionEvidence: null,
      completionAuthority: 'verified',
      terminalOwner: 'agent-a',
      closedAt: '2026-08-20T12:00:00Z',
      updatedAt: '2026-08-20T12:00:00Z',
    } as unknown as WorkItem;
    const deps = {
      getPlan: async () => ({ content: '## Decisions\n\n### D-001 — Reuse the reader\nDate: 2026-08-20\nDo not add a ledger.' }),
      specs: async () => [{
        planSlug: 'plan', specId: 'SPEC-1', sourceValId: null, currentRevision: 2, revision: 2,
        planItemId: 'P-009', behavior: 'Compile prior attempts', behaviorClass: 'lifecycle',
        requiredEvidence: ['focused test'], requiredTestLayers: ['unit'], mutationRequired: false,
        lifecycleStatus: 'active', supersedes: null, exemption: null, contentHash: 'hash',
        createdBy: 'author', createdAt: '2026-08-20T09:00:00Z', acceptedBy: 'author',
        acceptedAt: '2026-08-20T09:00:00Z', acceptanceRef: null,
      }],
      edges: async () => [{ workItemId: 'WI-9', planSlug: 'plan', specId: 'SPEC-1', specRevision: 2, specFingerprint: 'hash' }],
      evidence: async () => [{ workItemId: 'WI-9' }],
      item: async () => item,
      items: async () => [item],
      thread: async () => ({
        posts: [{ id: 7, thread_id: 't', author_id: 'agent-a', body: 'False premise: no reader existed.', created_ts: '2026-08-20T11:00:00Z' }],
        total: 1, topics: [], createdAt: '2026-08-20T08:00:00Z',
      }),
      checkpoint: async () => ({ checkpoint: 'Approach: reused the reader.', updatedAtMs: Date.parse('2026-08-20T10:00:00Z') }),
      lifecycle: async () => ({ events: [], flags: { needsHuman: false, claimHold: false, heldOpenBy: null, heldOpenReason: null }, coverage: { auditRows: 0, reopenEntries: 0, notRecorded: [], degraded: false } }),
      priorWork: async () => null,
    };
    const result = await collectPriorAttempts({
      harnessSlug: 'papercusp', planSlug: 'plan', planItemId: 'P-009', workItemId: 'WI-9',
    }, deps as never);
    expect(result.records.map((record) => record.authority)).toEqual([
      'current-spec', 'plan-decision', 'retraction', 'verified-completion', 'checkpoint',
    ]);
    expect(result.records.filter((record) => record.workItemId === 'WI-9').every((record) => record.scope === 'same-spec')).toBe(true);
    expect(result.records.find((record) => record.authority === 'retraction')?.rawRef).toBe('WI-9#comment:7');
  });
});

describe('getClaimTimePriorAttemptBrief', () => {
  it('bounds a pathological history read and fails soft without changing the claim verdict', async () => {
    const never = () => new Promise<never>(() => {});
    const started = performance.now();
    const result = await getClaimTimePriorAttemptBrief({
      planSlug: 'plan', planItemId: 'P-009', workItemId: 'WI-9', timeoutMs: 25,
    }, {
      getPlan: never,
      specs: never,
      edges: never,
      evidence: never,
      item: never,
      items: never,
      thread: never,
      checkpoint: never,
      lifecycle: never,
      priorWork: never,
    } as never);
    expect(result).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});
