/**
 * check-vimock-export-strands.test.ts — WI-37445 / EI-19462958615807409.
 *
 * TWO HALVES, deliberately, mirroring check-lint-guard-reachability.test.ts:
 *
 *   1. PURE LOGIC with permanent CONTROLS. The controls are the point. This detector's
 *      only real risk is over-firing: an implementation that flags every vi.mock, or that
 *      counts `export type`, would satisfy any naive "does it detect the bad case?" test
 *      while being useless in practice. So each SAFE form stays here forever as a case the
 *      real implementation must stay silent on, next to a calibration case proving the
 *      detector still fires — otherwise the controls could go green by the property itself
 *      breaking.
 *
 *   2. A REAL-TREE assertion that EXECUTES the guard over this repository. Without one,
 *      this file would be exactly what `lint:guard-reachability` classifies as a
 *      `logic-test`: proof the detector works, and no enforcement at all — which is how a
 *      guard rots while looking thoroughly covered.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectRuntimeExports,
  diffAddedRuntimeExports,
  findEnumeratingMockers,
  moduleKeyFor,
  formatNoFindings,
  // @ts-expect-error — untyped .mjs guard script, imported for its pure helpers.
} from '../../../../scripts/check-vimock-export-strands.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/check-vimock-export-strands.mjs');

const TEST_PATH = 'packages/x/lib/__tests__/a.test.ts';
const SUBJECT = 'packages/x/lib/subject';
const mockersFor = (source: string) =>
  findEnumeratingMockers({ modulePath: SUBJECT, testFiles: [TEST_PATH], read: () => source }) as unknown[];

describe('collectRuntimeExports — runtime values only', () => {
  it('collects every runtime-valued export shape', () => {
    const names = collectRuntimeExports(
      [
        'export function fn() {}',
        'export async function afn() {}',
        'export const CONST = 1;',
        'export let mutable = 2;',
        'export class Klass {}',
        'export enum E { a }',
        'export const { destructured } = obj;',
        'export const [tupled] = arr;',
        "export { reExported } from './x';",
        'export default thing;',
      ].join('\n'),
    ) as Set<string>;
    for (const n of ['fn', 'afn', 'CONST', 'mutable', 'Klass', 'E', 'destructured', 'tupled', 'reExported', 'default']) {
      expect(names.has(n), n).toBe(true);
    }
  });

  it('CONTROL — excludes type-only exports, which can never be missing from a mock', () => {
    // Counting these was measured to inflate the candidate population ~14× (43,431 sites)
    // while pointing at nothing actionable: they are erased at runtime, so they belong in
    // no factory. An implementation that counts them passes the test above and is useless.
    const names = collectRuntimeExports(
      [
        'export type Alias = string;',
        'export interface Iface { a: string }',
        "export type { OnlyType } from './x';",
        "export { type InlineType } from './y';",
      ].join('\n'),
    ) as Set<string>;
    expect([...names]).toEqual([]);
  });

  it('does not treat a non-exported declaration as exported', () => {
    expect([...(collectRuntimeExports('const privateThing = 1;\nfunction hidden() {}') as Set<string>)]).toEqual([]);
  });
});

describe('diffAddedRuntimeExports — only what is NEW', () => {
  it('names an added runtime export', () => {
    expect(diffAddedRuntimeExports('export const a = 1;', 'export const a = 1;\nexport const b = 2;')).toEqual(['b']);
  });

  it('CONTROL — silent when the addition is type-only', () => {
    expect(diffAddedRuntimeExports('export const a = 1;', 'export const a = 1;\nexport type T = string;')).toEqual([]);
  });

  it('CONTROL — silent when nothing changed, so an unrelated edit cannot fire it', () => {
    const same = 'export const a = 1;\nconst internal = 2;';
    expect(diffAddedRuntimeExports(same, `${same}\n// a comment only`)).toEqual([]);
  });
});

describe('findEnumeratingMockers — the selection gap, precisely', () => {
  it('CALIBRATION — fires on a bare enumerating factory targeting the changed module', () => {
    // Pins that the detector still works, so the controls below cannot pass by the
    // property being broken rather than by the forms being genuinely safe.
    expect(mockersFor("vi.mock('../subject', () => ({ old: 1 }));")).toHaveLength(1);
  });

  it('CONTROL — silent for the import-actual spread (the prescribed fix)', () => {
    expect(mockersFor("vi.mock('../subject', async (io) => ({ ...(await io()), old: 1 }));")).toHaveLength(0);
  });

  it('CONTROL — silent for an automock, where vitest synthesises the whole surface', () => {
    expect(mockersFor("vi.mock('../subject');")).toHaveLength(0);
  });

  it('CONTROL — silent for the same bad shape on a DIFFERENT module (precision, not zeal)', () => {
    expect(mockersFor("vi.mock('../other-subject', () => ({ old: 1 }));")).toHaveLength(0);
  });

  it('reports the mocking file with the line and the specifier, so it is actionable', () => {
    const [hit] = mockersFor("\nvi.mock('../subject', () => ({ old: 1 }));") as {
      path: string;
      line: number;
      spec: string;
    }[];
    expect(hit).toMatchObject({ path: TEST_PATH, line: 2, spec: '../subject' });
  });
});

describe('moduleKeyFor / formatNoFindings', () => {
  it('makes a changed source path comparable to a resolved mock specifier', () => {
    expect(moduleKeyFor('packages/x/lib/subject.ts')).toBe('packages/x/lib/subject');
    expect(moduleKeyFor('packages/x/lib/subject.tsx')).toBe('packages/x/lib/subject');
  });

  it('CONTROL — ZERO examined files is NOT reported as a clean bill', () => {
    // The measured false-green class on this tree: git-sync commits the working tree on a
    // schedule, so minutes after an edit the default `--base HEAD` diff is EMPTY. Rendering
    // that identically to a real pass is how `tsc -p .` came to read as green.
    expect(formatNoFindings([], 'HEAD')).toMatch(/NOT CHECKED/);
  });

  it('reports a genuine pass when files were actually compared', () => {
    expect(formatNoFindings(['a.ts'], 'HEAD')).toMatch(/^✓/);
  });
});

describe('REAL TREE — the guard executes over this repository', () => {
  it("the guard's own self-test passes against the real implementation", () => {
    const run = spawnSync('node', [SCRIPT, '--self-test'], { cwd: REPO_ROOT, encoding: 'utf-8' });
    expect(`${run.stdout ?? ''}${run.stderr ?? ''}`).toMatch(/all cases passed/);
    expect(run.status).toBe(0);
  });

  it('scans the real tree and stays ADVISORY (exit 0), so it can never false-block the fleet', () => {
    // Adding an export is normal and usually harmless, so this guard must never gate a
    // commit. It also must not crash on real sources — this run parses whatever the
    // working tree currently differs by.
    const run = spawnSync('node', [SCRIPT, '--json'], { cwd: REPO_ROOT, encoding: 'utf-8' });
    expect(run.status).toBe(0);
    const parsed = JSON.parse(String(run.stdout));
    expect(parsed).toHaveProperty('base');
    expect(Array.isArray(parsed.findings)).toBe(true);
  });
});
