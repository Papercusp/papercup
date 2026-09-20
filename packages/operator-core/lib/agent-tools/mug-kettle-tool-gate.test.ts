/**
 * THE TOOL GATE — the mug/kettle/cup tools that refuse while the tier is
 * retired (retire-mug-kettle-su-only-2026-08-09 P-010, D-017, D-048).
 *
 * (No population COUNT is stated here on purpose: P-059 retires these tools one
 * slice at a time, so any number written in this prose is wrong by the next
 * slice. `GATED` below is the population; D-080 governs how it shrinks.)
 *
 * TWO POPULATIONS, gated for DIFFERENT reasons — do not collapse them:
 *   • ACTUATORS (D-017, 5) — they INITIATE or SUSTAIN autonomous tier work, so
 *     the refusal is HARM-PREVENTION. `pot:set-steering` (D-048) joins these:
 *     it writes steering and then calls requestUrgentPotWake.
 *   • TIER SURFACES (D-048, the rest) — read-only, so nothing is prevented. The
 *     refusal exists because the ALTERNATIVE IS WORSE THAN NOTHING: under
 *     retirement `pot:mug_efficiency` returns an all-zero report that reads as
 *     "the Mug is idle and efficient" rather than "this tier is retired" — the
 *     same zero-because-gated confound P-030 defends against on the spawn
 *     baseline. A refusal naming the flag is the honest answer; a zero is not.
 *
 * P-007 gated the ENGINE (the loop cannot arm its own wake). This gates the
 * HANDS: the tools an agent or the owner could call to restart the tier by hand.
 * The two are genuinely independent — measured 2026-08-09, `pot:start` still ran
 * its whole body (setPotStarted + arm subscriptions + wake-mode auto + an urgent
 * wake) with the engine gate fully in place, because writing the bit and
 * RESOLVING the bit are different code paths.
 *
 * WHAT MAKES THIS FILE WORTH ITS WEIGHT — it is falsifiable in BOTH directions,
 * and both directions have already produced real bugs on this plan:
 *   • TOO WEAK  → a tool that "no longer works" still restarts the tier, silently.
 *     Every refusal case below invokes the REAL handler, so a gate that is merely
 *     documented in a comment fails here.
 *   • TOO STRONG → the gate catches the shared pot substrate the su system itself
 *     runs on (the D-003 finding), or a STOPPER, breaking the replacement system
 *     with the very flag that retires the old one. That is what the CALIBRATION
 *     and EXCLUSION cases police.
 *
 * ⚠ The calibration cases are load-bearing, not ceremony: without them a
 * `refuseIfMugKettleRetired` hard-wired to always refuse — or a handler that
 * throws for an unrelated reason — would satisfy every refusal assertion in this
 * file while making the tier untestable. `case: 'cutover'` means REVERSIBLE; a
 * gate that cannot be turned back off is not the thing this plan ratified.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** The tier flag's answer, per test. `null` ⇒ the flag store throws. */
let tierFlag: boolean | null = true;
/** Every non-flag flag read (MUG_TIER_SELECTION, OVERWATCH, …) answers true, so
 *  a refusal can only ever come from the retirement gate under test. */
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: async (key: string) => {
    if (key === 'papercusp-mug-kettle-system') {
      if (tierFlag === null) throw new Error('flag store unreachable');
      return tierFlag;
    }
    return true;
  },
}));

/**
 * PROOF-OF-NO-SIDE-EFFECT. Any statement past the gate in these handlers reaches
 * PG. Counting writes lets the refusal cases assert the strong property — "the
 * tier was not restarted" — instead of the weak one, "an error object came back".
 */
let sqlCalls: string[] = [];
// PARTIAL-MOCK HAZARD (EI-20017608270017874): hand-listing exports here breaks
// the moment any module in this graph imports a sibling (`generated`, …) — and
// in a handler wrapped in try/catch it breaks SILENTLY, leaving a suite that
// measures nothing while still passing. Spread the real module and override ONLY
// the one seam under observation.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({
    sql: Object.assign(
      (strings: TemplateStringsArray | string[], ..._values: unknown[]) => {
        sqlCalls.push(Array.isArray(strings) ? strings.join('?') : String(strings));
        return Promise.resolve([]);
      },
      {
        begin: vi.fn(),
        // `sql.unsafe` is a real seam on this client (scout/corpus-digest.ts
        // reaches for it). Counted like any other call so the "performed NO
        // write" assertion cannot be dodged through it.
        unsafe: (text: string) => {
          sqlCalls.push(String(text));
          return Promise.resolve([]);
        },
      },
    ),
  }),
}));

/**
 * The curation exclusion below proves that the REAL state-of-pot tool is not
 * wrapped in the retired actuator gate. Its corpus synthesis is a different
 * contract with its own unit/integration suites, and running that whole graph
 * here made this safety guard load-sensitive: the exclusion could spend the
 * 60-second unit timeout in unrelated digest work and be reported as if
 * curation had been retired. Stub only the two downstream seams; the actual
 * tool module and handler still load and execute, so adding the retirement gate
 * to that handler continues to fail this suite.
 */
vi.mock('../scout/corpus-digest', () => ({
  synthesizeStateOfHive: async () => ({ friction: [], sinks: [], deferrals: [], gaps: [] }),
}));
vi.mock('../scout/corpus-digest-deps', () => ({
  buildStateOfHiveReaders: () => ({}),
}));

import { refuseIfMugKettleRetired, MUG_KETTLE_RETIRED_ERROR } from './_mug-kettle-gate';
// The POPULATION now lives in a real module so prose surfaces can derive from it instead
// of hand-copying it (WI-10002068). This file keeps the test-only wiring and joins by name.
import {
  MUG_KETTLE_VERBS,
  DELETED_TOOL_GROUP_DIRS,
  gatedVerbs,
  excludedVerbs,
  deletedVerbs,
  type MugKettleVerb,
} from './_mug-kettle-gate-population';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parse a tool result's single JSON text block. */
function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text?: string }> } | null)?.content;
  const text = content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`not a tool result: ${JSON.stringify(result)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Drain the macrotask queue. Load-bearing for the no-write assertion, because
 * some of these handlers FIRE AND FORGET: the CALIBRATION case (tier ENABLED)
 * lets a handler run for real, and `setOwnerSteering` → `requestUrgentPotWake` →
 * `notifySyncInvalidate` lands its `pg_notify` a tick or two LATER — i.e. after
 * that test has already ended. Without this drain those writes surface in the
 * NEXT test's `sqlCalls` and get blamed on a tool that never made them
 * (observed 2026-08-10: pot:set-steering's calibration writes were attributed to
 * pot:declare-wake, and pot:declare-wake's to pot:survey — two red tests, both
 * pointing at innocent tools).
 */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  tierFlag = true;
  // Drain BEFORE the reset, never after: the point is that in-flight writes from
  // the previous test are attributed to it and discarded here.
  await settle();
  sqlCalls = [];
});

it('P-010 import hygiene: pot tool modules perform no database I/O while loading', async () => {
  const modules: Array<[string, () => Promise<unknown>]> = [
    ['pot:declare-wake', () => import('./pot/declare_wake')],
    ['pot survey', () => import('../pot/survey')],
  ];
  for (const [label, load] of modules) {
    sqlCalls = [];
    await load();
    await settle();
    await settle();
    expect(sqlCalls, `${label} performed database I/O during module import`).toEqual([]);
  }
});

describe('P-010 tool gate: the shared refusal', () => {
  // This block used to open with "CALIBRATION — tier ENABLED: returns null so the
  // handler proceeds", proving the gate could answer BOTH ways and was therefore
  // not a constant. P-068/D-098 deleted the flag and made it a constant deliberately,
  // so that case is unconstructible and its assertion is now exactly backwards.
  //
  // The discriminating power did NOT go with it — and the survivor is stronger. The
  // EXCLUDED suite at the bottom of this file drives real UNGATED tools (pot:pause,
  // pot:dissolve, pot:list, pot:status, curation:state-of-pot) through this same
  // harness and asserts they do not return this refusal. So "the harness refuses
  // everything" cannot pass unnoticed here, which is the property the ON case used
  // to provide.
  it('refuses under EVERY flag-store answer — the retirement is not a flag read any more', async () => {
    // The flag store is still mocked, so this drives every answer it could give,
    // including the throw, and pins that none of them reaches the caller.
    for (const state of [true, false, null] as const) {
      tierFlag = state;
      await expect(refuseIfMugKettleRetired('start the Mug', 'use su')).resolves.not.toBeNull();
    }
  });

  it('returns a refusal naming the PERMANENCE and the replacement route', async () => {
    const refusal = await refuseIfMugKettleRetired('start the Mug', 'Use an su session instead.');
    expect(refusal).not.toBeNull();
    expect(refusal!.isError).toBe(true);
    const body = parse(refusal);
    expect(body.error).toBe(MUG_KETTLE_RETIRED_ERROR);
    // A LOUD refusal, never a silent no-op (the P-008 wording): the caller must be
    // able to act on it without reading this plan. It no longer carries a `flag`
    // field, and that is the point — there is no flag left to name, and sending a
    // caller to /admin/features for a key that does not exist is worse than silence.
    expect(body.flag).toBeUndefined();
    expect(String(body.message)).toContain('permanently');
    expect(String(body.message)).toContain('Use an su session instead.');
    // `ok:false` is what a caller branches on; assert it rather than assume the
    // isError envelope is enough — several surfaces read only the JSON body.
    expect(body.ok).toBe(false);
  });

  it('FAILS CLOSED: an unreadable flag store refuses rather than proceeding', async () => {
    tierFlag = null;
    await expect(refuseIfMugKettleRetired('start the Mug', 'use su')).resolves.not.toBeNull();
    // Same asymmetry the engine gate pins: a false `true` restarts a loop the
    // owner retired; a false `false` leaves a retired tier retired.
  });
});

/**
 * The gated population — D-017's five actuators plus D-048's four tier surfaces,
 * every one invoked for real.
 *
 * ⚠ `pot:declare-wake` USED TO BE DELIBERATELY ABSENT HERE, on the reasoning
 * that it is "already covered via getPotStarted (P-007/D-016), and duplicating a
 * gate is how two gates drift." That reasoning was CHECKED, not discarded, and
 * it is half right (D-049):
 *   - The coverage claim is TRUE. pot/started.ts:117 opens getPotStarted with
 *     `if (!(await mugKettleSystemEnabled())) return false`, so declare-wake's
 *     started check already refused under retirement, before any write.
 *   - The DRIFT risk is NOT. Drift needs two gates that can disagree about
 *     whether to ALLOW. These resolve the same flag through the same function,
 *     so flag-ON makes the refusal return null AND getPotStarted read the real
 *     row. Strictly nested, never parallel.
 * What the added gate buys is the DIAGNOSIS: the started check reports
 * `hive_paused` and tells the caller "pot:start resumes autonomous wakes" —
 * pointing at a tool D-017 gates, so a retired tier sent the caller to a dead
 * route without ever naming the flag. Pause and retirement are different states.
 *
 * ⚠ THIS LIST SHRINKS AS P-059 DELETES TIER CODE, and that is CORRECT (D-080).
 * A row asserts two things: the gate refuses the tool, and — the CALIBRATION
 * case — flipping the flag back ON restores it. Deleting a tool's file removes
 * the SECOND property on purpose: once the module is in `_retired/` and
 * unregistered from agent-tools/index.ts, flag-ON no longer brings it back. So
 * a retired tool's row is not "coverage lost", it is a row whose SUBJECT
 * retired, and keeping it would assert a reversibility the system no longer
 * honours. The restore contract MOVES from the flag to
 * `_retired/mug-kettle-deciders/RESTORE.md`, which records every row removed
 * here so that a restore re-adds it. Removed so far: pot:survey,
 * kettle:declare-wake, kettle:start, kettle:pause, cup:spawn (P-059) — and two
 * of those retirements emptied a whole tool group, so there is no longer an
 * `agent-tools/overwatch/` NOR an `agent-tools/cup/` directory for a future row
 * to live in. `cup:spawn` was the last `cup:*` verb, so that namespace is gone.
 */
/**
 * TEST-ONLY WIRING: how to drive each surviving verb's handler. The names, dispositions and
 * rationales are NOT here — they live in `_mug-kettle-gate-population.ts` so prose can be
 * pinned to them (WI-10002068). This map supplies only what a test needs and a doc cannot
 * use: the dynamic import thunk and a handler fixture.
 *
 * Every `gated` and `excluded` row in the population MUST appear here, and nothing else may.
 * Both directions are asserted below — a missing entry would silently shrink `describe.each`
 * and pass vacuously, which is the exact failure D-080 exists to prevent.
 *
 * (Deleted verbs are absent by construction: there is no module left to import. Their
 * removal is verified as a directory fact instead — see the DELETED suite.)
 */
const WIRING: Record<
  string,
  { load: () => Promise<{ default: unknown }>; args: Record<string, unknown> }
> = {
  'pot:start': { load: () => import('./pot/start'), args: { harness: 'papercusp' } },
  'pot:wake': { load: () => import('./pot/wake'), args: { harness: 'papercusp', reason: 't' } },
  'pot:set-steering': {
    load: () => import('./pot/set_steering'),
    args: { pot: 'papercusp', pauseNewWork: true },
  },
  'pot:declare-wake': {
    load: () => import('./pot/declare_wake'),
    args: { harness: 'papercusp', inSeconds: 60 },
  },
  'pot:mug_efficiency': {
    load: () => import('./pot/mug_efficiency'),
    args: { harness: 'papercusp' },
  },
  'pot:pause': { load: () => import('./pot/pause'), args: { harness: 'papercusp' } },
  'curation:state-of-pot': { load: () => import('./curation/state-of-pot'), args: {} },
  'pot:list': { load: () => import('./pot/list'), args: {} },
  'pot:dissolve': {
    load: () => import('./pot/dissolve'),
    args: { harness: 'papercusp', confirm: true },
  },
  'pot:status': { load: () => import('./pot/status'), args: { harness: 'papercusp' } },
};

/**
 * Joined rows. THROWS rather than skipping when wiring is missing: a silently dropped row
 * would shrink the suite to a green that proves less than it did yesterday, and a loud
 * collection failure naming the verb is strictly better than that.
 */
type WiredVerb = MugKettleVerb & {
  load: () => Promise<{ default: unknown }>;
  args: Record<string, unknown>;
};
const withWiring = (verbs: readonly MugKettleVerb[]): WiredVerb[] =>
  verbs.map((v) => {
    const wired = WIRING[v.name];
    if (!wired) {
      throw new Error(
        `mug-kettle-tool-gate: no test wiring for '${v.name}' (disposition '${v.disposition}'). ` +
          `Add it to WIRING, or move the row to 'deleted' in _mug-kettle-gate-population.ts.`,
      );
    }
    return { ...v, ...wired };
  });

const GATED: WiredVerb[] = withWiring(gatedVerbs());

/**
 * ANTI-VACUITY (D-080). `describe.each([])` registers NO tests and passes
 * silently, and the EXCLUDED suites below keep this file non-empty so
 * `passWithNoTests` never fires either — so an emptied GATED list would look
 * exactly like a green gate. This plan has already been bitten twice by a
 * vacuous-pass guard, and P-059 removes rows from this list one slice at a
 * time, which is precisely the process that walks it toward zero.
 *
 * Asserted while the list is still long, not when it is nearly empty: if the
 * LAST gated tool retires, this fails, and D-080 says the answer is to REPLACE
 * this suite with a guard that the gate module itself is unreachable — never to
 * delete it.
 */
it('D-080: the GATED population is non-empty (a drained list would pass vacuously)', () => {
  expect(GATED.length).toBeGreaterThan(0);
});

/**
 * POPULATION INTEGRITY (WI-10002068). Moving the names into a shared module makes them
 * derivable by prose — and creates exactly one new way to be wrong: the population and this
 * file's wiring drifting apart. These assertions close that, in BOTH directions, so the
 * extraction cannot trade a documentation drift for a test drift.
 */
describe('population <-> wiring integrity', () => {
  const live = [...gatedVerbs(), ...excludedVerbs()].map((v) => v.name).sort();

  it('every live verb has test wiring, and nothing is wired that is not live', () => {
    // Both directions matter and they fail differently: a MISSING entry shrinks
    // describe.each toward a vacuous green (withWiring throws first, by design), while an
    // EXTRA entry means a verb was retired in the population but still driven here.
    expect(Object.keys(WIRING).sort()).toEqual(live);
  });

  it('no DELETED verb is still wired (a deleted tool has no module to import)', () => {
    const wiredButDeleted = deletedVerbs()
      .map((v) => v.name)
      .filter((name) => name in WIRING);
    expect(wiredButDeleted).toEqual([]);
  });

  it('every row carries a rationale and no name appears twice', () => {
    // `why` is load-bearing for prose derivation, so an empty one is a silent gap in the
    // thing this module exists to publish.
    expect(MUG_KETTLE_VERBS.filter((v) => v.why.trim() === '').map((v) => v.name)).toEqual([]);
    const names = MUG_KETTLE_VERBS.map((v) => v.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it('the DELETED tool-group directories are really gone', () => {
    const here = dirname(fileURLToPath(import.meta.url));

    // POSITIVE CONTROL on the instrument, first. Every absence below is measured with
    // existsSync against `here`; if that base path were wrong, EVERY directory would read
    // as absent and this suite would pass while proving nothing — the classic false
    // negative from a broken instrument rather than a true empty result.
    expect(
      existsSync(join(here, 'pot')),
      'instrument check: the surviving pot/ group must be found from this base path',
    ).toBe(true);

    for (const dir of DELETED_TOOL_GROUP_DIRS) {
      expect(existsSync(join(here, dir)), `${dir}/ was deleted by P-059 and must stay gone`).toBe(
        false,
      );
    }
  });
});

describe.each(GATED)('P-010 tool gate: $name', ({ name, load, args }) => {
  it('tier RETIRED: refuses, and performs NO write', async () => {
    tierFlag = false;
    const mod = await load();
    const tool = mod.default as { handler: (a: unknown, c: unknown) => Promise<unknown> };
    // Discount anything the IMPORT did. The claim under test is "this INVOCATION
    // did not restart the tier", and a module-scope side effect somewhere in the
    // import graph is not the invocation. Measured 2026-08-10: importing
    // pot/declare_wake costs 2 statements and pot/survey 1 (`pg_notify`) before
    // the handler is ever called, while pot/start's chain costs none — so an
    // import-inclusive baseline reds exactly the tools whose dependency graph is
    // widest, which is unrelated to whether their gate works.
    await settle();
    sqlCalls = [];
    const body = parse(await tool.handler(args, { workspaceId: 'ws', harnessSlug: 'papercusp' }));
    expect(body.error).toBe(MUG_KETTLE_RETIRED_ERROR);
    // THE LOAD-BEARING ASSERTION. `error === 'mug_kettle_retired'` alone would
    // also pass if the handler ran its whole body and refused at the END — which
    // is precisely the bug shape for pot:start, whose body IS the restart.
    // Zero writes is the only evidence that nothing was restarted.
    //
    // Settle FIRST so this catches a FIRE-AND-FORGET write too — a handler that
    // refuses correctly while a floating promise writes a tick later would
    // otherwise pass. This makes the assertion strictly stronger; it is the same
    // drain beforeEach does, applied to the call under test rather than to the
    // previous one.
    await settle();
    expect(sqlCalls).toEqual([]);
  });

  // The per-tool "CALIBRATION — tier ENABLED: ${name} gets PAST the gate" case was
  // REMOVED here (P-068/D-098). It asserted that the refusal was absent with the
  // flag ON, and its stated purpose was to prove "the cutover is [not] irreversible
  // and the flag is [not] decorative" — both of which P-068 deliberately made
  // false. The cutover IS irreversible now; there is no flag.
  //
  // It is not replaced per-tool, because a same-tool control is exactly what the
  // deletion removes. The equivalent evidence is CROSS-tool and already runs: the
  // EXCLUDED suite below drives ungated tools through this identical harness and
  // requires they do NOT produce this refusal. That is what keeps the assertion
  // above from being satisfiable by a harness that refuses everything.
});

/**
 * THE EXCLUSIONS (D-017). These policed the "gate too strong" direction, which
 * is the one a namespace-shaped gate fails: P-010's own text said to skip
 * `agent-tools/{pot,cup,overwatch,curation}` wholesale, and each tool below
 * would have been taken out by that.
 */
const EXCLUDED: WiredVerb[] = withWiring(excludedVerbs());

describe.each(EXCLUDED)('P-010 exclusion: $name stays reachable', ({ load, args, why }) => {
  it(`is NOT gated (${why})`, async () => {
    tierFlag = false; // the retired steady state
    const mod = await load();
    const tool = mod.default as { handler: (a: unknown, c: unknown) => Promise<unknown> };
    let body: Record<string, unknown> | null = null;
    try {
      body = parse(await tool.handler(args, { workspaceId: 'ws', harnessSlug: 'papercusp' }));
    } catch {
      body = null; // failing on the stub mocks is fine; being REFUSED is not
    }
    if (body) expect(body.error).not.toBe(MUG_KETTLE_RETIRED_ERROR);
  });
});
