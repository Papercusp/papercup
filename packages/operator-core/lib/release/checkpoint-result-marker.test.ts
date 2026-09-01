import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { GREEN_CHECKPOINT_RESULT_MARKER } from './checkpoint-log-tags';

const REPO_ROOT = resolve(__dirname, '../../../..');
const MARKER_LITERAL = '__GREEN_CHECKPOINT_RESULT__';
const CONSUMERS = [
  {
    path: 'apps/operator/lib/release/green-checkpoint.ts',
    importPath: '../../../../packages/operator-core/lib/release/checkpoint-log-tags',
  },
  {
    path: 'packages/operator-core/lib/release-checkpoint-launch.ts',
    importPath: './release/checkpoint-log-tags',
  },
  {
    path: 'packages/operator-core/lib/harness/routines/release-actions.ts',
    importPath: '../../release/checkpoint-log-tags',
  },
] as const;

describe('green-checkpoint terminal result marker identity', () => {
  it('preserves the stable wire token', () => {
    expect(GREEN_CHECKPOINT_RESULT_MARKER).toBe(MARKER_LITERAL);
  });

  it('has exactly one production literal definition', () => {
    const definition = readFileSync(resolve(__dirname, 'checkpoint-log-tags.ts'), 'utf8');
    expect(definition.split(MARKER_LITERAL)).toHaveLength(2);

    for (const consumer of CONSUMERS) {
      const source = readFileSync(resolve(REPO_ROOT, consumer.path), 'utf8');
      // Production comments may quote the wire token to document the contract. The recurrence
      // guard is about executable duplication: a second constant initializer in any consumer.
      expect(source, consumer.path).not.toMatch(
        /(?:const|let|var)\s+GREEN_CHECKPOINT_RESULT_MARKER\s*=\s*['"]__GREEN_CHECKPOINT_RESULT__['"]/,
      );
    }
  });

  it('wires every producer and parser to the zero-import leaf', () => {
    for (const consumer of CONSUMERS) {
      const source = readFileSync(resolve(REPO_ROOT, consumer.path), 'utf8');
      const singleQuotedImport = `from '${consumer.importPath}'`;
      const doubleQuotedImport = `from "${consumer.importPath}"`;
      expect(source, consumer.path).toContain('GREEN_CHECKPOINT_RESULT_MARKER');
      expect(
        source.includes(singleQuotedImport) || source.includes(doubleQuotedImport),
        `${consumer.path} must import from ${consumer.importPath}`,
      ).toBe(true);
    }
  });
});
