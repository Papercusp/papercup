/**
 * The enforcing suite for `scripts/check-unreachable-tier-mock.mjs` (WI-38314).
 *
 * THE CLASS the guard detects: a source predicate that has collapsed to a
 * CONSTANT (`export async function mugKettleSystemEnabled() { return false; }`,
 * after P-068/D-098 deleted the flag it read) while a test supplies that same
 * export as the OPPOSITE constant. Those cases assert a state production cannot
 * reach, they pass, and they read as ordinary live coverage — so the defect's
 * only symptom is a green suite.
 *
 * ⚠ THE SCOPE IS THE FILE-WIDE DEFAULT, NOT THE IMPOSSIBLE VALUE. Driving the
 * impossible branch is legitimate and often necessary (an absence assertion is
 * worth nothing unless the thing asserted absent is known to work when
 * permitted); INHERITING it silently is the defect. The calibration cases below
 * pin that distinction, because a guard that flagged the LOCAL re-open would be
 * flagging the prescribed fix.
 *
 * Falsifiability is carried by the CONTROL cases: each drives the real analyzer
 * against a permanently-wrong fixture and asserts it FIRES. No tree mutation, so
 * no git-sync sweep can commit a mutant (CLAUDE.md § "Proving a guard is
 * falsifiable", tier 1).
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs guard script, no type declarations
import { checkFile, constantOf, findConstantPredicates } from '../../../scripts/check-unreachable-tier-mock.mjs';
import { runGuardScript } from './testing-guard-script';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** A fixture module exporting one hard-`false` predicate, as `pot/started` does. */
const PREDICATES = new Map([['pkg/lib/started', [{ name: 'tierEnabled', value: 'false' }]]]);

const violationsIn = (text: string, path = 'pkg/lib/x.test.ts'): unknown[] =>
  checkFile({ path, text, predicates: PREDICATES, allow: new Map() });

describe('constant-predicate detection', () => {
  it('finds a predicate whose whole body is `return false`', () => {
    const found = findConstantPredicates(`export async function p(): Promise<boolean> { return false; }`, 'p.ts');
    expect(found).toEqual([{ name: 'p', value: 'false', line: 1 }]);
  });

  it('does NOT call a predicate with real logic constant — the false-positive that would matter', () => {
    expect(findConstantPredicates(`export async function p() { return await getFlag('x'); }`, 'p.ts')).toEqual([]);
  });

  it('reads the REAL mugKettleSystemEnabled as a hard false — the live subject, not a fixture', () => {
    const started = execFileSync('git', ['show', 'HEAD:packages/operator-core/lib/pot/started.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(findConstantPredicates(started, 'started.ts')).toContainEqual(
      expect.objectContaining({ name: 'mugKettleSystemEnabled', value: 'false' }),
    );
  });
});

describe('value classification', () => {
  it.each([
    ['async () => true', 'true'],
    ['() => false', 'false'],
    ['vi.fn(async () => true)', 'true'],
    ['vi.fn().mockResolvedValue(true)', 'true'],
    ['vi.fn().mockReturnValue(false)', 'false'],
  ])('reads %s as the constant %s', (expr, expected) => {
    expect(constantOf(expr)).toBe(expected);
  });

  it.each([['vi.fn()'], ['async () => KNOB.on'], ['async () => someState']])(
    'reads %s as NOT a constant — a mutable knob is a different class',
    (expr) => {
      expect(constantOf(expr)).toBeNull();
    },
  );
});

describe('CONTROLS — the guard fires on a default that contradicts production', () => {
  it('a factory default of the impossible constant', () => {
    expect(violationsIn(`vi.mock('./started', () => ({ tierEnabled: async () => true }));`)).toHaveLength(1);
  });

  it('the vi.fn DELEGATE shape — one identifier hop, which is how the real offender was written', () => {
    // pot/watchdog.test.ts declared exactly this: the polarity lives on a
    // module-scope binding, not in the factory, so a factory-only reader misses it.
    const text = [
      `const tierEnabled = vi.fn(async () => true);`,
      `vi.mock('./started', () => ({ tierEnabled: (...a) => tierEnabled(...a) }));`,
    ].join('\n');
    expect(violationsIn(text)).toHaveLength(1);
  });

  it('a default declared through mockResolvedValue', () => {
    expect(violationsIn(`vi.mock('./started', () => ({ tierEnabled: vi.fn().mockResolvedValue(true) }));`)).toHaveLength(
      1,
    );
  });

  it('the SHORTHAND factory property over a hoisted binding — the shape the real subject uses', () => {
    // `({ tierEnabled })` carries no `tierEnabled:` to read, so a key-value-only
    // reader sees nothing and the file reads as clean. Measured 2026-09-09 by
    // mutation: flipping pot/wake-coherence.test.ts's file-wide default to the
    // impossible constant left this guard GREEN — it was blind to its own
    // headline case until the shorthand hop landed.
    const text = [
      `const { tierEnabled } = vi.hoisted(() => ({ tierEnabled: vi.fn().mockResolvedValue(true) }));`,
      `vi.mock('./started', () => ({ tierEnabled }));`,
    ].join('\n');
    expect(violationsIn(text)).toHaveLength(1);
  });

  it('reports which value was mocked and which one production can actually produce', () => {
    const [v] = violationsIn(`vi.mock('./started', () => ({ tierEnabled: async () => true }));`) as Array<{
      declared: string;
      actual: string;
      name: string;
    }>;
    expect(v).toMatchObject({ name: 'tierEnabled', declared: 'true', actual: 'false' });
  });
});

describe('CALIBRATIONS — the shapes it must stay silent on', () => {
  it('a default that AGREES with production', () => {
    expect(violationsIn(`vi.mock('./started', () => ({ tierEnabled: async () => false }));`)).toHaveLength(0);
  });

  it('the SHORTHAND shape whose hoisted default AGREES — widening must not flag the correct form', () => {
    const text = [
      `const { tierEnabled } = vi.hoisted(() => ({ tierEnabled: vi.fn().mockResolvedValue(false) }));`,
      `vi.mock('./started', () => ({ tierEnabled }));`,
    ].join('\n');
    expect(violationsIn(text)).toHaveLength(0);
  });

  it('a LOCAL re-open in a beforeEach — the PRESCRIBED fix, so flagging it would flag the cure', () => {
    const text = [
      `vi.mock('./started', () => ({ tierEnabled: vi.fn().mockResolvedValue(false) }));`,
      `describe('x', () => { beforeEach(() => { tierEnabled.mockResolvedValue(true); }); });`,
    ].join('\n');
    expect(violationsIn(text)).toHaveLength(0);
  });

  it('a MUTABLE knob — that is check-vacuous-flag-guard.mjs territory, not this class', () => {
    expect(violationsIn(`vi.mock('./started', () => ({ tierEnabled: async () => KNOB.on }));`)).toHaveLength(0);
  });

  it('a same-NAMED export on a DIFFERENT module — name-matching alone would false-fire here', () => {
    expect(violationsIn(`vi.mock('./elsewhere', () => ({ tierEnabled: async () => true }));`)).toHaveLength(0);
  });

  it('an automock with no factory — vitest synthesises the surface, so no polarity is declared', () => {
    expect(violationsIn(`vi.mock('./started');`)).toHaveLength(0);
  });

  it.each([
    ['a COMMENT', `// vi.mock('./started', () => ({ tierEnabled: async () => true }));`],
    ['a STRING fixture', 'const bad = `' + `vi.mock('./started', () => ({ tierEnabled: async () => true }));` + '`;'],
  ])('the violating shape inside %s is not an offender', (_label, text) => {
    expect(violationsIn(text)).toHaveLength(0);
  });
});

describe('the guard over the REAL tree', () => {
  it('passes, and every allowlist entry BINDS — a suppression that suppresses nothing is the same defect', () => {
    // The guard exits 1 both on a real violation AND on a stale allowlist entry,
    // so the status assertion covers both. It is the whole-tree run, not a fixture:
    // the fixtures above prove the analyzer fires, this proves the tree is clean.
    //
    // Not execFileSync: on a non-zero exit its Error renders only "Command failed: <cmd>",
    // leaving the guard's printout of WHICH mock offends as an unrendered `.stdout`
    // property — so the red names the command, not the violation
    // (EI-20692923474318761, measured on a sibling ratchet guard).
    const guard = runGuardScript('node', ['scripts/check-unreachable-tier-mock.mjs'], {
      cwd: REPO_ROOT,
      maxBuffer: 16 * 1024 * 1024,
    });
    const out = guard.stdout;
    expect(guard.status, guard.output).toBe(0);
    expect(out).toContain('no impossible mock defaults');
    expect(out).toMatch(/(\d+)\/\1 allowlist entries binding/);
  });
});
