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
const rows = [...listingSection.matchAll(/^\|\s*`([^`]+)`\s*\|([^\n]*)$/gm)].filter(
  (match) => match[1] !== 'listing_kind',
);

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two',
  'twenty-three', 'twenty-four', 'twenty-five',
] as const;

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

  it('states the current kind count in both the heading and the storefront prose', () => {
    // The row assertion above compares the SET, never the count, so it is
    // structurally unable to catch the README's two PROSE counts going stale —
    // which is exactly what happened: `rule` landed as a fourteenth row while
    // both sites still read "thirteen". Prose cannot be derived from the
    // registry, so it is PINNED here instead: the word is computed from
    // LISTING_KINDS.length and both sites must carry it.
    const expected = NUMBER_WORDS[LISTING_KINDS.length];
    expect(expected, `add a number word for ${LISTING_KINDS.length} kinds`).toBeDefined();
    expect(listingSection).toContain(`## Listing kinds (one storefront, ${expected} kinds)`);
    expect(listingSection).toContain(`ONE storefront with ${expected} listing kinds`);
  });

  it('keeps the app delivery split visible in the storefront docs', () => {
    const appRow = rowFor('app');
    expect(appRow).toContain('download');
    expect(appRow).toContain('standalone');
    expect(appRow).toContain('install');
    expect(appRow).toContain('bundle');
  });
});
