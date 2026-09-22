/**
 * psu-pty-turn-boundary-generalization-2026-09-22, P-007 -> P-010.
 *
 * These cases exist for one reason: a delivery-rate number is read as a VERDICT, and the two
 * ways this particular number can lie both produce a confident, well-formed percentage.
 * Guarding them is the whole point of the module.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  WAKE_RECOVERED_KIND,
  WAKE_SUCCESS_KIND,
  WAKE_TERMINAL_LOSS_KINDS,
  readWakeDeliveryHealth,
  renderWakeDeliveryHealth,
} from './psu-pty-delivery-rate';

/** Minimal postgres.js stand-in: callable as a template tag, with `.array()`. */
function fakeSql(rows: Array<{ kind: string; n: number }>): Sql {
  const fn = () => Promise.resolve(rows);
  // `sql.array(...)` is a passthrough for the bindings. Assign it through a NARROW
  // structural cast, never `Sql & { array: ... }`: intersecting with Sql keeps
  // postgres.js's generic `array` overload in the target type, which a plain
  // passthrough cannot satisfy (TS2322). Same shape as the other Sql stubs here.
  (fn as unknown as { array: (a: unknown[]) => unknown }).array = (a: unknown[]) => a;
  return fn as unknown as Sql;
}

function throwingSql(message: string): Sql {
  const fn = () => {
    throw new Error(message);
  };
  (fn as unknown as { array: (a: unknown[]) => unknown }).array = (a: unknown[]) => a;
  return fn as unknown as Sql;
}

describe('readWakeDeliveryHealth', () => {
  it('reports an EMPTY window as unmeasured, never as 0% delivery success', async () => {
    // The trap: the ingest routine is scheduled, so an empty table is a routine-not-yet-run
    // state, not a fleet outage. A 0% reading here would manufacture the most alarming
    // possible number out of the most ordinary possible cause.
    const h = await readWakeDeliveryHealth({ sql: fakeSql([]), workspaceId: 'ws' });
    expect(h.measured).toBe(false);
    expect(h.reason).toBe('no-rows-in-window');
    expect(h.ratePct).toBeNull();
    expect(renderWakeDeliveryHealth(h)).toContain('NOT MEASURED');
    // The rendered line must not contain a percentage at all — a reader skimming for "%"
    // must come away with nothing rather than with a number.
    expect(renderWakeDeliveryHealth(h)).not.toMatch(/\d%/);
  });

  it('EXCLUDES busy-gate-expired from the loss set — P-005 re-arms it (D-007)', async () => {
    // The sharpest trap in this module. busy-gate-expired is the intuitive "wake failed"
    // marker, but after P-005 it is deferred-then-delivered. Counting it as a loss would
    // make the rate WORSE the better the recovery works.
    const h = await readWakeDeliveryHealth({
      sql: fakeSql([
        { kind: WAKE_SUCCESS_KIND, n: 8 },
        { kind: WAKE_RECOVERED_KIND, n: 92 },
      ]),
      workspaceId: 'ws',
    });
    expect(h.measured).toBe(true);
    expect(h.delivered).toBe(8);
    expect(h.recovered).toBe(92);
    expect(h.lost).toBe(0);
    // 8 delivered, 0 lost => 100%, NOT 8/(8+92)=8%.
    expect(h.ratePct).toBe(100);
    expect(WAKE_TERMINAL_LOSS_KINDS as readonly string[]).not.toContain(WAKE_RECOVERED_KIND);
  });

  it('computes delivered/(delivered+lost) and exposes recomputable raw counts', async () => {
    const h = await readWakeDeliveryHealth({
      sql: fakeSql([
        { kind: WAKE_SUCCESS_KIND, n: 3 },
        { kind: 'stale-fire-dropped', n: 1 },
        { kind: 'submit-verify-exhausted', n: 1 },
      ]),
      workspaceId: 'ws',
    });
    expect(h.delivered).toBe(3);
    expect(h.lost).toBe(2);
    expect(h.ratePct).toBe(60);
    // byKind must carry the inputs so a consumer can recompute under another definition
    // rather than having to trust this one.
    expect(h.byKind).toMatchObject({ [WAKE_SUCCESS_KIND]: 3, 'stale-fire-dropped': 1 });
  });

  it('returns a NULL rate (not 0, not 100) when the window holds only recovered rows', async () => {
    // No terminal outcomes at all means there is nothing to rate. Dividing by zero into
    // either extreme would be an invented verdict.
    const h = await readWakeDeliveryHealth({
      sql: fakeSql([{ kind: WAKE_RECOVERED_KIND, n: 5 }]),
      workspaceId: 'ws',
    });
    expect(h.measured).toBe(true);
    expect(h.ratePct).toBeNull();
    expect(renderWakeDeliveryHealth(h)).toContain('n/a');
  });

  it('distinguishes a MISSING relation from a failed query, and neither throws', async () => {
    // Migration 1190 pending on this host is a legitimate temporary state; a broken query is
    // not. Both must degrade rather than take down the detector that called them.
    const missing = await readWakeDeliveryHealth({
      sql: throwingSql('relation "harness_shared.psu_pty_host_events" does not exist'),
      workspaceId: 'ws',
    });
    expect(missing.measured).toBe(false);
    expect(missing.reason).toBe('relation-missing');
    expect(renderWakeDeliveryHealth(missing)).toContain('migration 1190');

    const broke = await readWakeDeliveryHealth({
      sql: throwingSql('connection terminated unexpectedly'),
      workspaceId: 'ws',
    });
    expect(broke.measured).toBe(false);
    expect(broke.reason).toBe('query-failed');
  });

  it('keeps the loss set an explicit allowlist that excludes deferred/lifecycle kinds', async () => {
    // A calibration case: the guard above is only meaningful if the loss set stays narrow.
    // If someone later widens it to "everything that is not turn-delivered", these fail.
    const loss = WAKE_TERMINAL_LOSS_KINDS as readonly string[];
    for (const notALoss of [
      'busy-gate-expired',
      'turn-deferred-for-owner-input',
      'turn-deferred-quota-blocked',
      'wake-turn-deferred-for-pending-respawn',
      'wake-rearm-scheduled',
      'respawned',
      'host-teardown',
    ]) {
      expect(loss).not.toContain(notALoss);
    }
    // ...and that it still contains the genuinely terminal ones, so the test above cannot
    // pass vacuously by the set having been emptied.
    expect(loss).toContain('stale-fire-dropped');
    expect(loss).toContain('wake-rearm-unsupported');
  });
});
