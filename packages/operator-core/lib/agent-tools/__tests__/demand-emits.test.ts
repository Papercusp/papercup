/**
 * Unit tests for the three demand-producer `emits:` blocks
 * (start-hive-wake-orchestration-2026-06-09 P-001 / D-001).
 *
 * Each producer (plans:start, work_items:create, coord:escalate) declares an
 * intrinsic `coord:emit` lifecycle emission; these tests exercise the specs'
 * `when` gates + `render` outputs against synthetic ToolEventLike events —
 * the contract the desugar (emitsEntryToRule) registers verbatim.
 */
import { describe, it, expect } from 'vitest';
import type { ToolEventLike, ToolEmitSpec } from '@papercusp/tooldef';

import plansStart from '../plans/start';
import workItemsCreate from '../work_items/create';
import coordEscalate from '../coordination/tools/escalate';

const ev = (tool: string, args: Record<string, unknown>, data: unknown): ToolEventLike => ({
  tool,
  args,
  result: { ok: true, data },
  ctx: {},
});

const soleEmit = (tool: { emits?: readonly ToolEmitSpec[] }): ToolEmitSpec => {
  expect(tool.emits).toBeDefined();
  expect(tool.emits).toHaveLength(1);
  return tool.emits![0];
};

describe('plans:start emits (P-001)', () => {
  const spec = soleEmit(plansStart as never);

  it('fires coord:emit only on a REAL transition', () => {
    expect(spec.fire).toBe('coord:emit');
    const started = ev('plans:start', { slug: 'p' }, { slug: 'p', transitioned: true });
    const noop = ev('plans:start', { slug: 'p' }, { slug: 'p', transitioned: false });
    expect(spec.when!(started)).toBe(true);
    expect(spec.when!(noop)).toBe(false);
  });

  it('renders a plan-watcher-scoped demand notification', () => {
    const out = spec.render(
      ev('plans:start', { slug: 'p' }, {
        slug: 'my-plan',
        harnessSlug: 'papercup',
        transitioned: true,
        previousOpStatus: 'paused',
        autoApproved: true,
      }),
    );
    expect(out.category).toBe('demand');
    expect(out.summary).toContain('my-plan');
    expect(out.summary).toContain('was paused');
    expect(out.plan_slug).toBe('my-plan');
    expect(out.to).toEqual(['@plan:my-plan']);
  });
});

describe('work_items:create emits (P-001)', () => {
  const spec = soleEmit(workItemsCreate as never);

  it('fires only when the create actually succeeded (handler reports ok:false in-band)', () => {
    expect(spec.fire).toBe('coord:emit');
    expect(spec.when!(ev('work_items:create', {}, { ok: true, workItem: { id: 'WI-1' } }))).toBe(true);
    expect(spec.when!(ev('work_items:create', {}, { ok: false, error: 'nope' }))).toBe(false);
  });

  it('scopes delivery to the tagged topics; untagged ⇒ record-only ([])', () => {
    const tagged = spec.render(
      ev(
        'work_items:create',
        { topics: ['hive', 'wake'] },
        { ok: true, workItem: { id: 'WI-7', kind: 'bug', title: 'T', harness: 'papercup' } },
      ),
    );
    expect(tagged.category).toBe('demand');
    expect(tagged.summary).toContain('WI-7');
    expect(tagged.summary).toContain('bug');
    expect(tagged.to).toEqual(['@topic:hive', '@topic:wake']);

    const untagged = spec.render(
      ev('work_items:create', {}, { ok: true, workItem: { id: 'WI-8', kind: 'change', title: 'U' } }),
    );
    expect(untagged.to).toEqual([]);
  });
});

describe('coord:escalate emits (P-001)', () => {
  const spec = soleEmit(coordEscalate as never);

  it('fires on a successful open', () => {
    expect(spec.fire).toBe('coord:emit');
    expect(spec.when!(ev('coord:escalate', { severity: 'blocker', summary: 's' }, { ok: true, msg_id: 'm1' }))).toBe(
      true,
    );
    expect(spec.when!(ev('coord:escalate', {}, { ok: false }))).toBe(false);
  });

  it('reaches plan watchers when plan-scoped; record-only otherwise', () => {
    const planScoped = spec.render(
      ev('coord:escalate', { severity: 'blocker', summary: 'db down', plan_slug: 'my-plan' }, { ok: true }),
    );
    expect(planScoped.category).toBe('escalation');
    expect(planScoped.summary).toContain('blocker');
    expect(planScoped.summary).toContain('db down');
    expect(planScoped.plan_slug).toBe('my-plan');
    expect(planScoped.to).toEqual(['@plan:my-plan']);

    const planless = spec.render(ev('coord:escalate', { severity: 'question', summary: 'q' }, { ok: true }));
    expect(planless.to).toEqual([]);
  });
});
