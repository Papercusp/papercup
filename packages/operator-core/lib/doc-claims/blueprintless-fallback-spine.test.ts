/**
 * The blueprint-less fallback spine claim — see `blueprintless-fallback-spine.ts` for
 * why it exists (sibling of `gate-candidate-ref.test.ts` / `retired-surfaces.test.ts`,
 * same doc-claims family).
 *
 * The FIXTURE controls are load-bearing for the reason the siblings state: once the live
 * assertion goes green it stops being evidence that the detector works at all. Each
 * fixture below reproduces a shape that MUST be caught — including the three exact
 * comments that were live in this tree until 2026-08-16 (WI-39505).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeBlueprintlessFallback, commentsOnly, stripComments } from './blueprintless-fallback-spine';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ORCHESTRATOR_WORKFLOW = join(ROOT, 'packages/operator-core/lib/dbos/orchestrator-workflow.ts');
const BLUEPRINT_RUN_ACTION = join(ROOT, 'packages/operator-core/lib/blueprint/blueprint-run-action.ts');
const ORCHESTRATOR_START = join(ROOT, 'packages/operator-core/lib/dbos/orchestrator-start.ts');

const read = (p: string): string => readFileSync(p, 'utf8');

describe('comment/code separation helpers', () => {
  it('stripComments removes comments and preserves line numbering', () => {
    const src = ['const a = 1; // trailing', '/* block', '   still block */ const b = 2;', 'const c = 3;'].join('\n');
    const code = stripComments(src);
    expect(code.split('\n')).toHaveLength(4);
    expect(code).not.toMatch(/trailing|still block/);
    expect(code).toMatch(/const a = 1;/);
    expect(code).toMatch(/const b = 2;/);
  });

  it('commentsOnly keeps comment text and preserves line numbering', () => {
    const src = ['const a = 1; // trailing', '/* block', '   still block */ const b = 2;', 'const c = 3;'].join('\n');
    const comments = commentsOnly(src);
    expect(comments.split('\n')).toHaveLength(4);
    expect(comments).toMatch(/trailing/);
    expect(comments).toMatch(/still block/);
    expect(comments).not.toMatch(/const c = 3/);
  });
});

describe('fixture controls (the detector must be able to FAIL)', () => {
  const loader = (id: string) => `
    let _spine = null;
    function codingSpine() {
      return (_spine ??= loadBuiltinBlueprint('${id}').blueprint.spine);
    }
  `;

  it('catches loaders that DISAGREE about the fallback blueprint', () => {
    const verdict = judgeBlueprintlessFallback({
      loaders: [
        { file: 'orchestrator-workflow.ts', source: loader('coding-solo') },
        { file: 'blueprint-run-action.ts', source: loader('coding-factory') },
      ],
      docs: [],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.effectiveId).toBeNull();
    expect(verdict.violations.join('\n')).toMatch(/disagree about which builtin/);
  });

  it("catches the live-until-2026-08-16 orchestrator-start docstring (names `coding`, not the real fallback)", () => {
    const verdict = judgeBlueprintlessFallback({
      loaders: [{ file: 'orchestrator-workflow.ts', source: loader('coding-solo') }],
      docs: [
        {
          file: 'orchestrator-start.ts',
          source: `
            /**
             * Returns null when the harness has no blueprint file — the pipeline then
             * defaults to the built-in \`coding\` spine (every pre-blueprint harness), so
             * this is behavior-preserving.
             */
            async function resolveHarnessSpine() {}
          `,
        },
      ],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.unnamedBy).toContain('orchestrator-start.ts');
    expect(verdict.violations.join('\n')).toMatch(/never names 'coding-solo'/);
    // and it is ALSO caught by the behavior-preserving property
    expect(verdict.behaviorPreservingClaims).toHaveLength(1);
  });

  it('catches the "behavior-preserving default" justification even when the id IS named', () => {
    const verdict = judgeBlueprintlessFallback({
      loaders: [{ file: 'orchestrator-workflow.ts', source: loader('coding-solo') }],
      docs: [
        {
          file: 'blueprint-run-action.ts',
          source: `
            // codingFallback() is the documented behavior-preserving default for every
            // blueprint-less harness, and loads coding-solo.
            const bp = resolved ?? codingFallback();
          `,
        },
      ],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.unnamedBy).toHaveLength(0); // the id IS named — property 2 is satisfied
    expect(verdict.violations.join('\n')).toMatch(/orchestration-OFF ablation arm/);
  });

  it('does NOT fire on an unrelated true use of "behavior-preserving" in a DIFFERENT block', () => {
    // Mirrors the real shape in orchestrator-workflow.ts: the fallback is documented in
    // one block, and the maxTurns env-override note — a legitimate, TRUE use of the
    // phrase — is a separate block after an intervening line of code.
    const verdict = judgeBlueprintlessFallback({
      loaders: [{ file: 'orchestrator-workflow.ts', source: loader('coding-solo') }],
      docs: [
        {
          file: 'orchestrator-workflow.ts',
          source: [
            "            // The codingSpine() fallback loads coding-solo (single-agent).",
            '            const spineVerbs = Object.keys(spine.edges ?? {});',
            '            // MAX_TURNS is a blueprint knob; the env var stays an operational',
            "            // override (behavior-preserving: unset → the spine's 200).",
            '            const maxTurns = Number(process.env.X ?? spine.maxTurns);',
          ].join('\n'),
        },
      ],
    });
    expect(verdict.behaviorPreservingClaims).toHaveLength(0);
    expect(verdict.ok).toBe(true);
  });

  it('DOES fire when that same phrase sits in the fallback block on a different line', () => {
    // The per-line detector missed exactly this; the block scoping is what catches it.
    const verdict = judgeBlueprintlessFallback({
      loaders: [{ file: 'orchestrator-workflow.ts', source: loader('coding-solo') }],
      docs: [
        {
          file: 'orchestrator-start.ts',
          source: [
            '            // Returns null when the harness has no blueprint file — it then',
            '            // falls back to coding-solo,',
            '            // so this is behavior-preserving.',
          ].join('\n'),
        },
      ],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.behaviorPreservingClaims).toHaveLength(1);
    expect(verdict.behaviorPreservingClaims[0].line).toBe(3);
  });

  it('does NOT fire on prose that DENIES the claim (the correction, not the defect)', () => {
    const verdict = judgeBlueprintlessFallback({
      loaders: [{ file: 'orchestrator-workflow.ts', source: loader('coding-solo') }],
      docs: [
        {
          file: 'orchestrator-start.ts',
          source: `
            // ⚠ The blueprint-less fallback is coding-solo and is NOT behavior-preserving.
            const spine = null;
          `,
        },
      ],
    });
    expect(verdict.behaviorPreservingClaims).toHaveLength(0);
    expect(verdict.ok).toBe(true);
  });

  it('catches a fallback loader that moved or was renamed away', () => {
    const verdict = judgeBlueprintlessFallback({
      loaders: [{ file: 'orchestrator-workflow.ts', source: 'function codingSpine() { return somethingElse(); }' }],
      docs: [],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.join('\n')).toMatch(/no loadBuiltinBlueprint/);
  });

  it('passes the shape it is meant to accept (calibration — controls above are not vacuous)', () => {
    const verdict = judgeBlueprintlessFallback({
      loaders: [
        { file: 'orchestrator-workflow.ts', source: loader('coding-solo') },
        { file: 'blueprint-run-action.ts', source: loader('coding-solo') },
      ],
      docs: [{ file: 'orchestrator-start.ts', source: '// falls back to coding-solo (single-agent).' }],
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.effectiveId).toBe('coding-solo');
  });
});

describe('the live tree', () => {
  it('both fallback loaders agree, and every documenting site names the blueprint actually loaded', () => {
    const verdict = judgeBlueprintlessFallback({
      loaders: [
        { file: 'orchestrator-workflow.ts', source: read(ORCHESTRATOR_WORKFLOW) },
        { file: 'blueprint-run-action.ts', source: read(BLUEPRINT_RUN_ACTION) },
      ],
      docs: [
        { file: 'orchestrator-start.ts', source: read(ORCHESTRATOR_START) },
        { file: 'orchestrator-workflow.ts', source: read(ORCHESTRATOR_WORKFLOW) },
        { file: 'blueprint-run-action.ts', source: read(BLUEPRINT_RUN_ACTION) },
      ],
    });
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
    // Not an assertion that it MUST be coding-solo — only that whatever it is, it is one
    // thing and the prose says so. Repointing is allowed; repointing silently is not.
    expect(verdict.effectiveId).toBeTruthy();
  });
});
