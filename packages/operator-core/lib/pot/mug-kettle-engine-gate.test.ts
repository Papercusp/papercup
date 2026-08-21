/**
 * THE ENGINE GATE — getPotStarted resolves false while the tier is retired
 * (retire-mug-kettle-su-only-2026-08-09 P-007, D-004/D-008).
 *
 * P-007 calls this "the single highest-leverage gate", and the leverage is why
 * it needs its own guard: `armFallbackPotWake` is the one chokepoint all three
 * watchdog arming seams (turn-end, boot, tick) funnel through, and it decides by
 * reading this bit. So this one predicate is the difference between a retired
 * Mug and a Mug that quietly wakes itself forever.
 *
 * The failure it polices is SILENT IN BOTH DIRECTIONS, which is what makes a
 * comment or a hand-check insufficient:
 *   • gate too weak → the tier is "retired" but the loop keeps arming wakes and
 *     burning tokens, and nothing errors;
 *   • gate too strong → it catches the SHARED POT SUBSTRATE that the su system
 *     itself runs on (D-003), breaking the replacement system with the very flag
 *     that retires the old one.
 * The calibration case below exists for the first direction specifically: without
 * it, a `getPotStarted` hard-wired to `return false` would pass every other
 * assertion here while destroying the tier's testability.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** The tier flag's answer, per test. `null` ⇒ the flag store throws. */
let tierFlag: boolean | null = true;
/** What the operator_settings row says — deliberately 'true' throughout, so a
 *  false result can only come from the gate and never from missing data. */
let rowValue: string | undefined = 'true';
/** Proves the gate SHORT-CIRCUITS rather than reading PG and discarding it. */
let selectCount = 0;

vi.mock('@papercusp/flags/server', () => ({
  getFlag: async (_key: string) => {
    if (tierFlag === null) throw new Error('flag store unreachable');
    return tierFlag;
  },
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: Object.assign(
      (strings: TemplateStringsArray | string[], ..._values: unknown[]) => {
        const text = Array.isArray(strings) ? strings.join('?') : String(strings);
        if (/SELECT value FROM harness_shared\.operator_settings/i.test(text)) {
          selectCount += 1;
          return Promise.resolve(rowValue === undefined ? [] : [{ value: rowValue }]);
        }
        return Promise.resolve([]);
      },
      { begin: vi.fn() },
      {},
    ),
  }),
}));

// K1 OFF: scope collapses to the per-pot slug (byte-identical legacy keying).
vi.mock('../workspace-brain-scope', () => ({
  isWorkspaceCoordinationOn: async () => false,
  workspaceBrainScopeKey: (_ws: string, slug: string) => slug,
  workspaceBrainReadKeys: (_ws: string, slug: string) => [slug],
}));

import { getPotStarted, mugKettleSystemEnabled } from './started';

beforeEach(() => {
  tierFlag = true;
  rowValue = 'true';
  selectCount = 0;
});

describe('P-007 engine gate: getPotStarted while the mug/kettle tier is retired', () => {
  // This used to be "CALIBRATION — tier ENABLED: a started row still reads as
  // started", flipping the flag ON to prove a `return false` stub could not satisfy
  // the rest of the file. P-068/D-098 deleted the flag: `mugKettleSystemEnabled()`
  // IS now a permanent `false`, so that case cannot be built and the property it
  // proved (reversibility) is deliberately gone.
  //
  // The vacuity risk it covered is REAL and survives, so it is replaced rather than
  // dropped. The short-circuit test below asserts `selectCount === 0`, which a
  // broken SQL mock would satisfy just as happily as a working short-circuit — so
  // the calibration now proves the COUNTER ITSELF is wired, by driving the mocked
  // sql directly. Only then is a zero downstream evidence.
  it('CALIBRATION: the selectCount instrument really increments (so a 0 below means something)', async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    await getOrgPg().sql`SELECT value FROM harness_shared.operator_settings WHERE key = 'probe'`;
    expect(selectCount).toBe(1);
  });

  it('tier RETIRED: resolves false even though the row says started', async () => {
    tierFlag = false;
    await expect(getPotStarted('ws', 'papercusp')).resolves.toBe(false);
  });

  it('tier RETIRED: SHORT-CIRCUITS — never even queries the started row', async () => {
    tierFlag = false;
    await getPotStarted('ws', 'papercusp');
    // Not merely a tidiness assertion: it pins that the retired steady state
    // costs no PG round-trip on a path the 30s sweep and every turn-end hit.
    expect(selectCount).toBe(0);
  });

  it('FAILS CLOSED: an unreadable flag store resolves retired, not started', async () => {
    tierFlag = null;
    await expect(mugKettleSystemEnabled()).resolves.toBe(false);
    await expect(getPotStarted('ws', 'papercusp')).resolves.toBe(false);
    // The asymmetry is the point: a false `true` silently restarts an
    // autonomous loop the owner retired; a false `false` leaves a retired tier
    // retired. Only one of those costs money and surprises the owner.
  });

  it('mugKettleSystemEnabled is PERMANENTLY false — no flag state can re-enable the tier', async () => {
    // Inverts the old "tracks the flag in both directions" assertion, which was the
    // point of the flag and is now exactly what must NOT be true (P-068/D-098).
    // The flag store is still mocked here, so this drives every answer it could
    // give — including the throw — and pins that NONE of them reaches the caller.
    for (const state of [true, false, null] as const) {
      tierFlag = state;
      await expect(mugKettleSystemEnabled()).resolves.toBe(false);
    }
  });

  it('a pot with NO started row stays false regardless of the tier flag', async () => {
    // Guards the pre-existing default ("a pot is born paused/idle") against
    // being disturbed by the new gate in the enabled direction.
    rowValue = undefined;
    tierFlag = true;
    await expect(getPotStarted('ws', 'papercusp')).resolves.toBe(false);
    tierFlag = false;
    await expect(getPotStarted('ws', 'papercusp')).resolves.toBe(false);
  });
});
