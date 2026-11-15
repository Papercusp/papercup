import { describe, expect, it, vi } from 'vitest';
import { censusSites, changedSites } from '../../../scripts/lib/source-path-census.mjs';

const behaviorContractResolver = vi.fn(async () => ({ groups: [], enforceable: [] }));

/**
 * R23 detector calibration, using the existing source-census implementation.
 * These intentionally small source specimens are NOT an eight-flow inventory,
 * ordinary-input replay, frozen output oracle or independent acceptance proof.
 * They keep the no-residue source comparison falsifiable while those separate
 * obligations remain UNKNOWN. Never give these the eight declared flow names.
 */
describe('paperwork census source-diff controls', () => {
  const baseline = `const args = z.object({ id: z.string() });
    async function handler(input) { return normalWrite(input); }`;
  const frozen = censusSites('ordinary-input.ts', baseline);

  it('finds no source residue for the unchanged ordinary surface', () => {
    expect(changedSites(frozen, censusSites('ordinary-input.ts', baseline))).toEqual({
      addedOrChanged: [], removedOrChanged: [],
    });
  });

  it.each([
    ['form', 'mandatoryForm'],
    ['report', 'mandatoryReport'],
    ['relevance label', 'relevanceLabel'],
    ['checkpoint section', 'checkpointSection'],
    ['copied receipt', 'copiedReceipt'],
  ])('detects an added required %s without changing the frozen source', (_category, field) => {
    const mutant = baseline.replace('id: z.string()', `id: z.string(), ${field}: z.string()`);
    const delta = changedSites(frozen, censusSites('ordinary-input.ts', mutant));
    expect(delta.addedOrChanged.some(site => site.expression === 'z.object' && site.source.includes(field))).toBe(true);
    expect(delta.removedOrChanged.some(site => site.expression === 'z.object')).toBe(true);
    expect(frozen.sha256).toBe(censusSites('ordinary-input.ts', baseline).sha256);
  });

  it('detects a newly required duplicate call even when the input schema is unchanged', () => {
    const mutant = baseline.replace('return normalWrite(input);', 'normalWrite(input); return normalWrite(input);');
    const current = censusSites('ordinary-input.ts', mutant);
    expect(current.sites.find(site => site.expression === 'z.object')?.fingerprint)
      .toBe(frozen.sites.find(site => site.expression === 'z.object')?.fingerprint);
    const delta = changedSites(frozen, current);
    expect(delta.addedOrChanged.filter(site => site.expression === 'normalWrite')).toHaveLength(1);
    expect(delta.removedOrChanged).toEqual([]);
  });

  it('retains a removed surface as source residue instead of an empty passing comparison', () => {
    const current = censusSites('ordinary-input.ts', baseline.slice(0, baseline.indexOf('async function')));
    const delta = changedSites(frozen, current);
    expect(delta.addedOrChanged).toEqual([]);
    expect(delta.removedOrChanged.map(site => site.expression)).toEqual(['normalWrite']);
  });
});

describe('paperwork census non-call surface controls', () => {
  const census = (source: string) => censusSites('ordinary-input.ts', source, { includeDefinitions: true });

  it.each([
    ['input type', 'export interface Input { id: string }', 'export interface Input { id: string; mandatoryForm: string }'],
    ['prompt', "export const instructions = 'Submit the existing id.';",
      "export const instructions = 'Submit the existing id and a mandatory report.';"],
    ['adapter', 'export const adapter = { required: ["id"] };',
      'export const adapter = { required: ["id", "copiedReceipt"] };'],
    ['gate', 'export function handler(input) { if (!input.id) throw "id required"; return input.id; }',
      'export function handler(input) { if (!input.id || !input.relevanceLabel) throw "label required"; return input.id; }'],
    ['assignment', 'requirements.checkpointSection = false;', 'requirements.checkpointSection = true;'],
  ])('retains a changed %s whose source contains no call or import', (_category, before, after) => {
    // The call inventory is legitimately empty. It cannot stand in for the
    // concrete-surface inventory required by R23.
    expect(censusSites('ordinary-input.ts', before).sites).toEqual([]);
    expect(censusSites('ordinary-input.ts', after).sites).toEqual([]);
    const delta = changedSites(census(before), census(after));
    expect(delta.addedOrChanged.some(site => site.kind === 'surface-definition')).toBe(true);
    expect(delta.removedOrChanged.some(site => site.kind === 'surface-definition')).toBe(true);
    expect(delta.addedOrChanged.every(site => site.calleeCoverage === null)).toBe(true);
  });

  it('keeps duplicate calls visible when definition candidates are included', () => {
    const before = 'function handler(input) { return normalWrite(input); }';
    const after = 'function handler(input) { normalWrite(input); return normalWrite(input); }';
    const delta = changedSites(census(before), census(after));
    expect(delta.addedOrChanged.filter(site => site.expression === 'normalWrite')).toHaveLength(1);
    expect(delta.addedOrChanged.some(site => site.expression === 'FunctionDeclaration')).toBe(true);
  });

  it('retains removal of a non-call surface and leaves the frozen inventory unchanged', () => {
    const source = 'export interface Input { id: string }';
    const frozen = census(source);
    const original = frozen.sites.map(site => site.fingerprint);
    const delta = changedSites(frozen, census(''));
    expect(delta.addedOrChanged).toEqual([]);
    expect(delta.removedOrChanged.some(site => site.expression === 'InterfaceDeclaration')).toBe(true);
    expect(frozen.sites.map(site => site.fingerprint)).toEqual(original);
    expect(frozen.sha256).toBe(census(source).sha256);
  });

  it('does not manufacture a difference for an unchanged non-call surface', () => {
    const source = "export const instructions = 'Use the existing receipt.';";
    expect(changedSites(census(source), census(source))).toEqual({ addedOrChanged: [], removedOrChanged: [] });
  });
});

vi.mock('./plan-decisions-claim-port', () => ({
  getClaimTimePlanDecisions: vi.fn(async () => null),
  renderPlanDecisionsNote: vi.fn(),
}));
vi.mock('./prior-attempt-context', () => ({
  getClaimTimePriorAttemptBrief: vi.fn(async () => null),
}));
vi.mock('./premises-claim-port', () => ({
  getClaimTimePremises: vi.fn(async () => null),
}));
vi.mock('./agent-tools/work_items/retraction-advisory', () => ({
  getClaimTimeRetractionAdvisory: vi.fn(async () => null),
}));
vi.mock('./work-item-prior-work', () => ({
  getClaimTimeAuthorshipRevalidationHint: vi.fn(async () => null),
  authorshipRevalidationWarning: vi.fn(() => null),
}));
vi.mock('./work-item-plan-contradiction', () => ({
  getClaimTimePlanItemContradiction: vi.fn(async () => null),
  planItemContradictionWarning: vi.fn(() => null),
}));
vi.mock('./agent-tools/plans/behavior-contract-resolver', () => ({
  resolveWorkItemBehaviorContract: behaviorContractResolver,
}));
// EI-19418245218824265. Unlike the row-reading legs — which return null here because
// the fixture row is empty — this one reads the TREE, so it answers from repo content
// no fixture controls. Unmocked it runs a real `git grep` for the synthetic id, and
// `WI-1` is a SUBSTRING of every real `WI-1234`/`WI-19418…` in the tree, so it returns
// hundreds of chars of unrelated hits and the "every leg is empty" premise below is
// silently false. Mocked for the same reason as the seven above; the port's own
// behaviour is tested against injected deps in `source-citation-claim-port.test.ts`.
vi.mock('./source-citation-claim-port', () => ({
  getClaimTimeSourceCitation: vi.fn(async () => null),
  sourceCitationWarning: vi.fn(() => null),
}));
vi.mock('./stale-path-hints-claim-port', () => ({
  getClaimTimeStalePathAdvisory: vi.fn(async () => ({
    stalePathRefs: ['apps/operator/app/_components/LeftSidebar.tsx'],
    stalePathRefsNote: 'advisory stale path refs',
  })),
}));

import { buildClaimTimeEnrichment } from './claim-time-enrichment';
import type { BoundedPriorAttemptBrief } from './prior-attempt-context';
import type { ClaimTimePlanDecision } from './plan-decisions-claim-port';

it('matches the complete paperwork authority history and omission manifest in claim enrichment', async () => {
  const [decisionsPort, historyPort] = await Promise.all([
    import('./plan-decisions-claim-port'), import('./prior-attempt-context'),
  ]);
  // Frozen upstream values test delivery, independently of either upstream selector.
  const decisions: ClaimTimePlanDecision[] = [
    { id: 'D-008', title: 'Current authority', snippet: 'P-018 preserves the selected route.', provenance: { kind: 'unrecorded' } },
    { id: 'D-009', title: 'Retraction', snippet: 'Old proof is invalid; retain test-run:42.', provenance: { kind: 'unrecorded' } },
  ];
  const history: BoundedPriorAttemptBrief = {
    schemaVersion: 'prior-attempt-brief-v1', fingerprint: 'frozen-history-input',
    authority: [{ rawRef: 'plan#D-009', authority: 'retraction', scope: 'same-spec', text: 'Old proof is invalid; retain test-run:42.' }],
    attempts: [], residue: [{ rawRef: 'WI-2#checkpoint', items: ['Native delivery remains.'] }],
    rawRefs: ['plan#D-009'], protectedRefs: { authority: [{ authority: 'retraction', rawRef: 'plan#D-009' }], residue: ['WI-2#checkpoint'] },
    omission: { omittedRecords: 1, omittedByAuthority: { comment: 1 }, omittedRefs: [{ rawRef: 'WI-2#comment:1', authority: 'comment', scope: 'self', reason: 'budget' }], omittedRefsTruncated: false, sourceCount: 2, deduplicatedCount: 0, truncated: true },
    estimatedTokens: 250, serializedChars: 1000,
  };
  // Keep expected literals separate from objects the consumer can mutate.
  // Otherwise an in-place reorder changes both actual and expected decisions.
  vi.mocked(decisionsPort.getClaimTimePlanDecisions).mockResolvedValueOnce({
    planSlug: 'task-plan', decisions: structuredClone(decisions), totalDecisions: 3, totalLocalDecisions: 3,
    totalAffectedDecisions: 0, affectedDecisions: 0, authorityReadFailed: false,
    omittedDecisionRefs: ['task-plan#D-001'],
  });
  vi.mocked(decisionsPort.renderPlanDecisionsNote).mockReturnValueOnce('Omitted: task-plan#D-001; recover with plans:get.');
  vi.mocked(historyPort.getClaimTimePriorAttemptBrief).mockResolvedValueOnce(structuredClone(history));
  const result = await buildClaimTimeEnrichment({ planSlug: 'task-plan', planItemId: 'P-018' });
  const actual = { decisions: result.planDecisions, note: result.planDecisionsNote, history: result.priorAttemptBrief };
  const check = (candidate: typeof actual) => expect(candidate).toEqual({ decisions, note: 'Omitted: task-plan#D-001; recover with plans:get.', history });
  check(actual);
  expect(result.enrichmentDelivery.delivered).toEqual(expect.arrayContaining(['planDecisions', 'priorAttemptBrief']));
  expect(historyPort.getClaimTimePriorAttemptBrief).toHaveBeenLastCalledWith({ planSlug: 'task-plan', planItemId: 'P-018', workItemId: null, harness: null });
  const missing = structuredClone(actual); missing.history = undefined;
  const extra = structuredClone(actual); extra.decisions = [...decisions, { id: 'D-999', title: 'Unrelated', snippet: 'Other task.', provenance: { kind: 'unrecorded' } }];
  const clipped = structuredClone(actual); clipped.history = { ...history, authority: [{ ...history.authority[0], text: 'Old proof' }] };
  const reordered = structuredClone(actual); reordered.decisions = [...decisions].reverse();
  for (const mutant of [missing, extra, clipped, reordered]) expect(() => check(mutant)).toThrow();
});

it('passes direct plan-item scope into governing-decision delivery before a work-item exists', async () => {
  const ports = await import('./plan-decisions-claim-port');
  await buildClaimTimeEnrichment({ planSlug: 'task-plan', planItemId: 'P-018' });
  expect(ports.getClaimTimePlanDecisions).toHaveBeenLastCalledWith(expect.objectContaining({
    planSlug: 'task-plan', planItemIds: ['P-018'],
  }));
});

describe('buildClaimTimeEnrichment behavior-contract leg', () => {
  it('does not call the resolver when a partial subject has no work-item id', async () => {
    const enrichment = await buildClaimTimeEnrichment({
      workItem: { harness: 'papercusp', payload: null },
    });

    // The CONTEXT is empty — unchanged, and still the point of this test.
    const { enrichmentDelivery, ...context } = enrichment;
    expect(context).toEqual({});

    expect(behaviorContractResolver).not.toHaveBeenCalled();

    // ...but "empty" is no longer indistinguishable from "broken" (P-013): the delivery
    // record states WHY nothing came back. Asserted here rather than in the new suite
    // below because this is the exact call that used to render as a bare `{}`.
    expect(enrichmentDelivery.delivered).toEqual([]);
    expect(enrichmentDelivery.failed).toEqual([]);
    expect(enrichmentDelivery.omitted.find((o) => o.leg === 'behaviorContract')?.reason).toBe('skipped-no-input');
  });
});

describe('buildClaimTimeEnrichment stalePathRefs leg (EI-20049758099997696)', () => {
  it('carries title/summary refs through the shared claim-time enrichment', async () => {
    const enrichment = await buildClaimTimeEnrichment({
      workItem: {
        id: 'WI-stale-ref',
        title: 'Remove the old sidebar',
        summary: 'The old path is apps/operator/app/_components/LeftSidebar.tsx',
        payload: null,
      },
    });
    expect(enrichment.stalePathRefs).toEqual(['apps/operator/app/_components/LeftSidebar.tsx']);
    expect(enrichment.stalePathRefsNote).toBe('advisory stale path refs');
    expect(enrichment.enrichmentDelivery.delivered).toContain('pathHints');
  });
});

/**
 * P-013 instrumentation — the claim-context delivery record.
 *
 * These tests exist because the three situations below used to be ONE value (`null`),
 * and the middle one — a leg that THREW — is the only one that means something is
 * broken. A claimant handed less context than the system believes it hands out had no
 * way to know, and neither did anyone else.
 */
describe('buildClaimTimeEnrichment — delivery record (P-013)', () => {
  it('distinguishes a leg that THREW from one that was skipped and one that found nothing', async () => {
    const ports = await import('./plan-decisions-claim-port');
    // A leg that breaks — the case that was previously indistinguishable from silence.
    vi.mocked(ports.getClaimTimePlanDecisions).mockRejectedValueOnce(new Error('read failed'));

    const enrichment = await buildClaimTimeEnrichment({
      workItem: { id: 'WI-1', harness: 'papercusp', payload: null },
      planSlug: 'some-plan',
    });

    // FAILED: ran against real inputs and threw.
    expect(enrichment.enrichmentDelivery.failed).toEqual(['planDecisions']);
    expect(enrichment.enrichmentDelivery.omitted.find((o) => o.leg === 'planDecisions')?.reason).toBe('failed');

    // EMPTY: ran against real inputs and legitimately found nothing. Same null, and it
    // must NOT be reported as a failure — over-reporting would make the signal useless.
    expect(enrichment.enrichmentDelivery.omitted.find((o) => o.leg === 'premises')?.reason).toBe('empty');

    // SKIPPED: this surface had no payload for the leg to read.
    expect(enrichment.enrichmentDelivery.omitted.find((o) => o.leg === 'pathHints')?.reason).toBe('skipped-no-input');
  });

  it('a broken leg still degrades the claim rather than failing it', async () => {
    const ports = await import('./plan-decisions-claim-port');
    vi.mocked(ports.getClaimTimePlanDecisions).mockRejectedValueOnce(new Error('read failed'));

    // The pre-existing resilience contract, re-asserted because the refactor moved every
    // catch. One broken guard must never take down a claim — recording the reason is an
    // addition to that behaviour, never a relaxation of it.
    await expect(
      buildClaimTimeEnrichment({ workItem: { id: 'WI-1', harness: 'papercusp', payload: null }, planSlug: 'p' }),
    ).resolves.toBeTruthy();
  });

  it('carries an actionable recovery pointer ONLY when a leg actually failed', async () => {
    const healthy = await buildClaimTimeEnrichment({
      workItem: { id: 'WI-1', harness: 'papercusp', payload: null },
    });
    // No failures ⇒ no pointer. A permanently-present pointer is noise that trains
    // readers to skip the field on the one claim where it matters.
    expect(healthy.enrichmentDelivery.recover).toBeUndefined();

    const ports = await import('./plan-decisions-claim-port');
    vi.mocked(ports.getClaimTimePlanDecisions).mockRejectedValueOnce(new Error('read failed'));
    const degraded = await buildClaimTimeEnrichment({
      workItem: { id: 'WI-1', harness: 'papercusp', payload: null },
      planSlug: 'p',
    });
    expect(degraded.enrichmentDelivery.recover).toContain('planDecisions');
    // It must say the context is MISSING, not absent — the distinction a claimant acts on.
    expect(degraded.enrichmentDelivery.recover).toMatch(/UNVERIFIED/);
  });

  it('accounts for EVERY registered leg, so a registered-but-unattached leg cannot vanish', async () => {
    const { CLAIM_TIME_ENRICHMENT_LEGS } = await import('./claim-time-enrichment');
    const enrichment = await buildClaimTimeEnrichment({
      workItem: { id: 'WI-1', harness: 'papercusp', payload: null },
    });

    const seen = [
      ...enrichment.enrichmentDelivery.delivered,
      ...enrichment.enrichmentDelivery.omitted.map((o) => o.leg),
    ].sort();
    // The census iterates the REGISTRY, not the outcomes it happened to collect — a leg
    // added to the registry but never wired would otherwise be missing from both lists,
    // and a delivery record that cannot report a missing leg has no purpose.
    expect(seen).toEqual([...CLAIM_TIME_ENRICHMENT_LEGS].sort());
  });

  it('measures the context size WITHOUT counting the delivery record itself', async () => {
    const enrichment = await buildClaimTimeEnrichment({
      workItem: { id: 'WI-1', harness: 'papercusp', payload: null },
    });

    // Every leg is empty here, so the context is `{}` — two characters. Counting the
    // record itself would report a size no consumer of the context actually pays, and
    // would drift whenever this record's own shape changed.
    expect(enrichment.enrichmentDelivery.serializedChars).toBe(2);
  });
});
