/**
 * THE TOOL GATE — the five mug/kettle/cup ACTUATOR tools refuse while the tier
 * is retired (retire-mug-kettle-su-only-2026-08-09 P-010, D-017).
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

beforeEach(() => {
  tierFlag = true;
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
 * The ACTUATOR population from D-017, invoked for real. `pot:declare-wake` is
 * deliberately absent — it is already covered via `getPotStarted` (P-007/D-016),
 * and duplicating a gate is how two gates drift.
 */
const ACTUATORS: Array<{ name: string; load: () => Promise<{ default: unknown }>; args: Record<string, unknown> }> = [
  { name: 'pot:start', load: () => import('./pot/start'), args: { harness: 'papercusp' } },
  { name: 'pot:wake', load: () => import('./pot/wake'), args: { harness: 'papercusp', reason: 't' } },
  { name: 'cup:spawn', load: () => import('./cup/spawn'), args: { harness: 'papercusp', role: 'coder' } },
  { name: 'kettle:start', load: () => import('./overwatch/start'), args: { harness: 'papercusp' } },
  { name: 'kettle:declare-wake', load: () => import('./overwatch/declare_wake'), args: { harness: 'papercusp', inSeconds: 60 } },
];

describe.each(ACTUATORS)('P-010 tool gate: $name', ({ name, load, args }) => {
  it('tier RETIRED: refuses, and performs NO write', async () => {
    tierFlag = false;
    const mod = await load();
    const tool = mod.default as { handler: (a: unknown, c: unknown) => Promise<unknown> };
    const body = parse(await tool.handler(args, { workspaceId: 'ws', harnessSlug: 'papercusp' }));
    expect(body.error).toBe(MUG_KETTLE_RETIRED_ERROR);
    // THE LOAD-BEARING ASSERTION. `error === 'mug_kettle_retired'` alone would
    // also pass if the handler ran its whole body and refused at the END — which
    // is precisely the bug shape for pot:start, whose body IS the restart.
    // Zero writes is the only evidence that nothing was restarted.
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
