/**
 * Guard for WI-7187 — a bare `vi.mock('<mod>', () => ({ ... }))` factory enumerates only the
 * exports its subject imports TODAY, so adding any export to a heavily-mocked module silently
 * strands every such factory. Vitest 4 validates the mock against the importer's named-import
 * surface at LINK time, so the failure surfaces at the fleet green-checkpoint hours later,
 * in files the author never touched. Third occurrence of this class here (WI-7185, and an
 * earlier `resolveSpawnBackendModel` round).
 *
 * The fix is structural, not a patch: spread the real module via importOriginal and override
 * only what the test controls. That form is immune to new exports BY CONSTRUCTION, and 6
 * factories in this tree already used it before WI-7187 converted the other 27.
 *
 * This file is also the GATING mechanism for `npm run lint:full-replacement-mocks`: the checker
 * is a root script, and root scripts route to @papercusp/operator-core for affected-test
 * selection (EI-19346163916263067), so running it here is what puts it in front of the gate.
 *
 * Two layers on purpose:
 *   1. the pure analyzer against SYNTHETIC fixtures — proves the guard has TEETH. A guard whose
 *      only evidence is "0 violations on a tree with 0 violations" proves nothing; it would pass
 *      just as happily with its condition inverted.
 *   2. the live tree — the actual invariant we are protecting.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeMockCalls,
  checkFile,
  collectCandidateFiles,
  resolveSpec,
  PROTECTED_MODULES,
} from '../../../scripts/check-full-replacement-mocks.mjs';

const ROOT = join(import.meta.dirname, '../../..');
const PROTECTED = [{ module: 'packages/operator-core/lib/adv-sessions', why: 'fixture' }];
const AT = 'packages/operator-core/lib/agent-tools/fleet/x.test.ts';

const violationsIn = (text: string, path = AT) =>
  checkFile({ path, text, protectedModules: PROTECTED });

describe('full-replacement mock guard: the analyzer has teeth (WI-7187)', () => {
  it('FIRES on the exact shape that red-pinned the fleet gate', () => {
    const v = violationsIn(
      `vi.mock('../../adv-sessions', () => ({ recordedLiveOwnerIds: vi.fn(async () => new Set()) }));`,
    );
    expect(v).toHaveLength(1);
    expect(v[0].module).toBe('packages/operator-core/lib/adv-sessions');
  });

  it('FIRES through a multi-line body containing braces, strings and comments', () => {
    expect(
      violationsIn(
        [
          `vi.mock('../../adv-sessions', () => ({`,
          `  // a comment with a stray ) paren and 'quote`,
          `  endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),`,
          `  listRecordedLiveSessions: vi.fn(async () => [{ id: 1 }]),`,
          `}));`,
        ].join('\n'),
      ),
    ).toHaveLength(1);
  });

  it('FIRES on vi.doMock too — that is where the 27th site hid from the census grep', () => {
    expect(violationsIn(`vi.doMock('../../adv-sessions', () => ({ a: vi.fn() }));`)).toHaveLength(1);
  });

  it.each([
    [
      'the import-actual spread (the prescribed fix)',
      `vi.mock('../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../adv-sessions')>()), a: 1 }));`,
    ],
    [
      'an async factory calling vi.importActual itself',
      `vi.mock('../../adv-sessions', async () => ({ ...(await vi.importActual('../../adv-sessions')), a: 1 }));`,
    ],
    ['a bare automock — vitest synthesises the whole surface, so it cannot strand', `vi.mock('../../adv-sessions');`],
  ])('is SILENT for %s', (_label, src) => {
    expect(violationsIn(src)).toHaveLength(0);
  });

  it('is SILENT for the SAME bad shape on an UNPROTECTED module — precision, not zeal', () => {
    // Measured 2026-08-03: 1,007 internal modules have >=1 full-replacement mocker and a
    // blanket rule would flag 2,827 files. A guard that shouted at all of them would be
    // ignored, and would then miss the real one.
    expect(violationsIn(`vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn() }));`)).toHaveLength(0);
  });

  it('is SILENT when the specifier resolves elsewhere despite the same basename', () => {
    expect(violationsIn(`vi.mock('./adv-sessions', () => ({ a: vi.fn() }));`, 'packages/operator-core/lib/pot/y.test.ts')).toHaveLength(0);
  });

  it('classifies each factory form, and resolves relative specifiers only', () => {
    const forms = analyzeMockCalls(
      [
        `vi.mock('./a');`,
        `vi.mock('./b', () => ({ x: 1 }));`,
        `vi.mock('./c', async (orig) => ({ ...(await orig()) }));`,
      ].join('\n'),
    ).map((c: { form: string }) => c.form);
    expect(forms).toEqual(['automock', 'full-replacement', 'import-actual']);
    expect(resolveSpec('a/b/x.test.ts', './y')).toBe('a/b/y');
    expect(resolveSpec('a/b/x.test.ts', '../y.ts')).toBe('a/y');
    // A bare package specifier is not ours to police — it has no repo path.
    expect(resolveSpec('a/b/x.test.ts', 'vitest')).toBeNull();
  });
});

describe('full-replacement mock guard: the live tree', () => {
  const candidates = collectCandidateFiles({
    listFiles: () =>
      execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx', '*.spec.ts', '*.spec.tsx'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
        .split('\n')
        .filter(Boolean),
    read: (f: string) => {
      try {
        return readFileSync(join(ROOT, f), 'utf8');
      } catch {
        return null;
      }
    },
    protectedModules: PROTECTED_MODULES,
  });

  it('has no bare vi.mock factory on any protected module', () => {
    const violations = candidates.flatMap((c: { path: string; text: string }) =>
      checkFile({ path: c.path, text: c.text, protectedModules: PROTECTED_MODULES }),
    );
    expect(violations.map((v: { path: string; line: number }) => `${v.path}:${v.line}`)).toEqual([]);
  });

  it('actually scanned the files it claims to protect — a silent empty scan is not a pass', () => {
    // Without this, deleting the protected entry (or breaking the pre-filter) would leave the
    // test above trivially green while protecting nothing.
    expect(PROTECTED_MODULES.length).toBeGreaterThan(0);
    expect(candidates.length).toBeGreaterThan(10);
    const advMockers = candidates.filter((c: { path: string; text: string }) =>
      analyzeMockCalls(c.text).some(
        (call: { spec: string }) =>
          resolveSpec(c.path, call.spec) === 'packages/operator-core/lib/adv-sessions',
      ),
    );
    expect(advMockers.length).toBeGreaterThanOrEqual(30);
  });
});
