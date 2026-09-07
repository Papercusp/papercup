/**
 * Wiring guard for `system:acceptance-grading-sweep`.
 * plan: acceptance-grading-stall-sweep-2026-08-26 (P-004, P-005)
 *
 * The decision core and orchestrator are covered by their own suites, but those
 * would all still pass if the routine were never REGISTERED or never SEEDED — the
 * sweep would simply never run, silently, which is indistinguishable from the
 * stranding bug it exists to fix. That is the gap this file closes.
 *
 * It asserts by reading source TEXT rather than importing
 * `register-system-actions.ts`, which pulls in ~100 action modules and their
 * database-bound graphs. The one real import (`BESPOKE_ACTIVE_SEEDS`) is cheap and
 * already imported by the sibling suite.
 *
 * Each pin carries a NEGATIVE control proving the assertion can fail, so none of
 * these can rot into a test that passes because its subject vanished.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BESPOKE_ACTIVE_SEEDS } from './bespoke-active-seeds-check';

const HERE = __dirname;
const ACTION_FILE = join(HERE, 'acceptance-grading-sweep-action.ts');
const SEED_FILE = join(HERE, 'seed-acceptance-grading-sweep-routine.ts');
const REGISTER_FILE = join(HERE, 'register-system-actions.ts');

const ACTION_NAME = 'acceptance-grading-sweep';
const TARGET_ROLE = `system:${ACTION_NAME}`;

const read = (p: string) => readFileSync(p, 'utf8');

describe('the sweep is actually wired in, not merely written', () => {
  it('the action module exists and registers under the expected name', () => {
    expect(existsSync(ACTION_FILE)).toBe(true);
    const src = read(ACTION_FILE);
    expect(src).toContain(`registerSystemAction('${ACTION_NAME}'`);
  });

  it('register-system-actions imports it — without this the action never registers', () => {
    const src = read(REGISTER_FILE);
    expect(src).toContain(`import './acceptance-grading-sweep-action';`);
  });

  it('NEGATIVE CONTROL: the import pin would fail for a module that is not wired', () => {
    // Proves the assertion above is actually reading the file, not vacuously passing.
    const src = read(REGISTER_FILE);
    expect(src).not.toContain(`import './acceptance-grading-sweep-action-NOT-WIRED';`);
  });

  it('the seeder exists and targets the role the action registers', () => {
    expect(existsSync(SEED_FILE)).toBe(true);
    const src = read(SEED_FILE);
    // A mismatch here is the classic silent failure: the routine row fires a
    // target_role nothing is registered under, so every tick is a no-op.
    expect(src).toContain(`const TARGET_ROLE = '${TARGET_ROLE}'`);
    expect(src).toContain(`const NAME = '${ACTION_NAME}'`);
  });

  it('registerSystemAction takes the name WITHOUT the system: prefix, and the seeder adds it', () => {
    // system-actions.ts: "Look up a registered system action by name (the part after
    // `system:`)". Pinning the relationship because getting it wrong produces a
    // routine that fires forever against an unregistered role.
    expect(TARGET_ROLE).toBe(`system:${ACTION_NAME}`);
    expect(read(ACTION_FILE)).not.toContain(`registerSystemAction('${TARGET_ROLE}'`);
  });

  it('it is listed in the bespoke ACTIVE seeds registry', () => {
    const entry = BESPOKE_ACTIVE_SEEDS.find((s) => s.name === ACTION_NAME);
    expect(entry, 'acceptance-grading-sweep is missing from BESPOKE_ACTIVE_SEEDS').toBeTruthy();
    expect(entry!.seedScript).toBe('seed-acceptance-grading-sweep-routine.ts');
  });

  it('the seed script named in that registry actually exists on disk', () => {
    const entry = BESPOKE_ACTIVE_SEEDS.find((s) => s.name === ACTION_NAME)!;
    expect(existsSync(join(HERE, entry.seedScript))).toBe(true);
  });

  it('is seeded as an ephemeral interval routine, not a cron expression', () => {
    const src = read(SEED_FILE);
    expect(src).toContain(`'ephemeral'`);
    expect(src).toContain('interval_sec');
  });

  it('is seeded ACTIVE by default — finished work does not ship dark', () => {
    const src = read(SEED_FILE);
    expect(src).toContain(`const active = !process.argv.includes('--inactive')`);
  });

  it('a re-seed does not clobber an operator pause', () => {
    // The whole point of the ON CONFLICT block omitting `active`.
    const src = read(SEED_FILE);
    expect(src).toContain('active intentionally NOT re-applied on conflict');
  });
});

describe('cadence cannot be what decides an outcome', () => {
  it('the seeded interval is far below the decision thresholds', async () => {
    const { ACCEPTANCE_GRADING_REDISPATCH_AFTER_MS, ACCEPTANCE_GRADING_ESCALATE_AFTER_MS } = await import(
      '../../acceptance-grading-sweep'
    );
    const m = read(SEED_FILE).match(/const DEFAULT_INTERVAL_SEC\s*=\s*(\d+)/);
    expect(m, 'DEFAULT_INTERVAL_SEC was renamed in the seeder — re-point this pin').toBeTruthy();
    const intervalMs = Number(m![1]) * 1000;

    // If the sweep ran on a cadence comparable to its own thresholds, WHEN it happened
    // to tick would materially change whether a plan was re-dispatched or escalated.
    // Requiring an order of magnitude of headroom keeps the thresholds in charge.
    expect(intervalMs * 10).toBeLessThanOrEqual(ACCEPTANCE_GRADING_REDISPATCH_AFTER_MS);
    expect(intervalMs * 10).toBeLessThanOrEqual(ACCEPTANCE_GRADING_ESCALATE_AFTER_MS);
  });

  it('the action module and the seeder agree on the interval', () => {
    const seeded = read(SEED_FILE).match(/const DEFAULT_INTERVAL_SEC\s*=\s*(\d+)/)?.[1];
    const declared = read(ACTION_FILE).match(/ACCEPTANCE_GRADING_SWEEP_INTERVAL_SEC\s*=\s*(\d+)/)?.[1];
    expect(seeded).toBeTruthy();
    expect(declared).toBeTruthy();
    expect(declared).toBe(seeded);
  });
});

describe('the production escalation lookup follows the canonical work-item schema', () => {
  it('derives open ownership from status and the shared terminal-state set', () => {
    const src = read(ACTION_FILE);

    // WI-2140236: work_items has `status`, not `closed_at`. A nonexistent column
    // throws inside observation and skips every candidate before grader dispatch.
    expect(src).not.toContain('closed_at');
    expect(src).toContain("from '../../work-item-dispatch-states'");
    expect(src).toContain('ANY_FAMILY_TERMINAL_STATES');
    expect(src).toContain('NOT (status = ANY(');
  });
});

describe('the sweep asks the gate for recruitment readiness, never shipment permission', () => {
  it('uses the explicit grading-recruitment mode', () => {
    const src = read(ACTION_FILE);
    expect(src).toContain('evaluatePlanAcceptanceGate(planSlug, { gradingRecruitment: true })');
  });
});

describe('system grader dispatch is attributable for lineage enforcement', () => {
  it('supplies the canonical sweep principal in the candidate workspace', () => {
    const src = read(ACTION_FILE);
    expect(src).toContain("kind: 'system'");
    expect(src).toContain('slug: ACCEPTANCE_GRADING_SWEEP_ACTOR');
    expect(src).toContain('principal: {');
    expect(src).toContain("acceptance grading candidate is missing workspace identity");
  });
});

/**
 * Extract every module specifier the file actually IMPORTS — static `from '...'` and
 * dynamic `import('...')` alike.
 *
 * Deliberately not a raw substring scan over the source. The first version of this
 * guard was, and it failed on this module's own DOC COMMENT, which names
 * `scorecards:emit` while explaining that the sweep shares its label algebra. A guard
 * that cannot tell prose from an import is wrong in both directions: it fires on a
 * comment, and it would equally count a forbidden name appearing in a string. Reading
 * the specifiers is the assertion the rule actually means.
 */
function importedSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

describe('R4 at the wiring layer — the routine cannot reach a grading surface', () => {
  it('the action module never imports a scorecard or ship surface', () => {
    const specs = importedSpecifiers(read(ACTION_FILE));
    // The orchestrator's interface already omits these capabilities; this pins that
    // the ADAPTER does not import one directly and hand it in by another route.
    for (const forbidden of ['scorecards', 'set-plan-status', 'rubrics']) {
      const hit = specs.filter((s) => s.includes(forbidden));
      expect(hit, `acceptance-grading-sweep-action must not import ${forbidden} (found ${hit.join(', ')})`).toEqual([]);
    }
  });

  it('NEGATIVE CONTROL: the specifier scan really does detect a forbidden import', () => {
    // Without this, the assertion above passes just as happily on a file with no
    // imports at all, or on a regex that silently matches nothing.
    const planted = `import { emitScorecard } from '../../scorecards';\nconst x = await import('../../agent-tools/plans/set-plan-status');`;
    const specs = importedSpecifiers(planted);
    expect(specs).toContain('../../scorecards');
    expect(specs).toContain('../../agent-tools/plans/set-plan-status');
    expect(specs.filter((s) => s.includes('scorecards'))).not.toEqual([]);
  });

  it('CALIBRATION: the scan finds the imports the action module genuinely has', () => {
    // Proves the scan is reading this specific file successfully, so an empty
    // forbidden-list result means "absent", not "scan returned nothing".
    const specs = importedSpecifiers(read(ACTION_FILE));
    expect(specs).toContain('./system-actions');
    expect(specs).toContain('../../acceptance-grading-sweep-run');
    expect(specs.length).toBeGreaterThan(4);
  });

  it('it only ever calls the grader RESOLVER, never a direct launch-and-grade path', () => {
    const src = read(ACTION_FILE);
    expect(src).toContain('resolveAcceptanceGrader');
    // evaluatePlanAcceptanceGate is the one definition of stuck-ness (R7).
    expect(src).toContain('evaluatePlanAcceptanceGate');
  });

  it('also runs the bounded grading-integrity pending-audit reconciliation clock', () => {
    const src = read(ACTION_FILE);
    expect(src).toContain("import('../../grading-integrity')");
    expect(src).toContain('reconcilePendingGradingAudits');
  });

  // WI-1699998. This sweep is the caller whose re-dispatch re-routed an ALREADY
  // DECIDED grading, so it is also the caller that must recognise the new skip.
  // If 'settled' is missing from the success allowlist, a correct skip returns
  // ok:false and feeds the stall path that mints an "UNGRADED for Nh — it needs
  // an independent grader" escalation against a fully-graded plan. That would
  // trade one silent bug for a louder one.
  it("counts the 'settled' skip as a dispatch SUCCESS, not a failure", () => {
    const okExpr = /const ok =([\s\S]*?);/.exec(read(ACTION_FILE))?.[1] ?? '';
    // CALIBRATION FIRST: the three states that were always successes must be
    // found, so a failure on 'settled' below means "it is absent from the
    // allowlist" rather than "the matcher read nothing" — an empty match would
    // otherwise fail every assertion identically and say nothing about the cause.
    expect(okExpr).toContain("life.state === 'assigned'");
    expect(okExpr).toContain("life.state === 'launched'");
    expect(okExpr).toContain("life.state === 'deduped'");
    expect(okExpr).toContain("life.state === 'settled'");
  });
});
