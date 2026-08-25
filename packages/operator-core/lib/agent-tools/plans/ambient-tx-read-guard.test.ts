import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PLAN_READERS = [
  'attention.ts',
  'export.ts',
  'get-input-schema.ts',
  'get-item.ts',
  'get-template-data.ts',
  'get.ts',
  'items.ts',
  'lint.ts',
  'list.ts',
  'revision-diff.ts',
  'revision-transcript.ts',
  'revisions-list.ts',
  'run-transcript.ts',
  'runs-list.ts',
  'search.ts',
] as const;

const PLANS_DIR = dirname(import.meta.url.startsWith('file:')
  ? new URL(import.meta.url).pathname
  : resolve('.'));

describe('plans read tools — transaction-free default guard', () => {
  it('keeps every plan reader off the explicit workspace-tx opt-in', () => {
    for (const file of PLAN_READERS) {
      const source = readFileSync(resolve(PLANS_DIR, file), 'utf8');
      expect(source, file).not.toMatch(/needsWorkspaceTx\s*:\s*true/);
    }
  });
});
