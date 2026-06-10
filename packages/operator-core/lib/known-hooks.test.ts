/**
 * Coverage + drift guard for the DBOS hook registry (audit P-016 / EI-94).
 *
 * The registry is static; the drift guard greps every live `runHook('<name>')`
 * call site under lib/dbos/ and asserts set equality with the registry's
 * `live` rows — adding a hook call without a registry row (or a row without a
 * call site) fails here, which is what keeps a hand-maintained table honest.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DBOS_PIPELINE_HOOKS, getKnownHooks } from './known-hooks';

const libDir = dirname(fileURLToPath(import.meta.url));

describe('getKnownHooks', () => {
  it('returns exactly the live hooks, sorted', () => {
    expect(getKnownHooks()).toEqual(['afterDone', 'on-escalate']);
  });

  it('never advertises lost (EI-95 backlog) hooks', () => {
    const lost = DBOS_PIPELINE_HOOKS.filter((h) => h.status === 'lost').map((h) => h.name);
    expect(lost.length).toBeGreaterThan(0);
    // The old grep-of-retired-main-loop floor value stays catalogued as lost,
    // never advertised (EI-94: the UI listed 'pre-worker' though nothing fires it).
    expect(lost).toContain('pre-worker');
    for (const name of lost) expect(getKnownHooks()).not.toContain(name);
  });

  it('registry names are unique', () => {
    const names = DBOS_PIPELINE_HOOKS.map((h) => h.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('registry drift guard', () => {
  it("matches the live pipeline's runHook call sites under lib/dbos/", () => {
    const dbosDir = join(libDir, 'dbos');
    const found = new Set<string>();
    const re = /\brunHook\(\s*['"]([A-Za-z][\w-]*)['"]/g;
    for (const entry of readdirSync(dbosDir, { recursive: true })) {
      const rel = String(entry);
      if (!rel.endsWith('.ts') || rel.endsWith('.test.ts')) continue;
      const src = readFileSync(join(dbosDir, rel), 'utf8');
      for (const m of src.matchAll(re)) found.add(m[1]);
    }
    const live = DBOS_PIPELINE_HOOKS.filter((h) => h.status === 'live')
      .map((h) => h.name)
      .sort();
    expect([...found].sort()).toEqual(live);
  });
});
