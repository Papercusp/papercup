// The browser shim for `@papercusp/coordination/event-log` must export every VALUE
// its importers import — or the SPA build dies at LINK time (rolldown
// MISSING_EXPORT), which happens AFTER vite has already emptied dist/ and so
// DESTROYS the bundle that was serving (EI-10539).
//
// That is exactly what took the desktop down on 2026-07-12: a peer's
// `agent-tools/coordination/log.ts` started importing `PgCoordLog` from the
// aliased specifier, the shim only exported `DEFAULT_COORD_WORKSPACE`, and the
// next build left a dead app behind a 503. Nothing in the test suite noticed —
// the shim is only linked by the real `vite build`, so a unit run stays green
// while the bundle is unbuildable. This test IS that missing detector: it reads
// what the importers actually ask for and fails here, in milliseconds, instead of
// in a build that eats the bundle.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as shim from '../shims/coordination-event-log-browser';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SPECIFIER = '@papercusp/coordination/event-log';

/** Source trees the SPA bundle can reach (operator-core is aliased straight in). */
const SEARCH_ROOTS = [
  join(REPO_ROOT, 'packages/operator-core/lib'),
  join(REPO_ROOT, 'apps/operator'),
  join(REPO_ROOT, 'apps/operator-vite/src'),
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite', '__tests__', 'e2e', '_retired']);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // tree not present in this checkout — nothing to scan
  }
  for (const name of entries) {
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(abs);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      yield abs;
    }
  }
}

/**
 * Every VALUE binding imported from the aliased specifier, across the SPA-reachable
 * source. `import type { … }` and inline `{ type X }` are erased before the bundler
 * ever links them, so they are not the shim's problem — only values are.
 */
export function valueImportsOf(source: string, specifier: string): string[] {
  const names: string[] = [];
  const re = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"]${specifier.replace(/[/@]/g, '\\$&')}['"]`, 'g');
  for (const m of source.matchAll(re)) {
    if (m[1]) continue; // `import type { … }` — erased at compile time
    for (const raw of m[2].split(',')) {
      const spec = raw.trim();
      if (!spec || /^type\s/.test(spec)) continue; // inline `{ type Foo }`
      names.push((spec.split(/\s+as\s+/)[0] ?? '').trim());
    }
  }
  return names.filter(Boolean);
}

describe('coordination-event-log browser shim (EI-10539)', () => {
  it('exports every value binding its importers import — a miss is a bundle-destroying MISSING_EXPORT', () => {
    const missing: string[] = [];
    let importers = 0;

    for (const root of SEARCH_ROOTS) {
      for (const file of walk(root)) {
        const src = readFileSync(file, 'utf8');
        if (!src.includes(SPECIFIER)) continue;
        const names = valueImportsOf(src, SPECIFIER);
        if (names.length > 0) importers += 1;
        for (const name of names) {
          if (!(name in shim)) {
            missing.push(`${name}  ← imported by ${file.slice(REPO_ROOT.length + 1)}`);
          }
        }
      }
    }

    // Guard the guard: if the scan finds no importers at all, the specifier was
    // renamed and this test has silently stopped protecting anything.
    expect(importers, `no file imports ${SPECIFIER} — did the specifier move?`).toBeGreaterThan(0);
    expect(missing, `shim is missing exports the SPA bundle links against:\n${missing.join('\n')}`).toEqual([]);
  });

  it('the PgCoordLog stub constructs silently — log.ts builds one at MODULE SCOPE', () => {
    // `let impl: CoordEventLog = makeDefaultLog()` runs on import, in the browser.
    expect(() => new shim.PgCoordLog({ getSql: () => null, ensureSchema: async () => {} })).not.toThrow();
  });

  it('but any CALL on it throws loudly — a silent no-op would swallow coord writes', () => {
    const log = new shim.PgCoordLog() as unknown as Record<string, (...a: unknown[]) => unknown>;
    expect(() => log.append({})).toThrow(/server-only/);
    expect(() => log.read()).toThrow(/server-only/);
  });

  it('does not masquerade as a thenable — an await on it must not explode', async () => {
    const log = new shim.PgCoordLog();
    await expect(Promise.resolve(log)).resolves.toBeDefined();
  });
});

describe('valueImportsOf', () => {
  it('collects value imports and ignores type-only ones', () => {
    const src = [
      `import { PgCoordLog, DEFAULT_COORD_WORKSPACE } from '${SPECIFIER}';`,
      `import type { CoordEventLog } from '${SPECIFIER}';`,
      `import { type OnlyAType, RealValue as Aliased } from '${SPECIFIER}';`,
    ].join('\n');
    expect(valueImportsOf(src, SPECIFIER)).toEqual([
      'PgCoordLog',
      'DEFAULT_COORD_WORKSPACE',
      'RealValue',
    ]);
  });
});
