/**
 * retired-resurrection-guard.test.ts — capability + LIVE VERDICT for
 * `lint:no-retired-resurrection` (WI-37422).
 *
 * ⚠ THE ORDER OF THE LEGS IS LOAD-BEARING, and for the reason
 * `no-bespoke-state-read-live.test.ts` spells out: "0 resurrections, exit 0" is
 * satisfied PERFECTLY by a guard that has stopped scanning. An empty result is the
 * shared output of "nothing is wrong" and "nothing was examined", so the verdict
 * alone cannot be the test. Capability is proven first — both directions, against a
 * planted fixture — then the scan is proven to have REACHED the tree (floors on what
 * it counted), and only then is the silence asserted.
 *
 * That third leg matters more here than usual because this guard's whole input is
 * `git ls-files -s` run in a resolved repo root. A cwd that resolves somewhere
 * unexpected, a submodule boundary, or a renamed `_retired/` would each yield zero
 * entries — and therefore zero violations, exit 0, a confident green.
 *
 * This test EXECUTES the guard over the real repository (not just its helpers), which
 * is what puts it on a blocking path per `check-lint-guard-reachability.mjs`'s own
 * taxonomy: a logic-test of the predicate is classified ADVISORY there, because "a
 * green logic test and a rotting guard are perfectly compatible states".
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
// prettier-ignore
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs guard, no type declarations by design (same treatment as the sibling live-tree guards)
import {
  assessBuiltinCellDeclarations,
  findRemovedCellIdentifiers,
  findResurrections,
  parseLsFiles,
} from '../../../scripts/check-retired-resurrection.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GUARD = path.join(REPO_ROOT, 'scripts/check-retired-resurrection.mjs');

/** Measured 2026-08-09: 21,041 tracked files, 771 under `_retired/`. The floors sit
 *  well under those — they catch a COLLAPSE of the scan, not census growth. */
const MIN_TRACKED_SCANNED = 5_000;
const MIN_RETIRED_SCANNED = 200;

describe('retired-resurrection guard — capability (both directions)', () => {
  it('FLAGS the WI-37422 shape: identical bytes at a retired AND a live path', () => {
    const hits = findResurrections(
      [
        { sha: 'aaa', path: '_retired/topics-subscribe/topics-subscribe.ts' },
        { sha: 'aaa', path: 'packages/operator-core/lib/agent-tools/coordination/tools/topics-subscribe.ts' },
      ],
      new Map([['aaa', 4096]]),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].retiredPaths).toEqual(['_retired/topics-subscribe/topics-subscribe.ts']);
    expect(hits[0].livePaths).toEqual([
      'packages/operator-core/lib/agent-tools/coordination/tools/topics-subscribe.ts',
    ]);
  });

  it('does NOT flag a retired file with no live twin (the completed-retirement state)', () => {
    const hits = findResurrections(
      [
        { sha: 'aaa', path: '_retired/topics-subscribe/topics-subscribe.ts' },
        { sha: 'bbb', path: 'packages/operator-core/lib/agent-tools/coordination/tools/topics-tag.ts' },
      ],
      new Map([
        ['aaa', 4096],
        ['bbb', 2048],
      ]),
    );
    expect(hits).toEqual([]);
  });

  it('does NOT flag same-BASENAME files whose bytes differ — identity is the signature, not the name', () => {
    const hits = findResurrections(
      [
        { sha: 'aaa', path: '_retired/papercup/README.md' },
        { sha: 'ccc', path: 'README.md' },
      ],
      new Map([
        ['aaa', 900],
        ['ccc', 1200],
      ]),
    );
    expect(hits).toEqual([]);
  });

  it('does NOT flag ZERO-BYTE blobs — every empty file in the repo shares one sha', () => {
    // The single real collision measured on this tree (`_retired/papercup/.next/turbopack`
    // against `.bashrc` et al). Without this exclusion the guard is permanently red.
    const entries = [
      { sha: 'e69de29', path: '_retired/papercup/.next/turbopack' },
      { sha: 'e69de29', path: '.bashrc' },
    ];
    expect(findResurrections(entries, new Map([['e69de29', 0]]))).toEqual([]);
    // ...and a sha whose size is UNKNOWN is treated as non-empty, so a size lookup
    // that silently failed can never suppress a real hit.
    expect(findResurrections(entries, new Map())).toHaveLength(1);
  });

  it('parses the `git ls-files -s` record shape, including paths containing spaces', () => {
    const parsed = parseLsFiles(
      '100644 aaa 0\t_retired/a.ts\n100644 bbb 0\tpackages/some dir/b.ts\n',
    );
    expect(parsed).toEqual([
      { sha: 'aaa', path: '_retired/a.ts' },
      { sha: 'bbb', path: 'packages/some dir/b.ts' },
    ]);
  });
});

describe('cell retirement ratchet — scoped identifiers + assessment census', () => {
  it('rejects every retired cell identifier shape without banning unrelated vocabulary', () => {
    const hits = findRemovedCellIdentifiers([
      {
        path: 'packages/operator-core/lib/cell-read.ts',
        source:
          'CellFalsifier CellFalsifierRead falsifierFrom falsifierPathExists falsifierPath falsifierLines ' +
          'spec.falsifier spec["falsifier"] falsifier?: unknown',
      },
      {
        path: 'packages/operator-core/lib/leader-blocker-stall-alert.ts',
        source: 'const falsifier = independentScientificCheck();',
      },
    ]);

    expect(new Set(hits.map((hit) => hit.identifier))).toEqual(
      new Set([
        'CellFalsifier',
        'CellFalsifierRead',
        'falsifierFrom',
        'falsifierPathExists',
        'falsifierPath',
        'falsifierLines',
        'CellSpec.falsifier property',
      ]),
    );
    expect(hits.every((hit) => hit.path.endsWith('/cell-read.ts'))).toBe(true);
  });

  it('requires exactly one non-null assessment on every poll/value-bearing built-in', () => {
    const result = assessBuiltinCellDeclarations(`
      const SHARED_CELL_FIELDS = { nullable: true };
      const GOOD_CELL: CellSpec = {
        ...SHARED_CELL_FIELDS,
        changeSignal: { kind: 'poll', tool: 'state:read', path: 'value' },
        assessment: assessmentSpec(),
      };
      const MISSING_CELL: CellSpec = {
        changeSignal: { kind: 'poll', tool: 'state:read', path: 'value' },
      };
      const NULL_CELL: CellSpec = {
        changeSignal: { kind: 'poll', tool: 'state:read', path: 'value' },
        assessment: null,
      };
      const EVENT_CELL: CellSpec = {
        changeSignal: { kind: 'event', key: 'done' },
        assessment: null,
      };
      const BUILTIN_CELLS: CellSpec[] = [GOOD_CELL, MISSING_CELL, NULL_CELL, EVENT_CELL];
    `);

    expect(result).toMatchObject({ builtinCount: 4, valueBearingCount: 3 });
    expect(result.violations).toEqual([
      'MISSING_CELL declares assessment 0 times (expected exactly 1)',
      'NULL_CELL is poll/value-bearing but its assessment is null or not a value',
    ]);
  });
});

describe('retired-resurrection guard — LIVE verdict over the real tree', () => {
  let stdout = '';
  let exitCode = 0;

  beforeAll(() => {
    try {
      stdout = execFileSync('node', [GUARD, '--list'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 60_000,
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      exitCode = e.status ?? 1;
      stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
  });

  it('actually REACHED the tree (floors on what it counted — an unscanned tree also reports zero)', () => {
    const m = stdout.match(/scanned (\d+) tracked files \((\d+) under _retired\/\)/);
    expect(m, `guard did not report a scan census; output was:\n${stdout}`).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(MIN_TRACKED_SCANNED);
    expect(Number(m![2])).toBeGreaterThan(MIN_RETIRED_SCANNED);
  });

  it('reports NO resurrection on the current tree', () => {
    expect(stdout, stdout).toContain('0 resurrection(s)');
    expect(stdout, stdout).toMatch(/\[cell-retirement\].*0 removed identifier hit\(s\)/);
    expect(stdout, stdout).toMatch(/\d+\/\d+ value-bearing built-in\(s\); 0 assessment census violation\(s\)/);
    expect(stdout, stdout).toContain('[cell-retirement] clean.');
    expect(exitCode).toBe(0);
  });
});
