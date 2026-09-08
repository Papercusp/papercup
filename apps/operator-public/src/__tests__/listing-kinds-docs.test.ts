/**
 * The public README is part of the Cupboard's catalog contract. Keep its
 * listing-kind inventory and review semantics synchronized with the registry
 * that routes and migrations actually use.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LISTING_KINDS, REVIEW_POLICY_KINDS } from '../db.ts';

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../README.md'), 'utf8');
const listingSection = readme.slice(readme.indexOf('## Listing kinds'), readme.indexOf('\n## Endpoints'));
const rows = [...listingSection.matchAll(/^\|\s*`([^`]+)`\s*\|([^\n]*)$/gm)];

function rowFor(kind: string): string {
  const row = rows.find((match) => match[1] === kind);
  return row?.[0] ?? '';
}

describe('Cupboard README listing-kind contract', () => {
  it('lists exactly the canonical LISTING_KINDS in registry order', () => {
    expect(rows.map((match) => match[1])).toEqual([...LISTING_KINDS]);
  });

  it('documents publish review status from REVIEW_POLICY_KINDS', () => {
    for (const kind of REVIEW_POLICY_KINDS) {
      expect(rowFor(kind), `${kind} must be marked pending`).toMatch(/\*\*pending\*\*/);
    }
    for (const kind of LISTING_KINDS.filter((kind) => !REVIEW_POLICY_KINDS.includes(kind))) {
      expect(rowFor(kind), `${kind} must be marked approved`).toMatch(/\*\*approved\*\*/);
    }
  });

  it('keeps the app delivery split visible in the storefront docs', () => {
    const appRow = rowFor('app');
    expect(appRow).toContain('download');
    expect(appRow).toContain('standalone');
    expect(appRow).toContain('install');
    expect(appRow).toContain('bundle');
  });
});
