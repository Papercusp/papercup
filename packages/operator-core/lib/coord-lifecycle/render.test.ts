/**
 * Unit tests for the pure lifecycle render layer
 * (coord-lifecycle-automation-2026-06-04 D-004 / D-006 / D-008).
 *
 * The load-bearing invariant under test is D-006 INFORMATION PRESERVATION:
 * every field a record carries must survive into the rendered output, and the
 * deferred-set in particular (the "surface every deferred item" policy) must
 * never be silently dropped.
 */

import { describe, it, expect } from 'vitest';
import {
  CompletionRecordSchema,
  ClaimRecordSchema,
  IntentRecordSchema,
  WindowRecordSchema,
  HandoffRecordSchema,
  FindingRecordSchema,
} from './records';
import {
  renderCompletion,
  renderClaim,
  renderIntent,
  renderWindow,
  renderHandoff,
  renderFinding,
  CATEGORY_RENDERERS,
  isLifecycleCategory,
} from './render';

describe('renderCompletion', () => {
  // A faithful reconstruction of a REAL corpus completion message.
  const full = CompletionRecordSchema.parse({
    workItem: 'fleet-as-supervised-blackboard-2026-06-04',
    summary: 'all 5 phases/8 decisions',
    status: 'built+tested',
    agent: 'su-d3187',
    whatLanded: [
      'packages/operator-core/lib/fleet/*: P0 nursery + transitive cancel',
      'fleet:cancel|tree|supervise|admit|governor tools',
    ],
    migrations: ['146 spawned_agents supervision', '147 fleet_governor', '148 fleet_sagas'],
    tests: '67 green tests',
    deploy: 'additive, loads next :3070 restart',
    deferred: [
      ':3070 restart pending',
      'governor opt-in (unseeded)',
      'supervise not auto-wired to DBOS crash loop',
    ],
    coordNotes: '@su-584a8: migration 147 collided — coordinate the ledger.',
  });

  it('headline carries id, STATUS, agent, summary, tests, migs', () => {
    const { summary } = renderCompletion(full);
    expect(summary).toContain('fleet-as-supervised-blackboard-2026-06-04');
    expect(summary).toContain('BUILT+TESTED');
    expect(summary).toContain('su-d3187');
    expect(summary).toContain('all 5 phases/8 decisions');
    expect(summary).toContain('67 green tests');
    expect(summary).toContain('migs 146/147/148');
  });

  it('PRESERVES every deferred item (the surface-every-deferral guarantee)', () => {
    const { body } = renderCompletion(full);
    expect(body).toBeDefined();
    expect(body).toMatch(/deferred/i);
    for (const d of full.deferred ?? []) {
      expect(body).toContain(d);
    }
  });

  it('PRESERVES whatLanded, migrations, tests, deploy, coordNotes (D-006)', () => {
    const { body } = renderCompletion(full);
    expect(body).toBeDefined();
    for (const w of full.whatLanded ?? []) expect(body).toContain(w);
    for (const m of full.migrations ?? []) expect(body).toContain(m);
    expect(body).toContain('67 green tests');
    expect(body).toContain('additive, loads next :3070 restart');
    expect(body).toContain('@su-584a8');
  });

  it('a minimal completion (summary only) renders summary, no empty body', () => {
    const min = CompletionRecordSchema.parse({ workItem: 'F-001', summary: 'shipped the thing' });
    const out = renderCompletion(min);
    expect(out.summary).toContain('F-001');
    expect(out.summary).toContain('DONE'); // default status
    expect(out.body).toBeUndefined();
  });

  it('clips an overlong headline to keep inbox scannable', () => {
    const long = CompletionRecordSchema.parse({
      workItem: 'X',
      summary: 'q'.repeat(400),
    });
    expect(renderCompletion(long).summary.length).toBeLessThanOrEqual(180);
  });
});

describe('renderClaim', () => {
  it('renders "Taking <id>" with optional scope + agent', () => {
    const rec = ClaimRecordSchema.parse({
      workItem: 'BRIEF-test-coverage',
      summary: 'NEW test files only, no source edits',
      agent: 'su-d6be1',
    });
    const { summary } = renderClaim(rec);
    expect(summary).toContain('Taking BRIEF-test-coverage');
    expect(summary).toContain('su-d6be1');
    expect(summary).toContain('NEW test files only');
  });
});

describe('renderIntent', () => {
  it('renders "now working on X" with files + plan', () => {
    const out = renderIntent(
      IntentRecordSchema.parse({
        intent: 'building the emits desugar',
        files: ['libs/generic/tooldef/src/types.ts'],
        planSlug: 'coord-lifecycle-automation-2026-06-04',
        agent: 'su-34ac2',
      }),
    );
    // Glyph-free + sender-free (P-003/P-010): the `>` + handle are added by the
    // injection renderer; the stored summary carries only the content.
    expect(out.summary).toBe('now working on: building the emits desugar');
    expect(out.summary).not.toContain('su-34ac2');
    expect(out.body).toContain('libs/generic/tooldef/src/types.ts');
    expect(out.body).toContain('coord-lifecycle-automation-2026-06-04');
  });

  it('intent with no files renders summary only', () => {
    const out = renderIntent(IntentRecordSchema.parse({ intent: 'thinking' }));
    expect(out.summary).toContain('now working on: thinking');
    expect(out.body).toBeUndefined();
  });
});

describe('renderWindow', () => {
  const base = { scope: 'libs/papercusp/packages/locks/*', intent: 'CRDT primitives', agent: 'su-076bb' };

  it('open → holding + hold-off instruction (verb carries the phase, no glyph)', () => {
    const out = renderWindow(WindowRecordSchema.parse({ ...base, phase: 'open' }));
    expect(out.summary).toContain('holding');
    expect(out.summary).toContain(base.scope);
    expect(out.summary).not.toMatch(/🔒|su-076bb/); // no glyph, no sender re-embed
    expect(out.body).toMatch(/hold off|DONE/i);
  });

  it('done → released + scope-free', () => {
    const out = renderWindow(WindowRecordSchema.parse({ ...base, phase: 'done' }));
    expect(out.summary).toContain('released');
    expect(out.summary).toContain('done');
    expect(out.summary).not.toContain('✅');
    expect(out.body).toMatch(/free to edit/i);
  });

  it('draining → wrapping up', () => {
    const out = renderWindow(WindowRecordSchema.parse({ ...base, phase: 'draining' }));
    expect(out.summary).toContain('draining');
    expect(out.summary).not.toContain('⏳');
  });
});

describe('renderHandoff (shared formatHandoff, D-008)', () => {
  it('carries item, recipient, context, next step', () => {
    const rec = HandoffRecordSchema.parse({
      item: 'P4 ?pot= slice on CupboardClient.tsx',
      to: 'su-2bf2',
      context: 'nuqs param + per-Pot grouping landed on E5 storefront',
      nextStep: 'wire the rollup once snapshots flag flips on',
    });
    const { summary, body } = renderHandoff(rec);
    expect(summary).toContain('handoff → su-2bf2');
    expect(summary).not.toContain('↪'); // glyph added by the injection renderer
    expect(summary).toContain('P4 ?pot=');
    expect(body).toContain('nuqs param');
    expect(body).toContain('Next step: wire the rollup');
  });

  it('broadcast handoff (no `to`) omits the arrow target', () => {
    const out = renderHandoff(HandoffRecordSchema.parse({ item: 'X', context: 'ctx' }));
    expect(out.summary).toContain('handoff:');
    expect(out.summary).not.toContain('→');
  });
});

describe('renderFinding', () => {
  it('carries severity, title, work-item ref, detail', () => {
    const rec = FindingRecordSchema.parse({
      title: 'migration 147 number collision',
      severity: 'medium',
      detail: 'db:next-migration handed 147 to two files',
      workItemId: 'WI-042',
    });
    const { summary, body } = renderFinding(rec);
    expect(summary).toContain('[medium]');
    expect(summary).not.toContain('⚠'); // glyph added by the injection renderer
    expect(summary).toContain('migration 147 number collision');
    expect(summary).toContain('WI-042');
    expect(body).toContain('db:next-migration');
  });
});

describe('CATEGORY_RENDERERS map', () => {
  it('exposes a renderer per lifecycle category', () => {
    expect(Object.keys(CATEGORY_RENDERERS).sort()).toEqual(
      ['claim', 'completion', 'finding', 'handoff', 'intent', 'window'].sort(),
    );
  });

  it('isLifecycleCategory guards membership', () => {
    expect(isLifecycleCategory('completion')).toBe(true);
    expect(isLifecycleCategory('nonsense')).toBe(false);
  });
});
