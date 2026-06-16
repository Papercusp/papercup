import { describe, it, expect } from 'vitest';
import {
  importanceRank,
  sortByImportance,
  severityToImportance,
  severityToRiskTier,
  riskTierIsDecision,
  DECISION_RISK_TIER,
  ATTENTION_KIND_CATEGORY,
  attentionCategory,
  type AttentionItem,
  type AttentionKind,
} from './types';
import {
  planItemToAttention,
  coordEscalationToAttention,
  coordMessageToAttention,
  smokeFailToAttention,
  improvementToAttention,
  standingApprovalToAttention,
  conversationToAttention,
  scoutGradeToAttention,
} from './adapters';
import { isAutonomyCategory } from '../autonomy/categories';

describe('importance helpers', () => {
  it('ranks urgent→low ascending', () => {
    expect(importanceRank('urgent')).toBeLessThan(importanceRank('high'));
    expect(importanceRank('high')).toBeLessThan(importanceRank('normal'));
    expect(importanceRank('normal')).toBeLessThan(importanceRank('low'));
  });

  it('sortByImportance is stable within a level', () => {
    const items = [
      { id: 'a', importance: 'normal' as const },
      { id: 'b', importance: 'urgent' as const },
      { id: 'c', importance: 'normal' as const },
      { id: 'd', importance: 'high' as const },
    ];
    expect(sortByImportance(items).map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('maps severity to importance (blocker→urgent, question→high, advisory→low)', () => {
    expect(severityToImportance('blocker')).toBe('urgent');
    expect(severityToImportance('question')).toBe('high');
    expect(severityToImportance('advisory')).toBe('low');
  });
});

describe('P-013 — escalation severity folds into risk_tier', () => {
  it('maps severity to risk_tier (blocker→critical, question→high, advisory→low)', () => {
    expect(severityToRiskTier('blocker')).toBe('critical');
    expect(severityToRiskTier('question')).toBe('high');
    expect(severityToRiskTier('advisory')).toBe('low');
  });

  it('risk_tier ⊥ importance: the two axes derive from severity INDEPENDENTLY (P-014)', () => {
    // blocker: importance urgent, but risk critical — different bands, same input.
    expect(severityToImportance('blocker')).toBe('urgent');
    expect(severityToRiskTier('blocker')).toBe('critical');
  });

  it('riskTierIsDecision splits at the moderate threshold (advisory=alert, else decision)', () => {
    expect(DECISION_RISK_TIER).toBe('moderate');
    expect(riskTierIsDecision('low')).toBe(false); // advisory → alert
    expect(riskTierIsDecision('moderate')).toBe(true);
    expect(riskTierIsDecision('high')).toBe(true); // question → decision
    expect(riskTierIsDecision('critical')).toBe(true); // blocker → decision
  });

  it('the escalation tier is now DERIVED from risk_tier (one scale, not two)', () => {
    // The adapter computes tier = riskTierIsDecision(severityToRiskTier(sev)) — assert
    // the live tier matches that fold for every severity (and stays behavior-neutral).
    for (const sev of ['blocker', 'question', 'advisory'] as const) {
      const a = coordEscalationToAttention({ msgId: `m-${sev}`, severity: sev, summary: 's' });
      const expected = riskTierIsDecision(severityToRiskTier(sev)) ? 'decision' : 'alert';
      expect(a.tier).toBe(expected);
    }
  });

  it('D-005: a SYSTEM-emitted escalation with no options is an ALERT, not a decision (cursed-placement flood)', () => {
    // placement-watchdog cursed placements escalate as a blocker from the REAL owner
    // `system:hive-placement-watchdog` (NOT bare `system`) but carry NO options —
    // operational, not a human decision. Without this, ~7000 open cursed-placement
    // escalations flooded the "waiting on you" decision tier.
    const sys = coordEscalationToAttention({
      msgId: 'm-sys',
      severity: 'blocker',
      summary: 'Cursed placement: F-X failed 301×',
      from: 'system:hive-placement-watchdog',
    });
    expect(sys.tier).toBe('alert');
    expect(sys.needsHuman).toBe(false);
    // bare `system` (e.g. aging sweeps) is operational too.
    expect(
      coordEscalationToAttention({ msgId: 'm-sys0', severity: 'blocker', summary: 's', from: 'system' }).tier,
    ).toBe('alert');
    // A system escalation that DOES carry a choice stays a decision.
    const sysChoice = coordEscalationToAttention({
      msgId: 'm-sys2',
      severity: 'blocker',
      summary: 's',
      from: 'system:hive-placement-watchdog',
      options: [{ id: 'a', label: 'A' }],
    });
    expect(sysChoice.tier).toBe('decision');
    // A genuine agent escalation (non-system) is unchanged → decision.
    const agent = coordEscalationToAttention({ msgId: 'm-ag', severity: 'blocker', summary: 's', from: 'bee-7' });
    expect(agent.tier).toBe('decision');
  });
});

describe('planItemToAttention — tier + needsHuman (D-001/D-002/D-006)', () => {
  const base = {
    slug: 'p-2026-05-31',
    harnessSlug: 'papercup',
    id: 'P-007',
    text: 'Sign off before ship',
    storedStatus: 'needs-human',
    effectiveStatus: 'needs-human',
    importance: 'urgent' as const,
  };

  it('needs-human → decision tier + the full Answer/Resolve/Drop/Chat/Message-owner toolkit', () => {
    const a = planItemToAttention(base);
    expect(a.kind).toBe('plan-item');
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.triageState).toBe('untriaged');
    expect(a.actions.map((x) => x.id)).toEqual(['answer', 'mark-done', 'drop', 'chat', 'message-owner']);
    expect(a.actions.find((x) => x.id === 'mark-done')?.primary).toBe(true);
    expect(a.ref).toEqual({ kind: 'plan-item', slug: 'p-2026-05-31', itemId: 'P-007' });
  });

  it('blocked → alert tier (not a decision), Chat + Message owner only', () => {
    const a = planItemToAttention({ ...base, storedStatus: 'blocked', effectiveStatus: 'blocked', importance: 'normal' });
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.actions.map((x) => x.id)).toEqual(['chat', 'message-owner']);
  });

  it('todo → activity tier, not needs-human', () => {
    const a = planItemToAttention({ ...base, storedStatus: 'todo', effectiveStatus: 'todo', importance: 'normal' });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
    expect(a.actions.map((x) => x.id)).toEqual(['chat', 'message-owner']);
  });

  it('carries an explicit owner when resolved', () => {
    const a = planItemToAttention({ ...base, ownerAgentId: 'su-worker', ownerLabel: 'worker' });
    expect(a.ownerAgentId).toBe('su-worker');
    expect(a.ownerLabel).toBe('worker');
  });
});

describe('coordEscalationToAttention — severity → tier', () => {
  it('blocker → decision (urgent), resolvable, owner from `from`', () => {
    const a = coordEscalationToAttention({
      msgId: 'm-1',
      severity: 'blocker',
      summary: 'Which auth lib?',
      harnessSlug: 'papercup',
      from: 'su-architect',
      options: [{ id: 'authjs', label: 'Auth.js' }, { id: 'lucia', label: 'Lucia' }],
    });
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.importance).toBe('urgent');
    expect(a.ownerAgentId).toBe('su-architect');
    expect(a.actions.map((x) => x.id)).toEqual(['resolve', 'chat', 'message-owner']);
    if (a.ref.kind === 'coord-escalation') expect(a.ref.options).toHaveLength(2);
  });

  it('question → decision (this is where ask-owner lands)', () => {
    const a = coordEscalationToAttention({ msgId: 'm-q', severity: 'question', summary: 'ok to proceed?' });
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.importance).toBe('high');
    // No harness → no Chat, but Message owner is always offered.
    expect(a.actions.map((x) => x.id)).toEqual(['resolve', 'message-owner']);
  });

  it('advisory → alert (FYI, not a decision)', () => {
    const a = coordEscalationToAttention({ msgId: 'm-a', severity: 'advisory', summary: 'heads up' });
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.importance).toBe('low');
  });
});

describe('coordMessageToAttention — structured classification (D-003)', () => {
  it('a plain broadcast FYI → activity, not needs-human', () => {
    const a = coordMessageToAttention({ msgId: 'm-2', summary: 'apps/tui is GREEN again', harnessSlug: 'papercup' });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
    expect(a.actions.map((x) => x.id)).toEqual(['ack', 'chat', 'message-owner']);
  });

  it('an auto lifecycle broadcast → activity (the over-flagging fix)', () => {
    const a = coordMessageToAttention({ msgId: 'm-3', summary: '▶ now working on X', auto: true, lifecycle: 'intent' });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
  });

  it('lifecycle marker alone (no auto flag) still → activity', () => {
    const a = coordMessageToAttention({ msgId: 'm-3b', summary: '✅ done', lifecycle: 'completion' });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
  });

  it('a non-auto message addressed directly to the human → alert, NOT a decision (P-102: a message is a communication, ack-only; decisions route through escalations)', () => {
    const a = coordMessageToAttention({ msgId: 'm-4', summary: 'can you confirm the rename?', directToOwner: true, from: 'su-worker' });
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.ownerAgentId).toBe('su-worker');
    // disposition stays ACK (a communication), never resolve-with-choice.
    expect(a.actions.some((x) => x.id === 'ack')).toBe(true);
  });

  it('an auto message addressed to the human is STILL activity (lifecycle wins)', () => {
    const a = coordMessageToAttention({ msgId: 'm-5', summary: '✅ done', auto: true, lifecycle: 'completion', directToOwner: true });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
  });
});

describe('smokeFailToAttention — alert tier', () => {
  it('is an alert (a problem to surface), not a decision', () => {
    const a = smokeFailToAttention({ harnessSlug: 'papercup', failureContent: 'boot crashed' });
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.body).toContain('boot crashed');
    expect(a.actions.map((x) => x.id)).toEqual(['view-log', 'chat', 'message-owner']);
  });
});

describe('unified shape invariants', () => {
  it('every adapter: unique-prefixed id, ref kind matches, needsHuman===decision, untriaged default, message-owner present', () => {
    const items: AttentionItem[] = [
      planItemToAttention({ slug: 's', harnessSlug: null, id: 'P-001', text: 't', storedStatus: 'todo', effectiveStatus: 'todo', importance: 'normal' }),
      coordEscalationToAttention({ msgId: 'm', severity: 'question', summary: 's' }),
      coordMessageToAttention({ msgId: 'm', summary: 's' }),
      smokeFailToAttention({ harnessSlug: 'h' }),
    ];
    for (const it of items) {
      expect(it.id.startsWith(`${it.kind}:`)).toBe(true);
      expect(it.ref.kind).toBe(it.kind);
      expect(it.actions.length).toBeGreaterThan(0);
      expect(it.needsHuman).toBe(it.tier === 'decision');
      expect(it.triageState).toBe('untriaged');
      expect(it.actions.some((a) => a.id === 'message-owner')).toBe(true);
    }
  });
});

describe('needsHuman drops at the source (Brief 21 — the 62→12 intent)', () => {
  it('a representative feed leaves only genuine decisions as needs-human', () => {
    const items: AttentionItem[] = [
      // ── noise: auto lifecycle broadcasts (the bulk of the old false positives)
      ...Array.from({ length: 10 }, (_, i) =>
        coordMessageToAttention({ msgId: `auto-${i}`, summary: '▶ now working on', auto: true, lifecycle: 'intent' }),
      ),
      // ── alerts (surface, but not decisions)
      coordEscalationToAttention({ msgId: 'adv', severity: 'advisory', summary: 'fyi' }),
      smokeFailToAttention({ harnessSlug: 'h' }),
      planItemToAttention({ slug: 's', harnessSlug: 'h', id: 'P-9', text: 'stuck', storedStatus: 'blocked', effectiveStatus: 'blocked', importance: 'normal' }),
      // ── activity (normal work)
      ...Array.from({ length: 3 }, (_, i) =>
        planItemToAttention({ slug: 's', harnessSlug: 'h', id: `P-${i}`, text: 'work', storedStatus: 'todo', effectiveStatus: 'todo', importance: 'normal' }),
      ),
      // ── genuine decisions
      planItemToAttention({ slug: 's', harnessSlug: 'h', id: 'P-NH', text: 'sign off', storedStatus: 'needs-human', effectiveStatus: 'needs-human', importance: 'urgent' }),
      coordEscalationToAttention({ msgId: 'blk', severity: 'blocker', summary: 'blocked decision' }),
      coordEscalationToAttention({ msgId: 'ask', severity: 'question', summary: 'ask-owner question' }),
    ];
    const needsHuman = items.filter((i) => i.needsHuman);
    // 19 items, only the 3 genuine decisions await the human (the needs-human
    // plan item + the blocker + the question escalation; plan-review retired P-101).
    expect(items.length).toBe(19);
    expect(needsHuman.length).toBe(3);
    expect(needsHuman.every((i) => i.tier === 'decision')).toBe(true);
  });
});

describe('P-100 — folded disposition channels (B-14 / D-011)', () => {
  it('improvement: a human-routed improvement is a Decision (ideation-intake)', () => {
    const a = improvementToAttention({ issueId: 'EI-42', title: 'fix the thing', severity: 'major', harnessSlug: 'papercup' });
    expect(a.kind).toBe('improvement');
    expect(a.category).toBe('ideation-intake');
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.importance).toBe('high'); // major → high
    expect(a.id).toBe('improvement:EI-42');
    expect(a.ref).toEqual({ kind: 'improvement', issueId: 'EI-42' });
    // D-027 follow-on (1): Triage navigate (full place/gate/gym surface) + inline Dismiss (reject).
    expect(a.actions.map((x) => x.id)).toEqual(['open', 'dismiss']);
  });

  it('standing-approval is a Decision in the PROTECTED system-control category (never-auto)', () => {
    const a = standingApprovalToAttention({ capability: 'harness:write', targetHarness: 'sheets', count: 4 });
    expect(a.kind).toBe('standing-approval');
    expect(a.category).toBe('system-control'); // protected: the Queen can never auto-grant herself this
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.harnessSlug).toBe('sheets');
    expect(a.id).toBe('standing-approval:harness:write:sheets');
    expect(a.ref).toEqual({ kind: 'standing-approval', capability: 'harness:write', targetHarness: 'sheets' });
    // D-027 follow-on (1): inline terminal grant/dismiss (no navigate-to-source).
    expect(a.actions.map((x) => x.id)).toEqual(['grant', 'dismiss']);
    expect(a.actions.find((x) => x.id === 'grant')?.primary).toBe(true);
  });

  it('conversation: an open question is an Alert (surfaced, not demanded), escalations category', () => {
    const a = conversationToAttention({ conversationId: 'CONV-7', title: 'which approach?', askerId: 'su-abc', harnessSlug: 'h' });
    expect(a.kind).toBe('conversation');
    expect(a.category).toBe('escalations');
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.ownerAgentId).toBe('su-abc');
    expect(a.ref).toEqual({ kind: 'conversation', conversationId: 'CONV-7' });
    // Carries Message owner (it has an asking agent), unlike improvement/scout.
    expect(a.actions.some((x) => x.id === 'message-owner')).toBe(true);
    // D-027 follow-on (1): the primary action is now inline Answer (a navigate id
    // that reveals the InputCard → conversations:resolve), not navigate-to-source.
    expect(a.actions[0]).toMatchObject({ id: 'answer', primary: true });
  });

  it('scout-grade: ONE Activity-tier rollup (optional feedback, never per-idea)', () => {
    const a = scoutGradeToAttention({ count: 12 });
    expect(a.kind).toBe('scout-grade');
    expect(a.category).toBe('ideation-intake');
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
    expect(a.importance).toBe('low');
    expect(a.id).toBe('scout-grade:pending'); // stable singleton id (rollup)
    expect(a.title).toContain('12 Scout ideas');
    expect(scoutGradeToAttention({ count: 1 }).title).toContain('1 Scout idea ');
  });

  it('all four: id is kind-prefixed, ref.kind matches, needsHuman === (tier === decision)', () => {
    const items: AttentionItem[] = [
      improvementToAttention({ issueId: 'EI-1', title: 't' }),
      standingApprovalToAttention({ capability: 'c', targetHarness: 'h', count: 3 }),
      conversationToAttention({ conversationId: 'CONV-1', title: 'q' }),
      scoutGradeToAttention({ count: 5 }),
    ];
    for (const it of items) {
      expect(it.id.startsWith(`${it.kind}:`)).toBe(true);
      expect(it.ref.kind).toBe(it.kind);
      expect(it.actions.length).toBeGreaterThan(0);
      expect(it.needsHuman).toBe(it.tier === 'decision');
      expect(it.triageState).toBe('untriaged');
      expect(it.category).toBe(attentionCategory(it.kind));
    }
  });
});

describe('P-100 — every Queue item carries its autonomy category (B-14 / D-009/D-011)', () => {
  const ALL_KINDS: AttentionKind[] = [
    'plan-item',
    'coord-escalation',
    'coord-message',
    'smoke-fail',
    'operator-report',
    'improvement',
    'standing-approval',
    'conversation',
    'scout-grade',
  ];

  it('the kind to category map covers every AttentionKind (no kind silently uncategorized)', () => {
    expect(Object.keys(ATTENTION_KIND_CATEGORY).sort()).toEqual([...ALL_KINDS].sort());
  });

  it('every non-null mapped category is one of the 13 canonical autonomy categories', () => {
    for (const cat of Object.values(ATTENTION_KIND_CATEGORY)) {
      if (cat !== null) expect(isAutonomyCategory(cat)).toBe(true);
    }
  });

  it('each adapter stamps its kind category (the disposition domain, not the underlying work)', () => {
    const planItem = planItemToAttention({ slug: 's', harnessSlug: null, id: 'P-1', text: 't', storedStatus: 'needs-human', effectiveStatus: 'needs-human', importance: 'normal' });
    expect(planItem.category).toBe('plan-governance');
    expect(coordEscalationToAttention({ msgId: 'm', severity: 'blocker', summary: 's' }).category).toBe('escalations');
    expect(coordMessageToAttention({ msgId: 'm', summary: 's' }).category).toBe('inbox-triage');
  });

  it('ungoverned signals/reports carry a null category (fail-safe: nothing for the gate to open)', () => {
    expect(smokeFailToAttention({ harnessSlug: 'h' }).category).toBeNull();
    expect(ATTENTION_KIND_CATEGORY['operator-report']).toBeNull();
    expect(attentionCategory('smoke-fail')).toBeNull();
  });

  it('the adapter category always agrees with attentionCategory(kind) — one source of truth', () => {
    const items: AttentionItem[] = [
      planItemToAttention({ slug: 's', harnessSlug: null, id: 'P-1', text: 't', storedStatus: 'todo', effectiveStatus: 'todo', importance: 'normal' }),
      coordEscalationToAttention({ msgId: 'm', severity: 'question', summary: 's' }),
      coordMessageToAttention({ msgId: 'm', summary: 's' }),
      smokeFailToAttention({ harnessSlug: 'h' }),
    ];
    for (const it of items) expect(it.category).toBe(attentionCategory(it.kind));
  });

  it('behavior-neutral: tagging category leaves tier + needsHuman untouched', () => {
    const a = planItemToAttention({ slug: 's', harnessSlug: null, id: 'P-1', text: 't', storedStatus: 'needs-human', effectiveStatus: 'needs-human', importance: 'urgent' });
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.category).toBe('plan-governance'); // the new axis rides alongside, changing nothing
  });
});
