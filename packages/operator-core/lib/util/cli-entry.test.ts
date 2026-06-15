import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCliEntry } from './cli-entry';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('isCliEntry', () => {
  it('returns true when the URL is the running entrypoint (non-bundled fallback)', () => {
    // Under vitest the define is absent, so the real path comparison runs.
    // process.argv[1] is the vitest entry; its file URL is "the entry".
    expect(isCliEntry(pathToFileURL(process.argv[1]).href)).toBe(true);
  });

  it('returns false for any other module URL', () => {
    expect(isCliEntry('file:///some/other/module.ts')).toBe(false);
    expect(isCliEntry(pathToFileURL(process.argv[1]).href + '.not')).toBe(false);
  });
});

/**
 * EI-650 regression guard. The desktop sidecar esbuild-bundles the whole
 * operator-core host graph into one serve.mjs. In that bundle every inlined
 * module shares one import.meta.url (== process.argv[1]), so a NAIVE ESM
 * self-exec guard fires for every bundled library-CLI at boot — running its
 * main()+process.exit() and killing the operator before it serves. Library
 * CLIs must guard with isCliEntry() (bundle-aware) instead. This test fails if
 * any operator-core lib file reintroduces the naive idiom.
 */
describe('no naive ESM self-exec guard in operator-core/lib (EI-650)', () => {
  // The three naive spellings that all collapse to TRUE inside the bundle:
  //   import.meta.url === `file://${process.argv[1]}`
  //   import.meta.url === pathToFileURL(process.argv[1]).href
  //   fileURLToPath(import.meta.url) === process.argv[1]
  const NAIVE_GUARD =
    /import\.meta\.url\s*===\s*`file:\/\/\$\{process\.argv\[1\]\}`|import\.meta\.url\s*===\s*pathToFileURL\(\s*process\.argv\[1\]\s*\)\.href|fileURLToPath\w*\(\s*import\.meta\.url\s*\)\s*===\s*process\.argv\[1\]/;

  const LIB_ROOT = resolve(HERE, '..');
  // cli-entry.ts is the ONE allowed home of the real path comparison (the
  // non-bundled fallback) — it is the helper that fixes the class.
  const ALLOW = new Set([join(LIB_ROOT, 'util', 'cli-entry.ts')]);

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (name === 'node_modules' || name === '__snapshots__') continue;
        out.push(...walk(p));
      } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
        out.push(p);
      }
    }
    return out;
  }

  it('every library CLI guards with isCliEntry(), not a raw import.meta.url comparison', () => {
    const offenders = walk(LIB_ROOT)
      .filter((p) => !ALLOW.has(p))
      .filter((p) => NAIVE_GUARD.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(LIB_ROOT.length + 1));
    expect(
      offenders,
      `These files use a naive ESM self-exec guard that fires at boot when bundled into the desktop sidecar (EI-650). ` +
        `Replace it with \`if (isCliEntry(import.meta.url)) { ... }\` from lib/util/cli-entry.ts:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
