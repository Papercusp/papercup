import { describe, expect, it } from 'vitest';
import { blockingInstructionConflicts, lintInstructionText } from './instruction-lint';

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
});
