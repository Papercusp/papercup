/**
 * green-checkpoint: EVERY post-suite leg that can FAIL must red the verdict.
 *
 * `runGreen` computes `green = r.code === 0 && legs.ok` (green-checkpoint.ts), so
 * `legs.ok` IS the gate verdict for everything the suite itself does not cover.
 * `legs.ok` was a HAND-MAINTAINED list of leg fields — and a leg added to
 * `PostSuiteLegs` + `legsNotRun` + its own exec block, but forgotten in that list,
 * is silently excluded from the verdict.
 *
 * Measured 2026-08-09 (P-026): `lintMockCastEscape` was exactly that. It ran at
 * green-checkpoint.ts:5111, set `status:'failed'` and `haltedBy` on a red — which
 * SKIPS every later leg (`lintPlane`, `build`) — while being absent from the
 * `legs.ok` aggregation. Net effect of a `lint:mock-cast-escape` red: the plane
 * lints and the SPA build never ran, and the gate reported GREEN anyway. A false
 * green that also silently drops two real legs is the most expensive shape this
 * file has (cf. the WI-6053 incident in runPostSuiteLegs' own doc comment, where
 * five legs defaulted to `true` and an untypechecked candidate reached `main`).
 *
 * ANCHORED TO THE PROPERTY, NOT TO A NAME LIST. This test does not enumerate legs
 * by hand — a hardcoded list would need the same maintenance the bug came from,
 * and would go stale in the identical way. Instead it DISCOVERS the legs by
 * running the real `runPostSuiteLegs` against the real root package.json with a
 * stubbed exec, recording every `npm run <script>` it invokes, then re-runs once
 * per script failing exactly that one and asserts the invariant:
 *
 *     any leg with status 'failed'  ⇒  legs.ok === false
 *
 * A new leg is therefore covered the moment it is wired, with no edit here.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  runPostSuiteLegs,
  isRerunnableGateEntry,
  checkNpmScript,
  ROOT_OWNED_TYPECHECK_SIBLINGS,
  type CheckpointExec,
} from './green-checkpoint';

/** Repo root: apps/operator/lib/release/ -> ../../../.. */
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const ok = { code: 0, stdout: '', stderr: '' };

/** The npm script name of an `npm run <script>` / `npm --workspace X run <script>` argv. */
function npmScriptOf(cmd: string, args: string[]): string | null {
  if (cmd !== 'npm') return null;
  const i = args.indexOf('run');
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

/**
 * Run the real leg chain with a stub exec. `failScript` (when given) is the ONE npm
 * script that exits non-zero; everything else — including the non-npm `git grep`
 * conflict-marker probe — succeeds.
 */
async function runLegs(failScript: string | null) {
  const invokedScripts: string[] = [];
  const exec: CheckpointExec = async (cmd, args) => {
    const script = npmScriptOf(cmd, args);
    if (script) invokedScripts.push(script);
    // `git grep` for conflict markers: exit 1 == "clean" (no match), which is what we want.
    if (cmd === 'git') return { code: 1, stdout: '', stderr: '' };
    if (script && script === failScript) {
      return { code: 1, stdout: `stub: ${script} failed`, stderr: '' };
    }
    return ok;
  };
  // `exec` is stubbed, so the env is never used to spawn anything — pass the real one
  // rather than a cast so the call keeps the production signature exactly.
  const legs = await runPostSuiteLegs(ROOT, process.env, exec, '@papercusp/operator-vite');
  return { legs, invokedScripts };
}

/** Every leg field on the result that carries a `status` (i.e. is a LegOutcome). */
function legEntries(legs: Awaited<ReturnType<typeof runLegs>>['legs']) {
  return Object.entries(legs).filter(
    (e): e is [string, { status: string; skipReason?: string }] =>
      typeof e[1] === 'object' && e[1] !== null && 'status' in (e[1] as object),
  );
}

describe('green-checkpoint post-suite legs — verdict coverage', () => {
  it('runs a discoverable set of npm-script legs on the happy path', async () => {
    const { legs, invokedScripts } = await runLegs(null);
    // Sanity: the chain really ran (a zero-leg run would make every assertion below vacuous
    // — the same "green because nothing was measured" failure this file guards against).
    expect(invokedScripts.length).toBeGreaterThan(5);
    expect(legs.ok).toBe(true);
    expect(legEntries(legs).some(([, l]) => l.status === 'failed')).toBe(false);
  });

  it('reds the verdict for EVERY leg script that can fail (no leg excluded from legs.ok)', async () => {
    const { legs: happy, invokedScripts } = await runLegs(null);
    const scripts = [...new Set(invokedScripts)];

    /** Legs that actually RAN on this tree — the population that must be provably red-able.
     *  A leg whose script is absent from the candidate is legitimately 'skipped' forever and
     *  is not something this test can (or should) exercise. */
    const ranLegs = legEntries(happy)
      .filter(([, l]) => l.status === 'passed')
      .map(([name]) => name);
    /** Legs observed going 'failed' at least once during the sweep below. */
    const provenRedable = new Set<string>();

    const escaped: { script: string; failedLegs: string[]; skippedAfter: string[] }[] = [];
    for (const script of scripts) {
      const { legs } = await runLegs(script);
      const failed = legEntries(legs)
        .filter(([, l]) => l.status === 'failed')
        .map(([name]) => name);
      for (const name of failed) provenRedable.add(name);
      if (failed.length > 0 && legs.ok !== false) {
        escaped.push({
          script,
          failedLegs: failed,
          // What a `haltedBy` short-circuit silently dropped on the way past the verdict.
          skippedAfter: legEntries(legs)
            .filter(([, l]) => l.status === 'skipped' && l.skipReason?.includes(script))
            .map(([name]) => name),
        });
      }
    }

    expect(
      escaped,
      `These npm scripts FAILED a post-suite leg but left legs.ok true — the gate would report ` +
        `GREEN on their red (and skip every later leg). Add the leg field to the legs.ok ` +
        `aggregation in runPostSuiteLegs:\n${JSON.stringify(escaped, null, 2)}`,
    ).toEqual([]);

    // ANTI-VACUITY. The sweep above only proves what it actually exercised: if a leg never
    // went 'failed' in any iteration, the assertion passed WITHOUT saying anything about it,
    // and a leg missing from legs.ok would sail straight through. Require that every leg
    // which RAN was observed reddening — so the guard's coverage is measured, not assumed.
    expect(
      ranLegs.filter((name) => !provenRedable.has(name)),
      `These legs RAN but were never observed failing, so the assertion above proves NOTHING ` +
        `about them — the sweep could not reach them by failing a single npm script (a leg ` +
        `keyed off a non-npm command, or one sharing a script name). Extend runLegs() so each ` +
        `is exercised; do not delete this check.`,
    ).toEqual([]);
  });

  // P-026 item (b). Named deliberately, unlike the property-anchored sweeps above: that this
  // PARTICULAR guard gates promotion is the deliverable, not an incidental instance. Its only
  // blocking path used to be .github/workflows/test.yml (push/PR to `main` + this gate's own
  // POST-fast-forward dispatch), both downstream of promotion — so an unclassified timer was
  // invisible for its whole life on staging and only red once already promoted.
  it('gates lint:timer-classification BEFORE promotion, and its red holds the gate', async () => {
    const { legs: happy, invokedScripts } = await runLegs(null);
    expect(invokedScripts).toContain('lint:timer-classification');
    expect(happy.lintTimerClassification.status).toBe('passed');

    const { legs } = await runLegs('lint:timer-classification');
    expect(legs.lintTimerClassification.status).toBe('failed');
    expect(legs.ok).toBe(false);
    expect(legs.failingSignatures).toContain('lint:timer-classification');
  });

  // EI-19962933556828227: the sibling gap to the one above — `lint:no-raw-setinterval` had
  // the SAME only-blocking-path-is-inert-CI shape (.github/workflows/test.yml push/PR to
  // `main`), so an offender committed to `staging` was invisible for its whole life there
  // and only reddened AFTER promotion. Named deliberately for the same reason as the
  // timer-classification test above: that THIS guard gates promotion is the deliverable.
  it('gates lint:no-raw-setinterval BEFORE promotion, and its red holds the gate', async () => {
    const { legs: happy, invokedScripts } = await runLegs(null);
    expect(invokedScripts).toContain('lint:no-raw-setinterval');
    expect(happy.lintNoRawSetinterval.status).toBe('passed');

    const { legs } = await runLegs('lint:no-raw-setinterval');
    expect(legs.lintNoRawSetinterval.status).toBe('failed');
    expect(legs.ok).toBe(false);
    expect(legs.failingSignatures).toContain('lint:no-raw-setinterval');
  });

  /* ── the tip rescue must be able to re-run every signature this file can emit ──────────
   *
   * EI-19992136440423793. Reddening the gate (the sweeps above) and being able to MEASURE
   * whether that red is stale are two different properties, and only the first was guarded.
   * `nonTestGateIdsFrom` admits a failing entry only if it is a NON_TEST_GATE_SCRIPTS key or a
   * self-describing `<ws> :: lint:<name>` task id — and it is ALL-OR-NOTHING (`ids.every`), so
   * ONE unadmitted signature vetoes the tip re-run for every admissible sibling beside it.
   *
   * A ROOT-level lint leg is admissible only by hand-registration, so adding one is a silent
   * two-step: wire the leg (guarded above) and remember to register it (guarded by NOTHING
   * until now). Measured cost of the gap on 2026-08-12: `lint:no-raw-setinterval` was wired but
   * unregistered, so a red on ['lint:mock-cast-escape','lint:no-raw-setinterval'] — whose
   * offending bare setInterval() was ALREADY removed at tip — could not be re-verified, and the
   * gate reached 19 consecutive reds with `main` frozen behind it.
   *
   * Property-anchored like its siblings: the signatures are DISCOVERED by failing each script in
   * turn, so a new leg is covered the moment it is wired, with no edit here. */
  const RESCUE_EXCLUDED = new Set([
    // Not a gate id and not re-runnable by construction: the CANDIDATE's package.json could not
    // be read, so there is no script to re-run. Re-running anything at tip would answer a
    // different question than the one the red asked.
    'package.json-unreadable',
  ]);

  it('every failing-signature a leg can emit is re-runnable by the tip rescue', async () => {
    const { invokedScripts } = await runLegs(null);
    const scripts = [...new Set(invokedScripts)];

    const signatures = new Set<string>();
    for (const script of scripts) {
      const { legs } = await runLegs(script);
      for (const sig of legs.failingSignatures ?? []) signatures.add(sig);
    }

    // ANTI-VACUITY, twice over. An empty/tiny signature set would make the assertion below pass
    // while proving nothing (the same "green because nothing was measured" shape this file
    // exists to catch), and a predicate that returned true for everything would too.
    expect(signatures.size).toBeGreaterThan(5);
    expect(isRerunnableGateEntry('lint:deliberately-not-registered-anywhere')).toBe(false);

    const unrescuable = [...signatures].filter(
      (sig) => !isRerunnableGateEntry(sig) && !RESCUE_EXCLUDED.has(sig),
    );

    expect(
      unrescuable,
      `These leg failing-signatures cannot be re-run at tip, so a red naming ANY of them is ` +
        `unmeasurable for staleness — and because nonTestGateIdsFrom() is all-or-nothing, each ` +
        `one also VETOES the rescue for every admissible signature failing beside it:\n` +
        `${JSON.stringify(unrescuable, null, 2)}\n\n` +
        `Fix by registering each in NON_TEST_GATE_SCRIPTS (green-checkpoint.ts). A root lint ` +
        `script qualifies on that registry's own bar: one fast, deterministic, repo-wide script ` +
        `with no PG or network dependency. If a signature genuinely cannot be re-verified that ` +
        `way, add it to RESCUE_EXCLUDED above WITH the reason it is not re-runnable — never ` +
        `delete this check, which is the only thing standing between a new lint leg and another ` +
        `un-rescuable red streak.`,
    ).toEqual([]);
  });
});

/**
 * WI-37485: a MISSING `lint:tsc` must not silently disable the gate's only operator-core
 * typecheck.
 *
 * `checkNpmScript(treeDir,'lint:tsc') === 'absent'` is the ONE branch that skips this leg
 * while setting no `haltedBy`, pushing no failing signature, and — since runPostSuiteLegs
 * persists a non-test leg's output only on failure — writing nothing to the log. WI-37485
 * observed a candidate whose later legs ran (proving the operator-core leg had not halted
 * the chain) while that candidate provably contained a TS2741, and could not settle whether
 * this branch had fired, because a tree taking it leaves no artifact behind.
 *
 * `absent` must STAY silent for a real subject hive, so the tests below pin BOTH directions:
 * the root-shaped tree fails loudly, the hive-shaped tree still skips quietly. Every tree
 * here is built in a TEMP DIR (`runPostSuiteLegs` takes `treeDir` as a parameter), so this
 * never mutates the shared checkout — the copy-out tier of CLAUDE.md's falsifiability rule.
 */
describe('green-checkpoint — a missing lint:tsc cannot silently skip the typecheck leg (WI-37485)', () => {
  /** Build a throwaway tree exposing exactly `scripts`, and run the real leg chain on it. */
  async function runLegsInTree(scripts: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'gc-wi37485-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe-tree', scripts }));
      const invokedScripts: string[] = [];
      const exec: CheckpointExec = async (cmd, args) => {
        const script = npmScriptOf(cmd, args);
        if (script) invokedScripts.push(script);
        if (cmd === 'git') return { code: 1, stdout: '', stderr: '' };
        return ok;
      };
      const legs = await runPostSuiteLegs(dir, process.env, exec, '@papercusp/operator-vite');
      return { legs, invokedScripts };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const SIBLINGS = Object.fromEntries(
    ROOT_OWNED_TYPECHECK_SIBLINGS.map((s) => [s, `echo ${s}`]),
  ) as Record<string, string>;

  it('FAILS loudly when a tree exposes the root-owned sibling legs but no lint:tsc', async () => {
    const { legs, invokedScripts } = await runLegsInTree(SIBLINGS);

    expect(
      legs.typecheck?.status,
      'A root-shaped tree missing `lint:tsc` must FAIL the typecheck leg, not skip it — ' +
        'skipping is what let WI-37485 be unfalsifiable.',
    ).toBe('failed');
    expect(
      legs.ok,
      'A failed typecheck leg must red the verdict through legs.ok, or the gate reports GREEN ' +
        'on a candidate whose operator-core typecheck never ran.',
    ).toBe(false);
    // It must not have HALTED the chain: the siblings still have to run and report.
    expect(invokedScripts).toContain(ROOT_OWNED_TYPECHECK_SIBLINGS[0]);
  });

  it('still SKIPS silently for a genuine subject hive that omits the whole typecheck family', async () => {
    // The legitimate case `absent` exists for. Breaking it would red every subject hive.
    const { legs } = await runLegsInTree({ build: 'echo build' });

    expect(legs.typecheck?.status).toBe('skipped');
    expect(
      legs.ok,
      'A subject hive legitimately has no platform typecheck; it must not be failed for that.',
    ).not.toBe(false);
  });

  it('CALIBRATION: the same root-shaped tree WITH lint:tsc does not trip the guard', async () => {
    // Without this, the first test would also pass if the guard failed the leg unconditionally.
    const { legs } = await runLegsInTree({ 'lint:tsc': 'echo tsc', ...SIBLINGS });

    expect(legs.typecheck?.status).toBe('passed');
    expect(legs.ok).not.toBe(false);
  });

  it('CONTROL: the OLD rule provably could not tell these two trees apart', () => {
    // Permanent falsifiability control (CLAUDE.md: for a MODULE you import, keep the
    // deliberately-wrong implementation in the test rather than mutating the shared tree).
    //
    // The pre-WI-37485 code branched on `checkNpmScript(...) === 'absent'` ALONE and skipped
    // silently. This asserts BOTH trees land on that same 'absent' input — so the old rule
    // mapped them to the identical silent skip and could not have failed either — while the
    // tests above show the new discriminator gives them OPPOSITE verdicts. Without this, a
    // future refactor could make the root-shaped tree fail for an unrelated reason (say an
    // 'unreadable' package.json) and the test above would still pass, proving nothing.
    const rootShaped = mkdtempSync(join(tmpdir(), 'gc-wi37485-ctl-root-'));
    const hiveShaped = mkdtempSync(join(tmpdir(), 'gc-wi37485-ctl-hive-'));
    try {
      writeFileSync(join(rootShaped, 'package.json'), JSON.stringify({ scripts: SIBLINGS }));
      writeFileSync(
        join(hiveShaped, 'package.json'),
        JSON.stringify({ scripts: { build: 'echo build' } }),
      );

      // The exact input the old branch saw — identical for both trees.
      expect(checkNpmScript(rootShaped, 'lint:tsc')).toBe('absent');
      expect(checkNpmScript(hiveShaped, 'lint:tsc')).toBe('absent');

      // ...and the only thing that now separates them.
      expect(
        ROOT_OWNED_TYPECHECK_SIBLINGS.some((s) => checkNpmScript(rootShaped, s) === 'present'),
      ).toBe(true);
      expect(
        ROOT_OWNED_TYPECHECK_SIBLINGS.some((s) => checkNpmScript(hiveShaped, s) === 'present'),
      ).toBe(false);
    } finally {
      rmSync(rootShaped, { recursive: true, force: true });
      rmSync(hiveShaped, { recursive: true, force: true });
    }
  });

  it('every ROOT_OWNED_TYPECHECK_SIBLINGS entry is a leg the real chain actually probes', async () => {
    // Anchors the list to the property instead of to a name list, exactly as the legs.ok
    // sweep above does: an entry naming a script no leg checks could never be 'present',
    // silently weakening the discriminator to "never fires" with every test still green.
    const { invokedScripts } = await runLegs(null);
    const probed = new Set(invokedScripts);
    const strays = ROOT_OWNED_TYPECHECK_SIBLINGS.filter((s) => !probed.has(s));

    expect(
      strays,
      `These ROOT_OWNED_TYPECHECK_SIBLINGS entries are not run as legs on the real root tree, ` +
        `so they can never be 'present' and the WI-37485 discriminator silently weakens toward ` +
        `never firing. Remove them, or wire the leg they name:\n${JSON.stringify(strays)}`,
    ).toEqual([]);
  });
});
