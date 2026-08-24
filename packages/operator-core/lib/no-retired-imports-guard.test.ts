/**
 * no-retired-imports-guard.test.ts — capability + LIVE VERDICT for `lint:no-retired`
 * (EI-19971915610840229).
 *
 * ── Why this file exists ──
 *
 * CLAUDE.md's retired-surfaces section closed for months with the flat assertion
 * "`lint:no-retired` guards re-imports". The script existed and passed; NOTHING
 * INVOKED IT. It sat on the acknowledged-unreachable list in
 * `check-lint-guard-reachability.mjs` — doc-asserted, unenforced — which is the worst
 * of the three states: an agent about to import across the retirement boundary reads
 * that sentence and concludes the boundary is watched.
 *
 * Registering the guard in `REPO_WIDE_INVARIANT_GUARDS` is necessary but NOT
 * sufficient, and the reason is easy to miss. `affected-tests.mjs` skips a registered
 * guard's task when that workspace's own `test` task is already scheduled:
 *
 *     if (tasks.some((t) => t.ws.name === ws.name && (t.script === 'test' || …))) continue;
 *
 * i.e. whenever `@papercusp/operator-core` is affected — the common case — the
 * standalone guard task is dropped on the assumption its test suite covers it. Without
 * THIS file that assumption is false, and the guard silently runs on fewer paths than
 * its registration promises. The sibling `lint:no-retired-resurrection` has exactly
 * this pair for exactly this reason.
 *
 * ── Why the legs are ordered this way ──
 *
 * "0 offenders, exit 0" is satisfied PERFECTLY by a guard that has stopped scanning:
 * an empty result is the shared output of "nothing is wrong" and "nothing was
 * examined". So capability is proven FIRST against planted fixtures, then the scan is
 * proven to have REACHED the tree, and only then is the silence asserted. This guard's
 * input is `listTrackedFiles` over a resolved repo root, so a cwd that resolves
 * somewhere unexpected would yield zero files, zero violations, and a confident green.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
// prettier-ignore
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs guard, no type declarations by design (same treatment as the sibling live-tree guards)
import { findOffendersInText, scanTree } from '../../../scripts/check-no-retired-imports.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GUARD = path.join(REPO_ROOT, 'scripts/check-no-retired-imports.mjs');

/**
 * Measured 2026-08-09: 9,594 TS/JS-family files scanned. The floor sits well under
 * that — it catches a COLLAPSE of the scan (wrong root, broken enumeration, submodule
 * boundary), not ordinary census movement.
 */
const MIN_SCANNED = 3_000;

/**
 * ⚠ EVERY offending fixture below is ASSEMBLED AT RUNTIME from these fragments, never
 * written as a literal.
 *
 * This file is tracked, so the guard scans it — and a literal
 * `import … from '…/_retired/…'` in a fixture IS an offender by the guard's own rules.
 * Measured: writing them literally made this very file the repo's only 3 violations.
 *
 * The tempting fix is to add this path to the guard's `isExcluded` list, next to its
 * existing `f === 'scripts/check-no-retired-imports.mjs'` self-exclusion. Don't: that
 * exclusion's own comment (WI-6730) calls it "the same bug papered over one file at a
 * time". Splitting the token keeps the guard maximally strict and costs one const.
 */
const RETIRED = '_retired/';
const SPAWN_ROUTE = '/api/plugins/orchestrator/' + 'spawn';

describe('no-retired-imports guard — capability (both directions)', () => {
  it('FLAGS an import that reaches across the retirement boundary', () => {
    const hits = findOffendersInText(
      'apps/operator/app/_components/Some.tsx',
      `import { OracleDock } from '../../../${RETIRED}legacy-web-chats/OracleDock';\n`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/imports a _retired\/ module/);
  });

  it('FLAGS the retired orchestrator-spawn fetch', () => {
    const hits = findOffendersInText('libs/x/y.ts', `await fetch('${SPAWN_ROUTE}', { method: 'POST' });\n`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/orchestrator\/spawn fetch/);
  });

  it('STAYS SILENT on prose that merely discusses the boundary (WI-6730)', () => {
    // The guard keys on the word `from`, so ordinary commentary about this very
    // policy matches the regex. Comment lines are stripped first — without that, the
    // best-documented files in the repo would be the ones that red the build.
    const hits = findOffendersInText(
      'packages/operator-core/lib/whatever.ts',
      `// a read from \`${RETIRED}\` is a read by something deliberately not deployed\n` +
        ` * imports from ${RETIRED}legacy-web-chats are forbidden\n`,
    );
    expect(hits).toEqual([]);
  });

  it('STAYS SILENT on a bare mention that is not an import context', () => {
    const hits = findOffendersInText(
      'packages/operator-core/lib/whatever.ts',
      `const dir = '${RETIRED}legacy-web-chats';\n`,
    );
    expect(hits).toEqual([]);
  });

  it('CONTROL: this test file is itself clean, so its fixtures cannot red the live leg', () => {
    // The assembled-at-runtime discipline above is only true if it stays true. This
    // asserts it directly rather than trusting the comment.
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(findOffendersInText('packages/operator-core/lib/no-retired-imports-guard.test.ts', self)).toEqual([]);
  });
});

describe('no-retired-imports guard — live verdict over the real tree', () => {
  it('REACHED the tree: the scan examined a plausible number of files', () => {
    const { scanned } = scanTree() as { scanned: number };
    // Asserted BEFORE the silence below, so a collapsed scan cannot masquerade as a
    // clean repository.
    expect(scanned).toBeGreaterThan(MIN_SCANNED);
  });

  it('the repository has no live import of a _retired/ module', () => {
    // Executes the guard as the gate does — this is what puts it on a blocking path
    // per check-lint-guard-reachability.mjs's taxonomy (a logic-test of the predicate
    // alone is classified ADVISORY there, because a green logic test and a rotting
    // guard are perfectly compatible states).
    const out = execFileSync('node', [GUARD], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    expect(out).toMatch(/✓ no live imports of _retired\/ modules/);
  });
});
