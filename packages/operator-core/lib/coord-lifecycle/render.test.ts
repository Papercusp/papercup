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
    // WI-36726: verifiedHow + filesChanged are on CompletionRecordSchema but
    // were absent from this fixture, so the D-006 "PRESERVES …" test below
    // passed VACUOUSLY for them while renderCompletion dropped both. A guard is
    // only as wide as its fixture — keep every field of the record set here.
    verifiedHow: 'integration',
    filesChanged: ['packages/operator-core/lib/fleet/nursery.ts'],
    coverage: {
      population: ['index pages', 'species pages'],
      checked: ['index pages', 'species pages'],
      residue: ['none'],
    },
    deploy: 'additive, loads next :3070 restart',
    deferred: [
      ':3070 restart pending',
      'governor opt-in (unseeded)',
      'supervise not auto-wired to DBOS crash loop',
    ],
    coordNotes: '@su-584a8: migration 147 collided — coordinate the ledger.',
  });

  it('headline carries id, STATUS, summary, tests, migs (no agent re-embed — P-010)', () => {
    const { summary } = renderCompletion(full);
    expect(summary).toContain('fleet-as-supervised-blackboard-2026-06-04');
    expect(summary).toContain('BUILT+TESTED');
    expect(summary).not.toContain('su-d3187'); // sender shown once by the injection handle
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

  it('PRESERVES whatLanded, migrations, tests, verifiedHow, filesChanged, coverage, deploy, coordNotes (D-006)', () => {
    const { body } = renderCompletion(full);
    expect(body).toBeDefined();
    for (const w of full.whatLanded ?? []) expect(body).toContain(w);
    for (const m of full.migrations ?? []) expect(body).toContain(m);
    for (const f of full.filesChanged ?? []) expect(body).toContain(f);
    for (const entry of full.coverage?.population ?? []) expect(body).toContain(entry);
    for (const entry of full.coverage?.checked ?? []) expect(body).toContain(entry);
    for (const entry of full.coverage?.residue ?? []) expect(body).toContain(entry);
    expect(body).toContain('Coverage population:');
    expect(body).toContain('Checked:');
    expect(body).toContain('Residue:');
    expect(body).toContain('67 green tests');
    expect(body).toContain('integration'); // verifiedHow
    expect(body).toContain('additive, loads next :3070 restart');
    expect(body).toContain('@su-584a8');
  });

  /**
   * P-008 / borrow item 13 — the anti-trust clause, delivered where the PARENT
   * reads the result. A completion asserting no verification must not render
   * identically to one that was integration-tested.
   */
  describe('anti-trust: "done" is not "verified"', () => {
    const unverified = CompletionRecordSchema.parse({
      workItem: 'WI-1',
      summary: 'shipped the thing',
    });

    it('marks a completion carrying NO verification evidence UNVERIFIED in the headline', () => {
      const out = renderCompletion(unverified);
      expect(out.summary).toContain('UNVERIFIED');
      expect(out.body).toContain('means the author yielded, not that the artifacts were checked');
    });

    it('CONTROL: a completion WITH verification evidence gets no such marker', () => {
      // Without this control the assertion above would still pass if the
      // renderer stamped UNVERIFIED unconditionally — i.e. if it stopped
      // discriminating, which is the whole point of the signal.
      expect(renderCompletion(full).summary).not.toContain('UNVERIFIED');
      expect(renderCompletion(full).body).not.toContain('UNVERIFIED');
    });

    it('CONTROL: verifiedHow ALONE (no tests string) also counts as verified', () => {
      const viaVerifiedHow = CompletionRecordSchema.parse({
        workItem: 'WI-2',
        summary: 'drove the UI',
        verifiedHow: 'live-drove-ui',
      });
      expect(renderCompletion(viaVerifiedHow).summary).not.toContain('UNVERIFIED');
      expect(renderCompletion(viaVerifiedHow).summary).toContain('verified:live-drove-ui');
    });

    it('keeps the UNVERIFIED marker even when a long summary forces a clip', () => {
      // The marker must not be a length artefact: clipping the headline from the
      // right would drop the trailer off exactly the most verbose completions,
      // making "no warning" mean "long summary" instead of "verified".
      const verbose = CompletionRecordSchema.parse({
        workItem: 'WI-3',
        summary: 'q'.repeat(400),
      });
      const out = renderCompletion(verbose);
      expect(out.summary.length).toBeLessThanOrEqual(180);
      expect(out.summary).toContain('UNVERIFIED');
    });
  });

  /**
   * ⚠ REPLACES a test that PINNED THE OLD CONTRACT. It read:
   *   'a minimal completion (summary only) renders summary, no empty body'
   *   … expect(out.body).toBeUndefined()
   * That assertion is incompatible with P-008 BY DESIGN, not by accident: a
   * summary-only completion is precisely the completion with no verification
   * evidence, so it is exactly the one that must now carry the anti-trust body.
   * The old test's real intent — never emit a body of blank seams — is kept
   * below as a non-emptiness assertion. Flagged loudly because silently editing
   * a contract-pinning test is how a deliberate behaviour change gets mistaken
   * for a regression later (same shape as WI-36047).
   */
  it('a minimal completion (summary only) is UNVERIFIED, and its body is meaningful (never blank seams)', () => {
    const min = CompletionRecordSchema.parse({ workItem: 'F-001', summary: 'shipped the thing' });
    const out = renderCompletion(min);
    expect(out.summary).toContain('F-001');
    expect(out.summary).toContain('DONE'); // default status
    expect(out.body).toBeDefined();
    expect(out.body?.trim()).toBe(out.body); // no leading/trailing blank seams
    expect(out.body).toContain('UNVERIFIED');
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
  it('renders "Taking <id>" with optional scope (no agent re-embed — P-010)', () => {
    const rec = ClaimRecordSchema.parse({
      workItem: 'BRIEF-test-coverage',
      summary: 'NEW test files only, no source edits',
      agent: 'su-d6be1',
    });
    const { summary } = renderClaim(rec);
    expect(summary).toContain('Taking BRIEF-test-coverage');
    expect(summary).not.toContain('su-d6be1'); // sender shown once by the injection handle
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
