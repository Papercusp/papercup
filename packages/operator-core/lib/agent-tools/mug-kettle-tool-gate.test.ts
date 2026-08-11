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

import { refuseIfMugKettleRetired, MUG_KETTLE_RETIRED_ERROR } from './_mug-kettle-gate';

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

describe('P-010 tool gate: the shared refusal', () => {
  it('CALIBRATION — tier ENABLED: returns null so the handler proceeds', async () => {
    tierFlag = true;
    await expect(refuseIfMugKettleRetired('start the Mug', 'use su')).resolves.toBeNull();
  });

  it('tier RETIRED: returns a refusal naming the flag and the replacement route', async () => {
    tierFlag = false;
    const refusal = await refuseIfMugKettleRetired('start the Mug', 'Use an su session instead.');
    expect(refusal).not.toBeNull();
    expect(refusal!.isError).toBe(true);
    const body = parse(refusal);
    expect(body.error).toBe(MUG_KETTLE_RETIRED_ERROR);
    // A LOUD refusal, never a silent no-op (the P-008 wording): the caller must
    // be able to act on it without reading this plan. So it has to carry the
    // flag it is gated on AND what to do instead.
    expect(body.flag).toBe('papercusp-mug-kettle-system');
    expect(String(body.message)).toContain('papercusp-mug-kettle-system');
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
 * here so that a restore re-adds it. Removed so far: pot:survey (P-059).
 */
const GATED: Array<{ name: string; load: () => Promise<{ default: unknown }>; args: Record<string, unknown> }> = [
  // D-017 actuators — the refusal is harm-prevention.
  { name: 'pot:start', load: () => import('./pot/start'), args: { harness: 'papercusp' } },
  { name: 'pot:wake', load: () => import('./pot/wake'), args: { harness: 'papercusp', reason: 't' } },
  { name: 'cup:spawn', load: () => import('./cup/spawn'), args: { harness: 'papercusp', role: 'coder' } },
  { name: 'kettle:start', load: () => import('./overwatch/start'), args: { harness: 'papercusp' } },
  { name: 'kettle:declare-wake', load: () => import('./overwatch/declare_wake'), args: { harness: 'papercusp', inSeconds: 60 } },
  // D-048 tier surfaces. set-steering is the one true actuator of the four (it
  // writes, then requestUrgentPotWake); the rest are reads whose zero-valued
  // answers would misreport a retired tier as a healthy idle one.
  { name: 'pot:set-steering', load: () => import('./pot/set_steering'), args: { pot: 'papercusp', pauseNewWork: true } },
  { name: 'pot:declare-wake', load: () => import('./pot/declare_wake'), args: { harness: 'papercusp', inSeconds: 60 } },
  // (pot:survey retired here by P-059/D-080 — see the note above this list.)
  { name: 'pot:mug_efficiency', load: () => import('./pot/mug_efficiency'), args: { harness: 'papercusp' } },
];

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

  it(`CALIBRATION — tier ENABLED: ${name} gets PAST the gate`, async () => {
    tierFlag = true;
    const mod = await load();
    const tool = mod.default as { handler: (a: unknown, c: unknown) => Promise<unknown> };
    // The handler is free to fail for any OTHER reason under these stub mocks —
    // what must never happen is the retirement refusal, which would mean the
    // cutover is irreversible and the flag is decorative.
    let body: Record<string, unknown> | null = null;
    try {
      body = parse(await tool.handler(args, { workspaceId: 'ws', harnessSlug: 'papercusp' }));
    } catch {
      body = null; // threw downstream of the gate — still proof it got past it
    }
    if (body) expect(body.error).not.toBe(MUG_KETTLE_RETIRED_ERROR);
  });
});

/**
 * THE EXCLUSIONS (D-017). These policed the "gate too strong" direction, which
 * is the one a namespace-shaped gate fails: P-010's own text said to skip
 * `agent-tools/{pot,cup,overwatch,curation}` wholesale, and each tool below
 * would have been taken out by that.
 */
const EXCLUDED: Array<{ name: string; why: string; load: () => Promise<{ default: unknown }>; args: Record<string, unknown> }> = [
  {
    name: 'pot:pause',
    why: 'a STOPPER — refusing a stop is never the safe direction, and it is how a tier gets stranded running when the flag flips ON→OFF',
    load: () => import('./pot/pause'),
    args: { harness: 'papercusp' },
  },
  {
    name: 'kettle:pause',
    why: 'a STOPPER, same reason as pot:pause',
    load: () => import('./overwatch/pause'),
    args: { harness: 'papercusp' },
  },
  {
    name: 'curation:state-of-pot',
    why: "Scout's own corpus-synthesis step; D-001 keeps Scout INTACT, and the census found ZERO curation entry points",
    load: () => import('./curation/state-of-pot'),
    args: {},
  },
  {
    name: 'pot:list',
    why: 'the pot-as-CONTAINER surface — a Pot is a harness container and a federation peer, not only a Mug host (D-003 one layer up)',
    load: () => import('./pot/list'),
    args: {},
  },
  {
    name: 'pot:dissolve',
    why:
      'D-048 ruled it CONTAINER-KEEP. Its own guidance is "Permanently tearing down a local pot — stop the Mug, ' +
      'cancel its cups, deregister it": it is a STOPPER, and D-017 is explicit that refusing a stop is never the ' +
      'safe direction. Gating it is how a tier gets stranded RUNNING with no way to wind it down after ON→OFF. ' +
      'It sits in the same `pot:*` namespace as four tools this file DOES gate, so it is exactly the entry a ' +
      'namespace-shaped or name-shaped pass would sweep up by mistake',
    load: () => import('./pot/dissolve'),
    args: { harness: 'papercusp', confirm: true },
  },
  {
    name: 'pot:status',
    why:
      'D-048 ruled it TIER but explicitly left its gating OPTIONAL ("read-only … not harm-prevention"), and D-049 ' +
      'settles the option as NO. Two independent reasons: it falls outside _mug-kettle-gate.ts\'s own stated scope ' +
      '(ACTUATORS ONLY — a tool that INITIATES or SUSTAINS tier work), and it is a DIAGNOSTIC used to verify the ' +
      'tier is wound down. Gating the read that confirms the retirement worked removes evidence for P-030/P-031 ' +
      'to close on. Unlike pot:mug_efficiency it reports declaration STATE, not a zero-valued metric, so it cannot ' +
      'misreport a retired tier as a healthy idle one — the reason the other reads are gated does not apply here',
    load: () => import('./pot/status'),
    args: { harness: 'papercusp' },
  },
];

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
