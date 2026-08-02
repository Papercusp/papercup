// TEMPORARY negative control for EI-19374654827980571. Deleted immediately.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const SPA_BUNDLE = resolve(REPO_ROOT, 'apps/operator-vite/dist', 'index.js');

describe('seeded violation', () => {
  it('requires the SPA bundle to exist', () => {
    expect(existsSync(SPA_BUNDLE)).toBe(true);
  });
});
