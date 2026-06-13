/**
 * Backend integration: a real plan flows through the SAME pipeline
 * plans:attention runs — parse → resolveEffectiveStatus → filter →
 * planItemToAttention → buildAttentionGroups — plus the write↔read
 * round-trip (the add-item / set-importance writers produce markdown
 * the parser reads back identically). No PG / ctx — exercises the real
 * parser + adapters + grouping end to end.
 */

import { describe, it, expect } from 'vitest';
import { parsePlan } from '@papercusp/plan-parser';
import { planItemsToAttention, dropConvertedPlanItems } from './sources';
import { buildAttentionGroups } from './group';
import { smokeFailToAttention } from './adapters';
import { planItemRef } from '../issue-blocks-merge';
import { buildItemLine } from '../agent-tools/plans/add-item';
import { setImportanceInBody } from '../agent-tools/plans/set-importance';

function wrap(itemsBlock: string, slug = 't-2026-05-31'): string {
  return [
    '---',
    'title: T',
    `slug: ${slug}`,
    'status: active',
    '---',
    '',
    '# T',
    '',
    '## Now',
    '',
    '**State:** s',
    '',
    '**Next:** n',
    '',
    '## Phase 1',
    '',
    itemsBlock,
    '',
  ].join('\n');
}

const MIXED = wrap(
  [
    '- **P-001** `done` shipped already',
    '- **P-002** `todo` urgent thing importance: urgent',
    '- **P-003** `needs-human` sign off importance: high',
    '- **P-004** `todo` waits on P-002 blocked-by: P-002',
    '- **P-005** `dropped` abandoned',
  ].join('\n'),
);

describe('planItemsToAttention (plan-item source of plans:attention)', () => {
  const items = planItemsToAttention([{ parsed: parsePlan(MIXED, { filePath: 't-2026-05-31.md' }) }], 'papercup');

  it('excludes done and dropped items', () => {
    expect(items.map((i) => i.itemRef).sort()).toEqual(['P-002', 'P-003', 'P-004']);
  });

  it('carries importance, plan slug and harness through', () => {
    const p2 = items.find((i) => i.itemRef === 'P-002')!;
    expect(p2.importance).toBe('urgent');
    expect(p2.planSlug).toBe('t-2026-05-31');
    expect(p2.harnessSlug).toBe('papercup');
  });

  it('flags the needs-human item and gives it the full Answer/Resolve/Drop/Chat toolkit', () => {
    const p3 = items.find((i) => i.itemRef === 'P-003')!;
    expect(p3.needsHuman).toBe(true);
    expect(p3.importance).toBe('high');
    // The needs-human action set is the single source the inbox card maps from
    // (inbox-cards-unification P-009): answer + Resolve(primary) + drop + chat +
    // message-owner (inbox-tiering-and-message-agent D-004).
    expect(p3.actions.map((a) => a.id)).toEqual(['answer', 'mark-done', 'drop', 'chat', 'message-owner']);
    expect(p3.actions.find((a) => a.id === 'mark-done')?.primary).toBe(true);
    expect(p3.tier).toBe('decision');
  });

  it('surfaces a computed-blocked item with effective status blocked (alert tier, not needs-human)', () => {
    const p4 = items.find((i) => i.itemRef === 'P-004')!;
    expect(p4.status).toBe('blocked'); // effectiveStatus: blocked-by P-002 (not done)
    expect(p4.needsHuman).toBe(false);
    expect(p4.tier).toBe('alert');
  });

  it('skips legacy plans', () => {
    const legacy = parsePlan('# no frontmatter\n\n## Phase 1\n\n- **P-001** `todo` x importance: high\n');
    expect(planItemsToAttention([{ parsed: legacy }], null)).toEqual([]);
  });
});

describe('dropConvertedPlanItems — decision↔execution dedup guard (P-104 / D-013)', () => {
  const planItems = planItemsToAttention(
    [{ parsed: parsePlan(MIXED, { filePath: 't-2026-05-31.md' }) }],
    'papercup',
  );
  const SLUG = 't-2026-05-31';
  // P-002 todo (activity), P-003 needs-human (decision), P-004 blocked (alert).

  it('drops an executing (converted) plan-item — it lives in the Working tab now', () => {
    const kept = dropConvertedPlanItems(planItems, new Set([planItemRef(SLUG, 'P-002')]));
    expect(kept.map((i) => i.itemRef).sort()).toEqual(['P-003', 'P-004']);
  });

  it('NEVER hides a needs-human DECISION, even if it carries an implements edge', () => {
    const kept = dropConvertedPlanItems(planItems, new Set([planItemRef(SLUG, 'P-003')]));
    expect(kept.some((i) => i.itemRef === 'P-003')).toBe(true); // decision always shows
  });

  it('drops a converted blocked (alert-tier) item too', () => {
    const kept = dropConvertedPlanItems(planItems, new Set([planItemRef(SLUG, 'P-004')]));
    expect(kept.some((i) => i.itemRef === 'P-004')).toBe(false);
  });

  it('empty convertedRefs → every item passes through unchanged', () => {
    expect(dropConvertedPlanItems(planItems, new Set())).toHaveLength(planItems.length);
  });

  it('passes non-plan-item kinds through untouched (only plan-items dedup)', () => {
    const smoke = smokeFailToAttention({ harnessSlug: 'papercup' });
    // a converted ref that happens to collide on string is irrelevant — smoke is not a plan-item
    const kept = dropConvertedPlanItems([smoke], new Set([planItemRef(SLUG, 'P-002')]));
    expect(kept).toHaveLength(1);
    expect(kept[0].kind).toBe('smoke-fail');
  });
});

describe('full pipeline → grouped, importance-sorted', () => {
  it('groups plan items under their plan and routes a smoke-fail to Alerts, most-urgent group first', () => {
    const planItems = planItemsToAttention(
      [{ parsed: parsePlan(MIXED, { filePath: 't-2026-05-31.md' }) }],
      'papercup',
    );
    const groups = buildAttentionGroups([
      ...planItems,
      smokeFailToAttention({ harnessSlug: 'papercup', failureContent: 'boot crashed' }),
    ]);

    // Plan group leads (its max item is urgent) over the high smoke-fail Alerts bucket.
    expect(groups.map((g) => g.key)).toEqual(['t-2026-05-31', 'alerts:papercup']);

    const plan = groups[0];
    expect(plan.kind).toBe('plan');
    expect(plan.maxImportance).toBe('urgent');
    // urgent → high → normal within the group.
    expect(plan.items.map((i) => i.itemRef)).toEqual(['P-002', 'P-003', 'P-004']);

    const alerts = groups[1];
    expect(alerts.kind).toBe('alerts');
    expect(alerts.items[0].kind).toBe('smoke-fail');
  });
});

describe('write ↔ read round-trip (writers produce parser-readable markdown)', () => {
  it('add-item importance round-trips through the parser', () => {
    const line = buildItemLine('P-010', 'do the work', [], 'urgent');
    const parsed = parsePlan(wrap(line));
    expect(parsed.items[0].id).toBe('P-010');
    expect(parsed.items[0].importance).toBe('urgent');
    expect(parsed.items[0].text).toBe('do the work');
  });

  it('a default (normal) item carries no keyword and parses as normal', () => {
    const line = buildItemLine('P-011', 'routine task', [], 'normal');
    expect(line).not.toMatch(/importance:/);
    expect(parsePlan(wrap(line)).items[0].importance).toBe('normal');
  });

  it('set-importance changes the level and the parser reads the new value', () => {
    const body = wrap(buildItemLine('P-012', 'tune it', [], 'low'));
    const raised = setImportanceInBody(body, 'P-012', 'urgent');
    expect(raised.found).toBe(true);
    expect(raised.oldImportance).toBe('low');
    expect(parsePlan(raised.newBody).items[0].importance).toBe('urgent');
  });

  it('setting importance back to normal removes the keyword and parses as normal', () => {
    const body = wrap(buildItemLine('P-013', 'calm down', [], 'high'));
    const lowered = setImportanceInBody(body, 'P-013', 'normal');
    expect(lowered.newBody).not.toMatch(/importance:/);
    expect(parsePlan(lowered.newBody).items[0].importance).toBe('normal');
  });

  it('round-trip preserves blocked-by alongside importance', () => {
    const line = buildItemLine('P-014', 'gated work', ['P-001'], 'high');
    const parsed = parsePlan(wrap(line));
    expect(parsed.items[0].blockedBy).toEqual(['P-001']);
    expect(parsed.items[0].importance).toBe('high');
  });
});
