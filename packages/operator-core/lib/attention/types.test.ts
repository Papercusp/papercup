/**
 * types.test.ts — focused unit test of the pure deciders / mappers / reducers in
 * the attention read-model (planning-attention-importance / queue-authorization
 * / inbox-tiering). Every assertion pins an exact input → output against the real
 * source: importance ranking, the authorizer/why-gated derivation and its branch
 * ORDER, the triage overlay, the worst-of report tier, and the severity → two
 * independent scales fan-out.
 */
import { describe, it, expect } from 'vitest';
import type { ReportBlock } from '@papercusp/chat-protocol';
import type { Importance } from '@papercusp/plan-parser';
import {
  attentionCategory,
  deriveAuthorization,
  needsHumanForTier,
  triageActionToState,
  applyTriage,
  reportTier,
  importanceRank,
  sortByImportance,
  severityToImportance,
  severityToRiskTier,
  DECISION_RISK_TIER,
  riskTierIsDecision,
  groupByTier,
  type AttentionItem,
  type AttentionKind,
  type AttentionTier,
  type TriageRecord,
} from './types';

/** A complete, throw-away AttentionItem with overridable fields. */
function baseItem(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'plan-item:p/P-001',
    kind: 'plan-item',
    source: 'plan',
    harnessSlug: 'papercup',
    planSlug: 'p',
    itemRef: 'P-001',
    title: 'an item',
    body: '',
    status: 'todo',
    importance: 'normal',
    tier: 'activity',
    needsHuman: false,
    ownerAgentId: null,
    ownerLabel: null,
    triageState: 'untriaged',
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    actions: [],
    ref: { kind: 'plan-item', slug: 'p', itemId: 'P-001' },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// attentionCategory — the kind → autonomy-category lookup deriveAuthorization
// leans on. A governed kind maps to its domain; an ungoverned signal is null.
// ---------------------------------------------------------------------------
describe('attentionCategory', () => {
  it('maps each kind to its disposition category, null for ungoverned signals', () => {
    expect(attentionCategory('plan-item')).toBe('plan-governance');
    expect(attentionCategory('coord-escalation')).toBe('escalations');
    expect(attentionCategory('coord-message')).toBe('inbox-triage');
    expect(attentionCategory('standing-approval')).toBe('system-control');
    expect(attentionCategory('scout-grade')).toBe('ideation-intake');
    // ungoverned signal / status report → null (the fail-safe never-auto path)
    expect(attentionCategory('smoke-fail')).toBeNull();
    expect(attentionCategory('operator-report')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveAuthorization — the A1 authorizer/why-gated split. Branch ORDER is
// load-bearing: needsHuman guard, then null-category fail-safe, then protected,
// then owner-authority, then armed.
// ---------------------------------------------------------------------------
describe('deriveAuthorization', () => {
  it('returns null/null when the item does not need a human, regardless of kind/armed', () => {
    // even a protected, owner-authority standing-approval is null/null when ¬needsHuman
    const item = { kind: 'standing-approval' as AttentionKind, category: 'system-control' as const, needsHuman: false };
    expect(deriveAuthorization(item, false)).toEqual({ whyGated: null, authorizer: null });
    expect(deriveAuthorization(item, true)).toEqual({ whyGated: null, authorizer: null });
  });

  it('a null category is the fail-safe → owner-only / you (never auto an unmapped decision)', () => {
    // smoke-fail has category null; null ?? attentionCategory(smoke-fail) === null
    const item = { kind: 'smoke-fail' as AttentionKind, category: null, needsHuman: true };
    expect(deriveAuthorization(item, true)).toEqual({ whyGated: 'owner-only', authorizer: 'you' });
  });

  it('a PROTECTED category → protected / you, and protected wins over the armed branch', () => {
    const item = { kind: 'standing-approval' as AttentionKind, category: 'system-control' as const, needsHuman: true };
    // armed=true would reach above-ceiling if protected were not checked first
    expect(deriveAuthorization(item, true)).toEqual({ whyGated: 'protected', authorizer: 'you' });
    expect(deriveAuthorization(item, false)).toEqual({ whyGated: 'protected', authorizer: 'you' });
  });

  it('an owner-authority (non-protected) disposition → owner-only / you, ahead of the armed branch', () => {
    // plan-item: category plan-governance (not protected), authority owner
    const item = { kind: 'plan-item' as AttentionKind, category: 'plan-governance' as const, needsHuman: true };
    expect(deriveAuthorization(item, true)).toEqual({ whyGated: 'owner-only', authorizer: 'you' });
    // armed value must NOT change an owner-authority item (owner branch precedes armed)
    expect(deriveAuthorization(item, false)).toEqual({ whyGated: 'owner-only', authorizer: 'you' });
  });

  it('a system-authority, non-protected, queen-eligible item splits on armed', () => {
    // coord-escalation: category escalations (not protected), authority system
    const item = { kind: 'coord-escalation' as AttentionKind, category: 'escalations' as const, needsHuman: true };
    expect(deriveAuthorization(item, false)).toEqual({ whyGated: 'unarmed', authorizer: 'queen-eligible' });
    expect(deriveAuthorization(item, true)).toEqual({ whyGated: 'above-ceiling', authorizer: 'queen-eligible' });
  });

  it('falls back to the kind default when category is undefined (category ?? attentionCategory)', () => {
    // no explicit category → resolves inbox-triage from the kind, system authority, unarmed
    const item = { kind: 'coord-message' as AttentionKind, needsHuman: true };
    expect(deriveAuthorization(item, false)).toEqual({ whyGated: 'unarmed', authorizer: 'queen-eligible' });
  });
});

// ---------------------------------------------------------------------------
// needsHumanForTier — the invariant source of truth: only Decision needs a human.
// ---------------------------------------------------------------------------
describe('needsHumanForTier', () => {
  it('is true only for the decision tier', () => {
    expect(needsHumanForTier('decision')).toBe(true);
    expect(needsHumanForTier('handled')).toBe(false);
    expect(needsHumanForTier('alert')).toBe(false);
    expect(needsHumanForTier('activity')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// triageActionToState — the verb → recorded-state 1:1 map.
// ---------------------------------------------------------------------------
describe('triageActionToState', () => {
  it('maps each triage action to its state', () => {
    expect(triageActionToState('confirm')).toBe('confirmed');
    expect(triageActionToState('escalate')).toBe('escalated');
    expect(triageActionToState('downgrade')).toBe('downgraded');
    expect(triageActionToState('resolve')).toBe('resolved');
  });
});

// ---------------------------------------------------------------------------
// applyTriage — overlays a triage record, recomputing the FINAL tier and
// re-deriving needsHuman from it so the invariant holds.
// ---------------------------------------------------------------------------
describe('applyTriage', () => {
  const rec = (action: TriageRecord['action']): TriageRecord => ({
    action,
    note: `${action}-note`,
    triagedBy: 'op-1',
    triagedAt: '2026-06-30T00:00:00Z',
  });

  it('downgrade → handled / not-needs-human, kept visible with the audit note', () => {
    const out = applyTriage(baseItem({ tier: 'alert', needsHuman: false }), rec('downgrade'));
    expect(out.tier).toBe('handled');
    expect(out.needsHuman).toBe(false);
    expect(out.triageState).toBe('downgraded');
    expect(out.triageNote).toBe('downgrade-note');
    expect(out.triagedBy).toBe('op-1');
    expect(out.triagedAt).toBe('2026-06-30T00:00:00Z');
  });

  it('resolve → handled / not-needs-human', () => {
    const out = applyTriage(baseItem({ tier: 'decision', needsHuman: true }), rec('resolve'));
    expect(out.tier).toBe('handled');
    expect(out.needsHuman).toBe(false);
    expect(out.triageState).toBe('resolved');
  });

  it('escalate → decision / needs-human (promote an under-flagged item)', () => {
    const out = applyTriage(baseItem({ tier: 'activity', needsHuman: false }), rec('escalate'));
    expect(out.tier).toBe('decision');
    expect(out.needsHuman).toBe(true);
    expect(out.triageState).toBe('escalated');
  });

  it('confirm → decision / needs-human (a real decision, now vetted) and preserves identity', () => {
    const out = applyTriage(baseItem({ id: 'keep-me', tier: 'alert', needsHuman: false }), rec('confirm'));
    expect(out.tier).toBe('decision');
    expect(out.needsHuman).toBe(true);
    expect(out.triageState).toBe('confirmed');
    expect(out.id).toBe('keep-me'); // the rest of the item is spread through untouched
  });
});

// ---------------------------------------------------------------------------
// reportTier — worst-of over a report's plan + item statuses. Decision tokens
// win immediately; otherwise any alert token → alert; else activity. Tokens are
// trimmed + lower-cased before matching.
// ---------------------------------------------------------------------------
describe('reportTier', () => {
  const block = (plans: ReportBlock['plans']): ReportBlock => ({ plans });

  it('empty plans → activity', () => {
    expect(reportTier(block([]))).toBe('activity');
  });

  it('a plan with no status and no items → activity', () => {
    expect(reportTier(block([{ title: 'x' }]))).toBe('activity');
  });

  it('a plan-level decision token → decision', () => {
    expect(reportTier(block([{ title: 'x', status: 'review' }]))).toBe('decision');
  });

  it('matches decision/alert tokens case-insensitively and trimmed', () => {
    expect(reportTier(block([{ title: 'x', status: '  REVIEW ' }]))).toBe('decision');
    expect(reportTier(block([{ title: 'x', status: ' Needs_Human ' }]))).toBe('decision');
    expect(reportTier(block([{ title: 'x', status: 'FAILING' }]))).toBe('alert');
  });

  it('alert tokens (blocked/failing/failed/error) with no decision → alert', () => {
    expect(reportTier(block([{ title: 'x', status: 'blocked' }]))).toBe('alert');
    expect(reportTier(block([{ title: 'x', status: 'failed' }]))).toBe('alert');
  });

  it('an unknown token alone → activity (loose pre-sort fall-through)', () => {
    expect(reportTier(block([{ title: 'x', status: 'shipped' }]))).toBe('activity');
  });

  it('descends into items: an item-level decision token → decision', () => {
    expect(
      reportTier(block([{ title: 'x', status: 'active', items: [{ text: 'i', status: 'needs-human' }] }])),
    ).toBe('decision');
  });

  it('descends into items: an item-level alert token (plan unknown) → alert', () => {
    expect(
      reportTier(block([{ title: 'x', status: 'active', items: [{ text: 'i', status: 'error' }] }])),
    ).toBe('alert');
  });

  it('a decision anywhere wins over an earlier alert', () => {
    expect(
      reportTier(block([
        { title: 'A', status: 'failing' }, // alert seen first
        { title: 'B', status: 'review' }, // decision still wins
      ])),
    ).toBe('decision');
  });
});

// ---------------------------------------------------------------------------
// importanceRank / sortByImportance — the within-tier ranker (urgent=0 … low=3,
// unknown → normal), a non-mutating most-important-first sort, stable on ties.
// ---------------------------------------------------------------------------
describe('importanceRank', () => {
  it('ranks the known levels ascending urgent..low', () => {
    expect(importanceRank('urgent')).toBe(0);
    expect(importanceRank('high')).toBe(1);
    expect(importanceRank('normal')).toBe(2);
    expect(importanceRank('low')).toBe(3);
  });

  it('an unrecognized importance falls back to the rank of normal', () => {
    expect(importanceRank('bogus' as Importance)).toBe(2);
    expect(importanceRank('bogus' as Importance)).toBe(importanceRank('normal'));
  });
});

describe('sortByImportance', () => {
  it('orders most-important first without mutating the input', () => {
    const input = [
      { id: 'lo', importance: 'low' as Importance },
      { id: 'ur', importance: 'urgent' as Importance },
      { id: 'no', importance: 'normal' as Importance },
      { id: 'hi', importance: 'high' as Importance },
    ];
    const sorted = sortByImportance(input);
    expect(sorted.map((x) => x.id)).toEqual(['ur', 'hi', 'no', 'lo']);
    // returns a new array; the input order is untouched
    expect(sorted).not.toBe(input);
    expect(input.map((x) => x.id)).toEqual(['lo', 'ur', 'no', 'hi']);
  });

  it('is stable for equal-importance ties (input order preserved)', () => {
    const input = [
      { id: 'a', importance: 'normal' as Importance },
      { id: 'b', importance: 'normal' as Importance },
      { id: 'c', importance: 'urgent' as Importance },
    ];
    expect(sortByImportance(input).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// severityToImportance vs severityToRiskTier — two INDEPENDENT scales derived
// from one severity. They agree on question/advisory but DIVERGE on blocker and
// on the (unreachable-by-type) default arm.
// ---------------------------------------------------------------------------
describe('severityToImportance / severityToRiskTier', () => {
  it('severityToImportance maps the three severities (+ default → normal)', () => {
    expect(severityToImportance('blocker')).toBe('urgent');
    expect(severityToImportance('question')).toBe('high');
    expect(severityToImportance('advisory')).toBe('low');
    // the defensive default arm
    expect(severityToImportance('mystery' as 'blocker')).toBe('normal');
  });

  it('severityToRiskTier maps onto the risk_tier scale (+ default → moderate)', () => {
    expect(severityToRiskTier('blocker')).toBe('critical');
    expect(severityToRiskTier('question')).toBe('high');
    expect(severityToRiskTier('advisory')).toBe('low');
    expect(severityToRiskTier('mystery' as 'blocker')).toBe('moderate');
  });

  it('the two scales diverge on blocker and on the default arm', () => {
    expect(severityToImportance('blocker')).not.toBe(severityToRiskTier('blocker')); // urgent ≠ critical
    expect(severityToImportance('mystery' as 'blocker')).not.toBe(severityToRiskTier('mystery' as 'blocker')); // normal ≠ moderate
  });
});

// ---------------------------------------------------------------------------
// riskTierIsDecision — the moderate threshold: < moderate is an FYI alert,
// >= moderate is a human decision.
// ---------------------------------------------------------------------------
describe('riskTierIsDecision', () => {
  it('treats moderate as the decision floor', () => {
    expect(DECISION_RISK_TIER).toBe('moderate');
    expect(riskTierIsDecision('trivial')).toBe(false);
    expect(riskTierIsDecision('low')).toBe(false);
    expect(riskTierIsDecision('moderate')).toBe(true);
    expect(riskTierIsDecision('high')).toBe(true);
    expect(riskTierIsDecision('critical')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// groupByTier — partition into the four buckets, importance-sorted within each,
// with matching counts.
// ---------------------------------------------------------------------------
describe('groupByTier', () => {
  const it_ = (id: string, tier: AttentionTier, importance: Importance) =>
    baseItem({ id, tier, importance, needsHuman: needsHumanForTier(tier) });

  it('buckets by tier, sorts each bucket by importance, and counts', () => {
    const items = [
      it_('d-low', 'decision', 'low'),
      it_('d-urg', 'decision', 'urgent'),
      it_('a-norm', 'alert', 'normal'),
      it_('act', 'activity', 'normal'),
      it_('h-high', 'handled', 'high'),
    ];
    const out = groupByTier(items);

    // partition + per-bucket importance sort (decision: urgent before low)
    expect(out.decision.map((x) => x.id)).toEqual(['d-urg', 'd-low']);
    expect(out.alert.map((x) => x.id)).toEqual(['a-norm']);
    expect(out.activity.map((x) => x.id)).toEqual(['act']);
    expect(out.handled.map((x) => x.id)).toEqual(['h-high']);

    // counts match each bucket's length
    expect(out.counts).toEqual({ decision: 2, handled: 1, alert: 1, activity: 1 });
  });

  it('produces empty buckets and zero counts for an empty input', () => {
    const out = groupByTier([]);
    expect(out.decision).toEqual([]);
    expect(out.counts).toEqual({ decision: 0, handled: 0, alert: 0, activity: 0 });
  });
});
