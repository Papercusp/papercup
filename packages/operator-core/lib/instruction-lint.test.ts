import { describe, expect, it } from 'vitest';
import {
  blockingInstructionConflicts,
  buildInstructionPrecedenceTrace,
  lintInstructionText,
  renderInstructionPrecedenceContext,
} from './instruction-lint';

describe('lintInstructionText', () => {
  it('reports duplicate, conflicting, and retired generated rules', () => {
    const out = lintInstructionText(
      [
        '<!-- papercusp-rule:test-router=test-file -->',
        '<!-- papercusp-rule:test-router=test-file -->',
        '<!-- papercusp-rule:test-router=raw-vitest -->',
      ].join('\n'),
    );
    expect(out.duplicateRules).toEqual([{ key: 'test-router', value: 'test-file', lines: [1, 2] }]);
    expect(out.conflicts).toEqual([{ key: 'test-router', values: ['test-file', 'raw-vitest'], lines: [1, 2, 3] }]);
    expect(out.staleRules).toEqual([{ key: 'test-router', value: 'raw-vitest', line: 3, replacement: 'test-file' }]);
    expect(out.clean).toBe(false);
  });

  it('finds exact repeated normative prose but ignores ordinary repeated prose', () => {
    const out = lintInstructionText(
      [
        'You must verify the actual UI before claiming the change is complete.',
        'ordinary context line',
        'ordinary context line',
        'You MUST verify the actual UI before claiming the change is complete!',
      ].join('\n'),
    );
    expect(out.duplicateDirectives).toEqual([
      {
        directive: 'you must verify the actual ui before claiming the change is complete',
        lines: [1, 4],
      },
    ]);
  });

  it('accepts a compact canonical brief', () => {
    const out = lintInstructionText(
      [
        '<!-- papercusp-rule:harness-scope=explicit-per-call -->',
        '<!-- papercusp-rule:test-router=test-file -->',
        '<!-- papercusp-rule:file-locking=automatic-hooks -->',
      ].join('\n'),
    );
    expect(out).toMatchObject({ markerCount: 3, clean: true });
  });

  it('detects the original unmarked Codex manual rule against generated automatic mode', () => {
    const out = lintInstructionText(
      [
        'File-lock enforcement is **NOT automatic on Codex**; call locks:acquire yourself.',
        '<!-- papercusp-rule:file-locking=automatic-hooks -->',
        '- **Edits:** managed hooks claim/release file locks automatically.',
      ].join('\n'),
    );
    expect(out.conflicts).toEqual([
      { key: 'file-locking', values: ['explicit-manual', 'automatic-hooks'], lines: [1, 2] },
    ]);
    expect(blockingInstructionConflicts(out)).toHaveLength(1);
  });

  it('does not duplicate an adjacent marker-backed lock instruction', () => {
    const out = lintInstructionText(
      [
        '<!-- papercusp-rule:file-locking=automatic-hooks -->',
        'File-lock enforcement is **automatic here**: managed hooks cover edits.',
      ].join('\n'),
    );
    expect(out).toMatchObject({ markerCount: 1, conflicts: [], duplicateRules: [], clean: true });
  });

  it('resolves active AUTO over the generic confirm-first posture and explains a bound-plan mission', () => {
    const out = lintInstructionText('<!-- papercusp-rule:test-router=test-file -->', 20, {
      source: 'bootstrap-su',
      ownerId: 'su-x',
      modes: ['auto'],
      route: { kind: 'self' },
      scope: { workspace: 'ws', harness: 'papercusp', plan: 'plan-x', items: ['P-002', 'P-001'] },
      observedAt: '2026-07-13T20:00:00.000Z',
    });
    expect(out.precedenceTrace).toMatchObject({
      schemaVersion: 'instruction-precedence-v1',
      effectiveMission: {
        constraint: 'execute-bound-plan',
        source: 'plan:plan-x',
      },
      decisions: expect.arrayContaining([
        expect.objectContaining({
          key: 'execution-authorization',
          effective: expect.objectContaining({ value: 'act-with-disclosure' }),
          suppressed: [expect.objectContaining({ value: 'confirm-before-execution' })],
        }),
        expect.objectContaining({
          key: 'mission',
          effective: expect.objectContaining({ value: 'execute-bound-plan' }),
        }),
      ]),
    });
    expect(renderInstructionPrecedenceContext(out.precedenceTrace!)).toContain('⟦INSTRUCTION-PRECEDENCE⟧');
  });

  it('uses the live registry mode list even when launch flags are not autonomous', () => {
    const out = lintInstructionText('', 20, {
      source: 'bootstrap-su',
      ownerId: 'su-x',
      modes: ['auto'],
      modeResolution: 'registry',
      route: { kind: 'self' },
    });
    expect(out.precedenceTrace?.decisions.find((d) => d.key === 'execution-authorization')).toMatchObject({
      status: 'effective',
      effective: { value: 'act-with-disclosure' },
    });
  });

  it('renders an explicit unknown when the live mode registry cannot be read', () => {
    const out = lintInstructionText('', 20, {
      source: 'bootstrap-su',
      ownerId: 'su-x',
      modes: [],
      modeResolution: 'unavailable',
      route: { kind: 'self' },
    });
    expect(out.precedenceTrace?.decisions.find((d) => d.key === 'execution-authorization')).toMatchObject({
      status: 'conflict',
      effective: { value: 'unknown' },
    });
    expect(JSON.stringify(out.precedenceTrace)).toContain('unknown, not confirm-first');
  });

  it('makes DRAIN the mission constraint over fleet/plan generics and produces a stable watermark', () => {
    const a = buildInstructionPrecedenceTrace({
      source: 'coord:orient',
      ownerId: 'su-x',
      modes: ['auto', 'drain'],
      route: { kind: 'fleet', fleet: 'bugs', role: 'leader' },
      scope: { plan: 'drain-plan', items: ['P-002', 'P-001'] },
      observedAt: '2026-07-13T20:00:00.000Z',
    });
    const b = buildInstructionPrecedenceTrace({
      source: 'bootstrap-su',
      ownerId: 'su-y',
      modes: ['drain', 'auto'],
      route: { kind: 'fleet', fleet: 'bugs', role: 'leader' },
      scope: { plan: 'drain-plan', items: ['P-001', 'P-002'] },
      observedAt: '2026-07-13T21:00:00.000Z',
    });
    expect(a.effectiveMission).toMatchObject({
      constraint: 'drain-active-scope-to-terminal',
      source: 'mode:drain',
    });
    expect(a.decisions.find((d) => d.key === 'mission')?.suppressed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'generic-backlog-selection' }),
        expect.objectContaining({ value: 'solo-implementation' }),
      ]),
    );
    expect(a.watermark).toBe(b.watermark);
    expect(a.resync.rule).toBe('replace-full-never-merge-behind');
  });

  it('records a canonical replacement as effective and suppresses its retired compiled value', () => {
    const out = lintInstructionText(
      ['<!-- papercusp-rule:test-router=raw-vitest -->', '<!-- papercusp-rule:test-router=test-file -->'].join('\n'),
      20,
      { source: 'bootstrap-su', route: { kind: 'self' } },
    );
    expect(out.precedenceTrace?.decisions.find((d) => d.key === 'test-router')).toMatchObject({
      status: 'effective',
      effective: { value: 'test-file' },
      suppressed: [{ value: 'raw-vitest' }],
    });
  });
});
