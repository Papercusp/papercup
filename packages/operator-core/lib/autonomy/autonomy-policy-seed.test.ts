/**
 * autonomy-policy-seed.test.ts — drift guard between migration 259's seed and
 * the canonical taxonomy in categories.ts (queen-autonomy-policy-2026-06-13 B-03).
 *
 * The migration seeds category rows as SQL literals (SQL can't import the TS
 * taxonomy), so the two could silently diverge — and a divergent seed would key
 * autonomy rows on ids the gate (B-12) can't resolve. This reads the migration
 * file and asserts its seeded category set === AUTONOMY_CATEGORY_IDS, its
 * locked set === PROTECTED_CATEGORIES, and every seeded ceiling is `never-auto`
 * (D-007 behavior-neutral). Pure — reads the file, no DB.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AUTONOMY_CATEGORY_IDS, PROTECTED_CATEGORIES } from './categories';

const MIGRATION = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/259-autonomy-policy.sql', import.meta.url),
);

/** Parse the seed VALUES rows: ('default', '<cat>', '<ceiling>', <locked>, '<grad>', 'migration:259'). */
function parseSeed(): { categories: string[]; ceilings: Set<string>; locked: Set<string> } {
  const sql = readFileSync(MIGRATION, 'utf8');
  const re =
    /\(\s*'default',\s*'([a-z0-9-]+)',\s*'([a-z-]+)',\s*(true|false),\s*'[a-z-]+',\s*'migration:259'\s*\)/g;
  const categories: string[] = [];
  const ceilings = new Set<string>();
  const locked = new Set<string>();
  for (let m = re.exec(sql); m !== null; m = re.exec(sql)) {
    categories.push(m[1]!);
    ceilings.add(m[2]!);
    if (m[3] === 'true') locked.add(m[1]!);
  }
  return { categories, ceilings, locked };
}

describe('migration 259 autonomy_policy seed', () => {
  it('seeds exactly the 13 canonical category ids (no drift from categories.ts)', () => {
    const { categories } = parseSeed();
    expect(categories).toHaveLength(AUTONOMY_CATEGORY_IDS.length);
    expect(new Set(categories)).toEqual(new Set(AUTONOMY_CATEGORY_IDS));
  });

  it('locks exactly the protected set (D-005)', () => {
    const { locked } = parseSeed();
    expect(locked).toEqual(new Set(PROTECTED_CATEGORIES));
  });

  it('ships every category at ceiling `never-auto` — behavior-neutral (D-007)', () => {
    const { ceilings } = parseSeed();
    expect(ceilings).toEqual(new Set(['never-auto']));
  });
});
