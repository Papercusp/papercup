import { describe, expect, it } from 'vitest';
import { lintInstructionText } from './instruction-lint';

describe('lintInstructionText', () => {
  it('reports duplicate, conflicting, and retired generated rules', () => {
    const out = lintInstructionText([
      '<!-- papercusp-rule:test-router=test-file -->',
      '<!-- papercusp-rule:test-router=test-file -->',
      '<!-- papercusp-rule:test-router=raw-vitest -->',
    ].join('\n'));
    expect(out.duplicateRules).toEqual([
      { key: 'test-router', value: 'test-file', lines: [1, 2] },
    ]);
    expect(out.conflicts).toEqual([
      { key: 'test-router', values: ['test-file', 'raw-vitest'], lines: [1, 2, 3] },
    ]);
    expect(out.staleRules).toEqual([
      { key: 'test-router', value: 'raw-vitest', line: 3, replacement: 'test-file' },
    ]);
    expect(out.clean).toBe(false);
  });

  it('finds exact repeated normative prose but ignores ordinary repeated prose', () => {
    const out = lintInstructionText([
      'You must verify the actual UI before claiming the change is complete.',
      'ordinary context line',
      'ordinary context line',
      'You MUST verify the actual UI before claiming the change is complete!',
    ].join('\n'));
    expect(out.duplicateDirectives).toEqual([
      {
        directive: 'you must verify the actual ui before claiming the change is complete',
        lines: [1, 4],
      },
    ]);
  });

  it('accepts a compact canonical brief', () => {
    const out = lintInstructionText([
      '<!-- papercusp-rule:harness-scope=explicit-per-call -->',
      '<!-- papercusp-rule:test-router=test-file -->',
      '<!-- papercusp-rule:file-locking=automatic-hooks -->',
    ].join('\n'));
    expect(out).toMatchObject({ markerCount: 3, clean: true });
  });
});
