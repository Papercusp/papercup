/**
 * boot-check-timeout-coherence — the guard for EI-22025223570144566.
 *
 * WHAT WENT WRONG, so the next reader knows what this is defending:
 * `templates/*​/checks/boot-e2e.test.ts` spawns a REAL production build inside
 * the test. Its budgets were two independent hardcoded literals — a 600s
 * `spawnSync` timeout for `buildCommand`, nested inside a 780s vitest test
 * timeout that ALSO had to cover boot + ready + shutdown. Measured builds on
 * this box spend 8–10min in the compile phase alone (462–582s), before the
 * TypeScript pass even starts, so both numbers sat inside the real
 * build-time distribution and the check went red as a function of machine load
 * rather than of code correctness.
 *
 * Two hardcoded budgets in a nesting relationship is the actual defect: raising
 * only the inner one moves the failure to the outer one, and nothing keeps the
 * pair coherent. So the fix DERIVES the vitest timeout from the named per-leg
 * budgets (`buildTimeoutMs` + `readyTimeoutMs` + `shutdownGraceMs` + slack), and
 * this guard pins that derivation: a boot check may not express either budget as
 * a bare numeric literal again.
 *
 * These checks are PORTABLE content, deliberately not owned by any vitest config
 * in this repo (`testing:run` answers TEST_FILE_ROUTE_ERROR for them), so nothing
 * would otherwise notice the regression — the same blind spot
 * template-bundle-integrity.test.ts exists to cover. This file runs in
 * operator-core, which IS test-discovered, and makes assertions ABOUT the
 * templates tree.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/** Repo root: walk up from this file until the root package.json (the one with `workspaces`). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces)) return dir;
      } catch {
        /* keep walking */
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('boot-check-timeout-coherence: could not locate the monorepo root');
}

const ROOT = repoRoot();
const TEMPLATES_DIR = join(ROOT, 'templates');
const BOOT_CHECK = 'boot-e2e.test.ts';

/**
 * The vitest per-test option object, e.g. `{ timeout: 780_000 }`. A bare number
 * here is the OUTER budget, hand-maintained beside the inner one.
 */
const LITERAL_TEST_TIMEOUT = /\{\s*timeout:\s*[\d_]+\s*\}/;

/**
 * A `timeout:` passed to spawn/spawnSync options with a bare number — the INNER
 * budget. Matched on the option rather than the call so a reformatted call still
 * trips it.
 */
const LITERAL_SPAWN_TIMEOUT = /encoding:\s*"utf8",\s*timeout:\s*[\d_]+/;

/** Every `templates/<ref>/checks/boot-e2e.test.ts` present in a templates tree. */
export function listBootChecks(templatesDir: string): string[] {
  if (!existsSync(templatesDir)) return [];
  return readdirSync(templatesDir)
    .filter((e) => statSync(join(templatesDir, e)).isDirectory())
    .map((ref) => join(templatesDir, ref, 'checks', BOOT_CHECK))
    .filter((p) => existsSync(p))
    .sort();
}

/**
 * Boot checks whose build/test budgets are hardcoded numeric literals rather
 * than derived from the named per-leg budgets. Returns one human-readable
 * violation per offending file, `[]` when the tree is clean.
 */
export function findHardcodedBootTimeouts(templatesDir: string): string[] {
  const violations: string[] = [];
  for (const file of listBootChecks(templatesDir)) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(templatesDir, file);
    if (LITERAL_TEST_TIMEOUT.test(src)) {
      violations.push(
        `${rel}: the vitest test timeout is a bare literal — derive it from the per-leg budgets ` +
          `(spawnTestTimeoutMs) so it cannot drift below the build budget it must contain.`,
      );
    }
    if (LITERAL_SPAWN_TIMEOUT.test(src)) {
      violations.push(
        `${rel}: the buildCommand spawn timeout is a bare literal — read it from ` +
          `boot.buildTimeoutMs so a slow-building app can raise it via config.`,
      );
    }
  }
  return violations;
}

describe('boot-check-timeout-coherence', () => {
  it('every boot-e2e check derives its budgets instead of hardcoding them', () => {
    expect(existsSync(TEMPLATES_DIR), `no templates dir at ${TEMPLATES_DIR}`).toBe(true);
    // Guard the guard: an empty population would pass vacuously, and this check
    // is precisely the kind that gets silently unhooked by a tree move.
    expect(listBootChecks(TEMPLATES_DIR).length).toBeGreaterThan(0);
    expect(findHardcodedBootTimeouts(TEMPLATES_DIR)).toEqual([]);
  });

  it('the shipped boot checks read buildTimeoutMs from config and derive the test timeout', () => {
    const checks = listBootChecks(TEMPLATES_DIR);
    expect(checks.length).toBeGreaterThan(0);
    for (const file of checks) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(TEMPLATES_DIR, file);
      expect(src, `${rel}: buildTimeoutMs must be a config-overridable budget`).toContain(
        'section?.buildTimeoutMs ?? 1_800_000',
      );
      expect(src, `${rel}: the test timeout must be the derived value`).toContain('{ timeout: spawnTestTimeoutMs }');
      // A timeout kill arrives as `status: null`, identical in shape to a
      // compile error. The check must diagnose them apart, or a budget failure
      // gets triaged as a code failure — the expensive half of the original bug.
      expect(src, `${rel}: a timeout must be reported as a timeout, not "buildCommand failed"`).toContain('TIMED OUT');
      expect(src, `${rel}: the timeout branch must assert on the signal`).toContain('built.signal');
    }
  });

  // ── falsifiability control ────────────────────────────────────────────────
  // Tier 2 (the repo's mutation-probe table): the subject is a FILE ARTIFACT
  // read by path, so the probe mutates a COPY OUTSIDE the tree and points the
  // function at it. Never mutate the shared checkout to prove a guard bites —
  // git-sync sweeps it on a schedule and would commit the mutant.
  describe('falsifiability (fixture tree, never the real one)', () => {
    const fixtures: string[] = [];
    const makeTree = (bootSource: string): string => {
      const root = mkdtempSync(join(tmpdir(), 'boot-timeout-guard-'));
      fixtures.push(root);
      const checks = join(root, 'papercusp-fixture-app', 'checks');
      mkdirSync(checks, { recursive: true });
      writeFileSync(join(checks, BOOT_CHECK), bootSource, 'utf8');
      return root;
    };

    afterAll(() => {
      for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
    });

    const CLEAN = [
      'const buildTimeoutMs = section?.buildTimeoutMs ?? 1_800_000;',
      'const spawnTestTimeoutMs = buildTimeoutMs + readyTimeoutMs;',
      'it("spawn", { timeout: spawnTestTimeoutMs }, async () => {',
      '  const built = spawnSync(b!, bArgs, { cwd: appRoot!, encoding: "utf8", timeout: buildTimeoutMs });',
      '});',
    ].join('\n');

    it('passes a tree that derives its budgets (calibration — the control must agree on the good case)', () => {
      expect(findHardcodedBootTimeouts(makeTree(CLEAN))).toEqual([]);
    });

    it('catches the pre-fix outer budget (a hardcoded vitest timeout)', () => {
      const violations = findHardcodedBootTimeouts(makeTree(CLEAN.replace('{ timeout: spawnTestTimeoutMs }', '{ timeout: 780_000 }')));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('vitest test timeout is a bare literal');
    });

    it('catches the pre-fix inner budget (a hardcoded spawnSync timeout)', () => {
      const violations = findHardcodedBootTimeouts(makeTree(CLEAN.replace('timeout: buildTimeoutMs }', 'timeout: 600_000 }')));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('buildCommand spawn timeout is a bare literal');
    });

    it('catches the exact pre-fix file (both budgets hardcoded at once)', () => {
      const preFix = CLEAN.replace('{ timeout: spawnTestTimeoutMs }', '{ timeout: 780_000 }').replace(
        'timeout: buildTimeoutMs }',
        'timeout: 600_000 }',
      );
      expect(findHardcodedBootTimeouts(makeTree(preFix))).toHaveLength(2);
    });

    it('reports nothing for a templates dir that does not exist', () => {
      expect(findHardcodedBootTimeouts(join(tmpdir(), 'boot-timeout-guard-absent'))).toEqual([]);
    });
  });
});
