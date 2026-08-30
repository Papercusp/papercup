/**
 * nonasserting-test-guard.test.ts — fails a COMMITTED test file that contains no
 * way to fail (EI-19311827450903709).
 *
 * WHY THIS EXISTS — and why it is specific to this fleet
 * On a normal repo, debugging scratch dies in the working tree because you choose
 * what to `git add`. Here, agents do not commit: git-sync commits the ENTIRE tree
 * on a schedule. So a throwaway file an agent writes mid-debug is automatically
 * committed, pushed, and enrolled in the fleet green-checkpoint — permanently —
 * unless that agent remembers to delete it before the next tick. The discipline
 * required is "remember to clean up before an invisible background process commits
 * for you", and it fails silently, leaving no trace that it failed.
 *
 * The motivating instance was `agent-tools/coordination/zz-tmp-debug.test.ts`
 * (committed 2026-08-02T00:52Z, added in 025d676bd5, since deleted): `describe('debug')`,
 * three `console.log`s, ZERO assertions. A test with no assertion can never fail, so
 * it is pure cost — it runs on every gate execution and spams the gate log forever.
 * Nobody notices, precisely because it passes.
 *
 * ── WHY *THIS* DISCRIMINATOR, AND NOT THE ONE THE WORK ITEM PROPOSED ──────────
 * EI-19311827450903709 proposed three guards and called name-pattern matching
 * (`zz-*`, `*-tmp-*`, `*.scratch.*`) "the most direct fit". Measured against the real
 * tree, that is the WORST of the three: every scratch-NAMED committed test is
 * legitimate — `scratch-gc.test.ts`, `scratch-uri.test.ts`, `scratch-reference.test.ts`
 * and `endpoint-route/__tests__/scratch.test.ts` all test the scratch subsystem
 * itself. A name guard would have been ~100% false positives and zero true positives.
 *
 * Its second proposal — "zero `expect()` calls" — is also wrong as literally stated.
 * Measured: 11 of 7,365 committed test files contain no `expect(`, and ALL ELEVEN are
 * legitimate. They assert through three mechanisms a naive grep cannot see:
 *   • shared-conformance DELEGATION — `describeWatermarkStoreConformance()`,
 *     `describePresenceConformance()`, `describeToolGuidanceBudget()` (6 files);
 *   • ESLint `RuleTester` + `tester.run(...)`, which asserts internally (4 files);
 *   • `expect.fail(...)` — no `expect(` substring at all (perf-anti-patterns.test.ts).
 *
 * So the guard below asks the question those proposals were reaching for: does this
 * file contain ANY mechanism by which it could fail? A file that has no assertion
 * token AND no delegated-suite call cannot fail, whatever it is named. That
 * separates the real scratch (which has neither) from all 11 legitimate files
 * (which each have one) with no baseline and no grandfathering.
 *
 * ── SCOPE: TRACKED FILES ONLY ────────────────────────────────────────────────
 * The harm is "committed and runs in the gate forever", so the population is what
 * `git ls-files` reports. Deliberately NOT the working tree: an agent mid-debug
 * should not have its own suite go red for a file it is about to delete, and a
 * local/gate divergence would train people to ignore this.
 *
 * ESCAPE HATCH: put `// nonasserting-test:allow <reason>` anywhere in the file. A
 * deliberate exception carries its justification at the site — never a silent
 * allowlist here (the same rule check-assert-integrity.mjs applies).
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Resolved from the module location, never a hardcoded box path — an absolute
// /home/... root makes the walk return nothing on any other checkout, and every
// finding then reads as a clean pass (the failure mode perf-anti-patterns.test.ts
// hit in WI-123).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ALLOW_DIRECTIVE = /\/\/\s*nonasserting-test:allow\b/;

/** Paths excluded from the scan. `_retired/` is preserved-not-active by design. */
const EXCLUDE_PATH_CONTAINS = ['_retired/', 'node_modules/'];

/**
 * Every mechanism by which a Vitest file can actually fail. A file matching NONE of
 * these cannot fail, and is therefore either debug scratch or a broken test — both
 * worth failing. Each entry below is present in at least one real committed file, so
 * this list is measured against the tree, not imagined.
 */
const ASSERTION_MECHANISMS: { id: string; pattern: RegExp }[] = [
  // `expect(...)`, `expect.fail(...)`, `expect.soft(...)`, `await expect(...)`.
  { id: 'expect', pattern: /\bexpect\b/ },
  // node:assert / chai — `assert(...)`, `assert.equal(...)`, `strict.ok(...)`.
  { id: 'assert', pattern: /\bassert\b/ },
  // Type-level assertions have no runtime expect.
  { id: 'expectTypeOf', pattern: /\bexpectTypeOf\b/ },
  // ESLint RuleTester asserts internally via `tester.run(...)` — 4 committed files.
  { id: 'RuleTester', pattern: /\bRuleTester\b|\.run\s*\(/ },
  // Shared-conformance DELEGATION: a camelCase suite helper the file calls to
  // contribute its assertions — `describeWatermarkStoreConformance()`,
  // `describeToolGuidanceBudget()`, `runFooConformance()`, `verifyBar()`.
  // NOTE the required capital: plain lowercase `describe(` from vitest must NOT
  // match, or the motivating `describe('debug')` scratch file would be exempted by
  // the very rule meant to catch it.
  {
    id: 'delegated-suite',
    pattern: /\b(?:describe|run|verify|assert|check|expect)[A-Z]\w*\s*\(/,
  },
  // A deliberate placeholder is intentional, not scratch.
  { id: 'todo-placeholder', pattern: /\b(?:it|test|describe)\.todo\b/ },
];

/** True when the source contains at least one mechanism by which it could fail. */
export function hasFailureMechanism(source: string): boolean {
  return ASSERTION_MECHANISMS.some((m) => m.pattern.test(source));
}

/** Tracked test files, via git — the population that is actually committed. */
function trackedTestFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--', '*.test.ts', '*.test.tsx', '*.test.mts'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((p) => !EXCLUDE_PATH_CONTAINS.some((x) => p.includes(x)));
}

async function scan(): Promise<string[]> {
  const files = trackedTestFiles();
  // A scan that found no files is a broken instrument, not a clean tree — assert
  // the population is real before reporting a pass (check-assert-integrity's rule:
  // every "couldn't measure" must be a fail, never a pass).
  expect(
    files.length,
    'scan found ZERO tracked test files — the instrument is broken, not the tree clean',
  ).toBeGreaterThan(100);

  const offenders: string[] = [];
  await Promise.all(
    files.map(async (rel) => {
      let source: string;
      try {
        source = await fs.readFile(join(REPO_ROOT, rel), 'utf8');
      } catch {
        return; // deleted between ls-files and read — not this guard's business
      }
      if (ALLOW_DIRECTIVE.test(source)) return;
      if (!hasFailureMechanism(source)) offenders.push(rel);
    }),
  );
  return offenders.sort();
}

// ── PERMANENT FALSIFIABILITY CONTROLS ───────────────────────────────────────
// The verbatim body of the motivating scratch file, recovered from 025d676bd5. A
// guard that has never failed is a guard nobody has tested, and this repo forbids
// proving that by mutating the shared tree (git-sync would commit the mutant). So
// the wrong-shape control lives here permanently instead — with a calibration case
// beside it, so the controls cannot both pass while the detector itself is broken.
const SCRATCH_FIXTURE = `
import { describe, it, vi } from 'vitest';
import { premiseProbes } from './premise-probes';

const getWorkItem = vi.fn();
vi.mock('../../work-items', () => ({ getWorkItem: (...a: unknown[]) => getWorkItem(...a) }));

describe('debug', () => {
  it('shows what the probe actually returns', async () => {
    getWorkItem.mockResolvedValue({ state: 'open' });
    const probes = premiseProbes();
    console.log('PROBE RESULT:', JSON.stringify(await probes.workItem!('WI-6560')));
    console.log('getWorkItem calls:', JSON.stringify(getWorkItem.mock.calls));
  });
});
`;

const LEGITIMATE_FIXTURES: { id: string; source: string }[] = [
  {
    id: 'delegated conformance suite (packages/coordination/src/capabilities)',
    source: `import { describeTopicStoreConformance } from './conformance';\ndescribeTopicStoreConformance(() => new InMemoryTopicStore());\n`,
  },
  {
    id: 'ESLint RuleTester (eslint-rules/no-bare-jsonb-cast.test.ts)',
    source: `const { RuleTester } = require('eslint');\nconst tester = new RuleTester({});\nit('cases', () => { tester.run('no-bare-jsonb-cast', rule, { valid: [], invalid: [] }); });\n`,
  },
  {
    id: 'expect.fail only, no expect( (perf-anti-patterns.test.ts)',
    source: `import { describe, it, expect } from 'vitest';\nit('guard', () => { if (hits.length) expect.fail(hits.join('\\n')); });\n`,
  },
  {
    id: 'ordinary assertion',
    source: `import { it, expect } from 'vitest';\nit('works', () => { expect(1 + 1).toBe(2); });\n`,
  },
];

describe('non-asserting committed test guard (EI-19311827450903709)', () => {
  it('flags the real scratch file that motivated this guard', () => {
    expect(hasFailureMechanism(SCRATCH_FIXTURE)).toBe(false);
  });

  it.each(LEGITIMATE_FIXTURES)(
    'does NOT flag a legitimate shape: $id',
    ({ source }) => {
      expect(hasFailureMechanism(source)).toBe(true);
    },
  );

  it('no committed test file lacks a way to fail', async () => {
    const offenders = await scan();
    if (offenders.length > 0) {
      expect.fail(
        [
          '\nCommitted test file(s) with NO mechanism by which they could fail:',
          '',
          ...offenders.map((f) => `  ${f}`),
          '',
          'A test with no assertion can never fail, so it is pure cost: it runs on every',
          'gate execution forever. This usually means debugging scratch was left behind and',
          'git-sync committed it for you (EI-19311827450903709).',
          '',
          'Fix: delete the file if it was scratch, or give it a real assertion.',
          'If it genuinely asserts through a mechanism not listed in ASSERTION_MECHANISMS,',
          'add that mechanism here — do not weaken the rule for one file.',
          'To allow deliberately, put in the file: // nonasserting-test:allow <reason>',
        ].join('\n'),
      );
    }
  }, 60000);
});
