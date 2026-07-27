/**
 * AUTHORING.md is the file an agent reads precisely BECAUSE it does not yet
 * know its way around the llm-testing subsystem — which makes it the worst
 * possible place for a stale path, and the place a stale path survives longest
 * (nothing executes a doc).
 *
 * It rotted exactly that way: the whole framework moved to
 * `packages/operator-core/lib/llm-testing/`, but AUTHORING.md and CLAUDE.md
 * both went on pointing at `apps/operator/lib/llm-testing/...`. That path still
 * EXISTS (it holds `fixtures/`), so it does not read as a typo — an agent
 * following it just finds no scenarios and falls back to a tree-wide `find`.
 * Filed as EI-18766593465070802 while authoring the P-011 scenarios.
 *
 * This is the recurrence guard for that class: every repo-relative path the
 * guide names must resolve on disk. Fixing the paths without this test just
 * re-arms the trap for whoever moves the framework next.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
/** __tests__ -> llm-testing -> lib -> operator-core -> packages -> <repo root> */
const REPO_ROOT = resolve(HERE, '../../../../..');
const AUTHORING = join(HERE, '..', 'AUTHORING.md');

/** Workspace roots a repo-relative path in this guide can start with. */
const ROOTS = ['packages', 'apps', 'libs', 'scripts'];

const PATH_RE = new RegExp(`\\b(?:${ROOTS.join('|')})\\/[A-Za-z0-9._<>*/-]+`, 'g');

/**
 * Reduce a documented path to the deepest part that must exist verbatim.
 *
 * The guide legitimately uses placeholder segments (`scenarios/<target>/<id>.ts`,
 * `rubrics/*`), so a literal existence check would fail on correct docs. Cutting
 * at the first placeholder leaves the concrete prefix — which is the part that
 * actually rots when a directory moves.
 */
function concretePrefix(raw: string): string | null {
  const cleaned = raw.replace(/[.,;:)\]]+$/, '');
  const segments = cleaned.split('/');
  const concrete: string[] = [];
  for (const seg of segments) {
    if (seg.includes('<') || seg.includes('*')) break;
    concrete.push(seg);
  }
  // A bare workspace root ("packages") carries no information — skip it.
  return concrete.length > 1 ? concrete.join('/') : null;
}

describe('AUTHORING.md paths resolve on disk', () => {
  it('every repo-relative path the guide names exists', async () => {
    const text = await readFile(AUTHORING, 'utf8');
    const found = new Set<string>();

    for (const match of text.matchAll(PATH_RE)) {
      const prefix = concretePrefix(match[0]);
      if (prefix) found.add(prefix);
    }

    // Guard the guard: if the extraction stops matching, the test would pass
    // vacuously and the drift it exists to catch would sail straight through.
    expect(found.size).toBeGreaterThan(3);

    const missing = [...found].filter((p) => !existsSync(join(REPO_ROOT, p))).sort();

    expect(
      missing,
      missing.length
        ? `AUTHORING.md names ${missing.length} path(s) that do not exist:\n` +
            missing.map((p) => `  - ${p}`).join('\n') +
            '\n\nEither the doc is stale or the file moved. Fix the doc — an agent ' +
            'reading this guide does not yet know the tree well enough to notice.'
        : undefined,
    ).toEqual([]);
  });

  it('does not tell the reader to run pnpm (this repo is only-allow npm)', async () => {
    const text = await readFile(AUTHORING, 'utf8');
    // The root package.json's preinstall runs only-allow npm, and pnpm fails on
    // the first private @papercusp/* package with an error unrelated to what the
    // reader was doing (EI-7243). A mechanical pnpm->npm swap also drops the `--`
    // that `npm run` needs, so the flags are silently swallowed rather than erroring.
    const offenders = text
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter((row) => /\bpnpm\b/.test(row.line));

    expect(
      offenders.map((r) => `${r.n}: ${r.line.trim()}`),
      'AUTHORING.md must use `npm run llm-test -- <flags>` (note the `--`), never pnpm.',
    ).toEqual([]);
  });
});
