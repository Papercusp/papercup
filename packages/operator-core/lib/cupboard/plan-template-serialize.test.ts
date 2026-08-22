/**
 * plan-template-serialize — the sanitizer's contract
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-016).
 *
 * Two properties carry the whole file, and they pull in opposite directions:
 *   STRIP — no run state or workspace-local identifier survives the export.
 *   KEEP  — the prose, the item DAG and the decisions survive it VERBATIM.
 *
 * A test suite that only checked the first would pass on a sanitizer that returned
 * an empty document, which is precisely the failure D-004 rejected `renderPlanMarkdown`
 * for. So every strip assertion here is paired with a keep assertion over the same
 * input.
 */
import { describe, it, expect } from 'vitest';
import { parsePlan } from '@papercusp/plan-parser';
import { sanitizePlanForTemplate, deriveRequiredRubrics } from './plan-template-serialize';

const LIVE_PLAN = `---
title: Ship the widget
slug: ship-the-widget-2026-08-21
status: active
created: 2026-08-21
updated: 2026-08-21
owner: someone@example.com
initiative: widgets
supersedes: [old-widget-plan]
---

# Ship the widget

The widget is the load-bearing half of the frobnicator and nothing measures it today.
This paragraph is the reasoning a template exists to carry.

## Now

**State:** P-001 done, P-002 in flight by su-abc123.
**Next:** finish P-002.

## Background

We surveyed three approaches. The rejected one duplicated the parser, which the
derived-truth ladder forbids.

## Phase 1 — build it

- **P-001** \`done\` Build the widget core — note: landed as WI-40349, see EI-21105590066576343
- **P-002** \`wip\` Wire it to the UI blocked-by: P-001 importance: high
- **P-003** \`blocked\` Test it blocked-by: P-002

## Decisions

### D-001 — Use the existing store

Extending the existing store beat forking it. Graded against plan-class-feature-ship.
`;

describe('sanitizePlanForTemplate', () => {
  const result = sanitizePlanForTemplate(LIVE_PLAN);
  if ('error' in result) throw new Error(`fixture failed to sanitize: ${result.error}`);
  const reparsed = parsePlan(result.markdown);

  it('resets every item status to todo', () => {
    expect(reparsed.items.map((i) => i.storedStatus)).toEqual(['todo', 'todo', 'todo']);
    expect(result.stripped.itemStatuses).toBe(3);
  });

  it('KEEPS the item DAG the statuses were stripped from', () => {
    // The paired assertion: a sanitizer that dropped the items would also report
    // "no non-todo statuses", so the reset above is only meaningful beside this.
    expect(reparsed.items.map((i) => i.id)).toEqual(['P-001', 'P-002', 'P-003']);
    expect(reparsed.items[1]?.blockedBy).toEqual(['P-001']);
    expect(reparsed.items[1]?.importance).toBe('high');
  });

  it('removes set-status note suffixes and the work-item ids inside them', () => {
    expect(result.markdown).not.toContain('note:');
    expect(result.markdown).not.toContain('WI-40349');
    expect(result.markdown).not.toContain('EI-21105590066576343');
    expect(result.stripped.notes).toBe(1);
    expect(result.stripped.workItemRefs).toBeGreaterThan(0);
    // …while the item's actual TEXT survives.
    expect(reparsed.items[0]?.text).toContain('Build the widget core');
  });

  it('drops the ## Now run-state block', () => {
    expect(result.stripped.nowBlock).toBe(true);
    expect(reparsed.now).toBeNull();
    expect(result.markdown).not.toContain('su-abc123');
  });

  it('KEEPS free prose verbatim — the reason D-004 rejected a re-render', () => {
    expect(result.markdown).toContain('the load-bearing half of the frobnicator');
    expect(result.markdown).toContain('We surveyed three approaches');
    expect(result.markdown).toContain('## Background');
  });

  it('KEEPS decisions', () => {
    expect(reparsed.decisions.map((d) => d.id)).toEqual(['D-001']);
    expect(reparsed.decisions[0]?.body).toContain('Extending the existing store');
  });

  it('rewrites frontmatter to a template identity, dropping run identity', () => {
    expect(reparsed.frontmatter.status).toBe('draft');
    expect(reparsed.frontmatter.slug).toBe('ship-the-widget-2026-08-21');
    expect(reparsed.frontmatter.title).toBe('Ship the widget');
    expect(result.stripped.frontmatterKeys).toEqual([
      'created',
      'initiative',
      'owner',
      'supersedes',
      'updated',
    ]);
    expect(reparsed.frontmatter.raw.owner).toBeUndefined();
    expect(reparsed.frontmatter.raw.initiative).toBeUndefined();
  });

  it('re-parses as a NON-legacy plan (the export is itself a valid plan)', () => {
    expect(reparsed.isLegacy).toBe(false);
    expect(reparsed.parseWarnings).toEqual([]);
  });

  it('honours an explicit templateSlug override', () => {
    const r = sanitizePlanForTemplate(LIVE_PLAN, { templateSlug: 'ship-a-widget' });
    if ('error' in r) throw new Error(r.error);
    expect(r.templateSlug).toBe('ship-a-widget');
    expect(parsePlan(r.markdown).frontmatter.slug).toBe('ship-a-widget');
  });

  it('derives a one-line description from the first prose paragraph', () => {
    expect(result.description).toContain('load-bearing half of the frobnicator');
    expect(result.description).not.toContain('\n');
  });

  it('refuses a legacy (frontmatter-less) document rather than exporting unreset statuses', () => {
    const r = sanitizePlanForTemplate('# Just a heading\n\n- **P-001** `done` a thing\n');
    expect('error' in r && r.status).toBe(422);
  });

  it('refuses empty content', () => {
    expect('error' in sanitizePlanForTemplate('   ')).toBe(true);
  });
});

describe('deriveRequiredRubrics', () => {
  it('names the plan-class acceptance rubric the plan grades against', () => {
    expect(deriveRequiredRubrics(LIVE_PLAN, 'ship-the-widget-2026-08-21')).toEqual([
      { rubricRef: 'plan-class-feature-ship' },
    ]);
  });

  it('picks up explicit rubricRef mentions', () => {
    const body = `graded with rubricRef: 'pot-coordination-health' and rubricRef: "meta-acceptance-rubric"`;
    expect(deriveRequiredRubrics(body, 'some-plan')).toEqual([
      { rubricRef: 'meta-acceptance-rubric' },
      { rubricRef: 'pot-coordination-health' },
    ]);
  });

  it("EXCLUDES the plan's own per-plan acceptance rubric", () => {
    // A per-plan acceptance rubric is authored post-implementation against as-built
    // reality; requiring it of an installer who has built nothing is meaningless.
    const body = `rubricRef: 'acceptance-ship-the-widget-2026-08-21'`;
    expect(deriveRequiredRubrics(body, 'ship-the-widget-2026-08-21')).toEqual([]);
  });

  it('skips placeholder refs from documentation prose', () => {
    const body = `rubricRef: '<acceptance-rubric-slug>' and rubricRef: "plan-class-bugfix"`;
    expect(deriveRequiredRubrics(body, 'x')).toEqual([{ rubricRef: 'plan-class-bugfix' }]);
  });

  it('an explicit requiresRubrics option overrides derivation, including empty', () => {
    const r = sanitizePlanForTemplate(LIVE_PLAN, { requiresRubrics: [] });
    if ('error' in r) throw new Error(r.error);
    expect(r.requiresRubrics).toEqual([]);
  });
});
