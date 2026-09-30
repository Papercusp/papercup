/**
 * plans.provenance read model (plan-item-provenance-2026-09-29 P-004, R-5): the pure
 * builder. Every assertion reads the view the owner is shown.
 */
import { describe, expect, it } from 'vitest';
import { buildPlanProvenance, provenanceSourceRefs } from './plan-provenance-read';
import type { ActivationAuditPayload, PlanAudit } from './plan-audits';
import type { SourceTurn } from './activation-item-provenance';

const ref = (turn: number) => `session_turn:claude:s1:${turn}`;
const OWNER = { speaker: 'user', text: 'Make every item trace back to what I said.', verdict: 'owner-turn' as const };
const ASSISTANT = { speaker: 'assistant', text: 'I will also add a dashboard.', verdict: 'not-user-turn' as const };
const TURNS = new Map<string, Pick<SourceTurn, 'speaker' | 'text' | 'verdict'>>([
  [ref(1), OWNER],
  [ref(2), ASSISTANT],
]);

const plan = (items: string[]) =>
  `---\ntitle: Plan\nslug: plan-a\nstatus: active\ncreated: 2026-09-29\nupdated: 2026-09-29\nowner: test\n---\n\n## Items\n\n${items.join('\n')}\n`;
const ITEMS = [
  '- **P-001** `todo` Trace items to the owner.',
  '- **P-002** `todo` Follow-up the owner implied.',
  '- **P-003** `todo` Agent idea.',
];

const mapping = (id: string, refs: number[], targets: string[], disposition: 'covered' | 'repaired' | 'rejected' | 'open' = 'covered') => ({
  id,
  sourceRefs: refs.map(ref),
  requirement: `requirement ${id}`,
  planTargets: targets,
  disposition,
});

function auditWith(activation: Partial<ActivationAuditPayload>, over: Partial<PlanAudit> = {}): PlanAudit {
  return {
    planSlug: 'plan-a',
    harnessSlug: 'papercusp',
    auditSeq: 3,
    createdBy: 'su-auditor',
    createdAt: '2026-09-29T20:00:00Z',
    auditKind: 'activation',
    auditedSha: null,
    auditedPlanRevision: { id: 9, seq: 4, contentHash: 'hash-4' },
    items: [],
    findings: [],
    summary: null,
    activation: {
      sourceRanges: [{ sourceKind: 'claude', sessionId: 's1', fromTurn: 0, toTurn: 5 }],
      mappings: [],
      repairedOmissions: [],
      rejectedOrSuperseded: [],
      unresolvedBlockers: [],
      ...activation,
    },
    ...over,
  };
}

const enforcedAudit = auditWith({
  mappings: [
    mapping('M-001', [1], ['P-001']),
    mapping('M-002', [2], ['P-003'], 'covered'),
    mapping('M-003', [1], ['section:Goal'], 'rejected'),
    mapping('M-004', [1], ['R-1'], 'open'),
  ],
  itemProvenance: [
    { itemId: 'P-002', kind: 'derived', from: ['P-001'] },
    { itemId: 'P-003', kind: 'agent-added', reason: 'A dashboard helps review.' },
  ],
  itemProvenanceCheck: {
    version: 1,
    enforced: true,
    items: { 'P-001': 'owner', 'P-002': 'derived', 'P-003': 'agent-added' },
    unresolved: [],
    refOrigins: { [ref(1)]: 'owner-turn', [ref(2)]: 'not-user-turn' },
  },
});

const build = (audit: PlanAudit | null, items = ITEMS, currentHash = 'hash-4') =>
  buildPlanProvenance({
    planSlug: 'plan-a',
    harnessSlug: 'papercusp',
    planContent: plan(items),
    currentRevision: { seq: 4, contentHash: currentHash },
    audit,
    turns: TURNS,
  });

describe('buildPlanProvenance — items (R-5)', () => {
  it('labels every current item and quotes its sources with speaker and verdict', () => {
    const view = build(enforcedAudit);

    expect(view.items.map((item) => [item.itemId, item.label])).toEqual([
      ['P-001', 'owner'],
      ['P-002', 'derived'],
      ['P-003', 'agent-added'],
    ]);
    expect(view.items[0].sources).toEqual([
      { ref: ref(1), speaker: 'user', verdict: 'owner-turn', owner: true, excerpt: OWNER.text },
    ]);
    expect(view.items[1]).toMatchObject({ derivedFrom: ['P-001'] });
    expect(view.items[2]).toMatchObject({ agentReason: 'A dashboard helps review.' });
    expect(view.counts).toMatchObject({ owner: 1, derived: 1, 'agent-added': 1, unresolved: 0, 'not-audited': 0 });
    expect(view.audit).toMatchObject({ auditSeq: 3, enforced: true });
    expect(view.grandfathered).toBe(false);
  });

  it('never labels an assistant turn as owner speech', () => {
    const view = build(enforcedAudit);
    const assistantQuote = view.items[2].sources.find((source) => source.ref === ref(2));

    expect(assistantQuote).toMatchObject({ speaker: 'assistant', verdict: 'not-user-turn', owner: false });
    expect(view.items[2].label).not.toBe('owner');
  });

  it('judges with the verdicts the audit stored, not a live re-read (D-005)', () => {
    // The live corpus now reads turn 2 as owner speech; the audit stored it as assistant.
    const view = buildPlanProvenance({
      planSlug: 'plan-a',
      harnessSlug: 'papercusp',
      planContent: plan(ITEMS),
      currentRevision: null,
      audit: enforcedAudit,
      turns: new Map([...TURNS, [ref(2), { ...ASSISTANT, verdict: 'owner-turn' as const }]]),
    });

    expect(view.items[2].sources[0]).toMatchObject({ verdict: 'not-user-turn', owner: false });
  });

  it('lists items added after the audit as not-audited and marks the view stale', () => {
    const view = build(enforcedAudit, [...ITEMS, '- **P-004** `todo` Added later.'], 'hash-5');

    expect(view.items.map((item) => item.label)).toContain('not-audited');
    expect(view.unauditedItems).toEqual(['P-004']);
    expect(view.stale).toBe(true);
    expect(view.auditedRevision).toMatchObject({ seq: 4, contentHash: 'hash-4' });
    expect(view.currentRevision).toEqual({ seq: 4, contentHash: 'hash-5' });
  });

  it('is not stale when the audited revision is current and every item was audited', () => {
    expect(build(enforcedAudit).stale).toBe(false);
  });

  it('omits dropped items and never omits a current one', () => {
    const view = build(enforcedAudit, [...ITEMS.slice(0, 2), '- **P-003** `dropped` Agent idea.']);

    expect(view.items.map((item) => item.itemId)).toEqual(['P-001', 'P-002']);
  });

  it('computes labels live for an audit recorded before item provenance, and says so', () => {
    const legacy = auditWith({ mappings: [mapping('M-001', [1], ['P-001']), mapping('M-002', [2], ['P-002'])] });
    const view = build(legacy);

    expect(view.grandfathered).toBe(true);
    expect(view.audit?.enforced).toBeNull();
    expect(view.items.map((item) => [item.itemId, item.label, item.reason ?? null])).toEqual([
      ['P-001', 'owner', null],
      ['P-002', 'unresolved', 'no_owner_ref'],
      ['P-003', 'unresolved', 'no_mapping'],
    ]);
  });

  it('shows every item as not-audited when there is no activation audit', () => {
    const view = build(null);

    expect(view.status).toBe('no-audit');
    expect(view.items.every((item) => item.label === 'not-audited')).toBe(true);
    expect(view.requests).toEqual([]);
  });
});

describe('buildPlanProvenance — requests (R-5)', () => {
  it('orders rejected, then open, then covered — and omits none', () => {
    const view = build(enforcedAudit);

    expect(view.requests.map((request) => [request.mappingId, request.disposition])).toEqual([
      ['M-003', 'rejected'],
      ['M-004', 'open'],
      ['M-001', 'covered'],
      ['M-002', 'covered'],
    ]);
    expect(view.requests[0].sources[0]).toMatchObject({ speaker: 'user', owner: true });
  });

  it('collects every cited source ref once, for one batched turn read', () => {
    expect(provenanceSourceRefs(enforcedAudit)).toEqual([ref(1), ref(2)]);
    expect(provenanceSourceRefs(null)).toEqual([]);
  });
});
