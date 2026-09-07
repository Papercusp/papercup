/**
 * EI-21291355400042356 — the live coord:presence schema has no fleet filter.
 * Keep the Papercusp SU instance guidance on fleet:assignments for fleet-scoped
 * monitoring and reserve coord:presence for its supported live/owner reads.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts',
  'pot-instances',
  'papercup-pot.su.md',
);
const PROMPT_PROJECTIONS = [
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'papercusp-desktop',
    'src-tauri',
    'env-sidecars',
    'staging',
    'prompts',
    'pot-instances',
    'papercup-pot.su.md',
  ),
];

describe('Papercusp SU fleet-monitoring guidance', () => {
  it('does not prescribe the rejected coord:presence fleet filter', () => {
    const source = readFileSync(PROMPT, 'utf8');

    expect(source).toContain('`fleet:assignments`; use `coord:presence` for the live roster or a targeted owner lookup');
    expect(source).not.toContain('`coord:presence` filtered to the fleet');
  });

  it('keeps the committed desktop prompt projection byte-identical to its source', () => {
    const source = readFileSync(PROMPT, 'utf8');

    for (const projection of PROMPT_PROJECTIONS) {
      expect(readFileSync(projection, 'utf8'), projection).toBe(source);
    }
  });
});
