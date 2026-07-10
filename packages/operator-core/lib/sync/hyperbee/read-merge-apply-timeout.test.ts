/**
 * read-merge-apply-timeout.test.ts — WI-3896 (tower outbox/merge wedge: "papercusp
 * substrate_merge_cursor never establishes"): a HUNG (never resolving, never
 * throwing) `apply(env)` used to freeze `mergeAdmittedLogsIncremental` FOREVER —
 * unlike `outbox-drain.ts`'s send-side pass, which already races the whole pass
 * against `DRAIN_PASS_TIMEOUT_MS`, nothing bounded this per-op await (the
 * `read-merge-stage-stall.test.ts` docstring explicitly called this out:
 * `logIfStageStalls` only LOGS at 15s, it never times out `p`). The live incident:
 * an old iMac device's stale plan-parts (~ef7a8160) hung merge-apply forever, so
 * the harness's PG-persisted merge cursor simply stopped advancing, silently.
 *
 * THE FIX: `applyRecordingWinner` now races `apply(env)` against
 * `MERGE_APPLY_TIMEOUT_MS` (`applyTimeoutMs` opt) via `raceApplyTimeout`. A
 * timeout throws `MergeApplyTimeoutError`, funneled into the SAME WI-255
 * `MAX_APPLY_THROWS` retry/quarantine counter a throwing apply already uses —
 * so a transient (load-induced) hang gets a couple of free retries, and a
 * PERSISTENTLY-hanging (poison) op quarantines (winner recorded + dropped)
 * exactly like a persistently-throwing one, unwedging the whole merge loop.
 *
 * TEETH: test 1 pins that an op whose apply NEVER settles is nonetheless
 * DROPPED (not retried forever) once the bound is set low enough to exercise in
 * a unit test; test 2 pins that a merely-SLOW (but eventually successful) apply
 * is NOT mistaken for poison — it applies normally once the retry gives it
 * enough real time; test 3 pins `applyTimeoutMs: 0` fully disables the bound
 * (today's pre-WI-3896 behavior, preserved as an explicit opt-out).
 */
import { describe, it, expect, vi } from 'vitest';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog } from './read-merge';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';

function memLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return { keyHex, length: ops.length, get: async (i) => ops[i] ?? null };
}
function put(hbKey: string, ts: number, value: unknown): PeerLogOp {
  return { type: 'put', table: 'features-by-id', hbKey, value, ts, schema_version: 1, author_pubkey: 'pk' };
}
const KEY = (hbKey: string) => `features-by-id::${hbKey}`;

describe('WI-3896 — incremental merge apply-TIMEOUT recovery (bounded hang, no permanent wedge)', () => {
  it('a PERMANENTLY-hung (never settling) apply QUARANTINES after bounded retries — the merge loop never wedges forever', async () => {
    const cursor = createMergeCursor();
    const poison = memLog('A', [put('k1', 1000, { id: 'ef7a8160-stale-plan-part' })]);
    // Models the live incident: apply() never resolves, never rejects (a wedged
    // connection/lock against a stale/dead device's row).
    const apply = async (_op: OpEnvelope): Promise<boolean> => new Promise<boolean>(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let settled = false;
    let timeoutEpisodes = 0;
    for (let i = 0; i < 8 && !settled; i++) {
      try {
        // Tiny bound so the test runs fast in real time; production default is
        // MERGE_APPLY_TIMEOUT_MS (45s) — only the magnitude differs, not the shape.
        await mergeAdmittedLogsIncremental([poison], cursor, {
          applyImpl: apply,
          getTimeoutMs: 0,
          applyTimeoutMs: 10,
        });
        settled = true;
      } catch (e) {
        timeoutEpisodes++;
        expect((e as Error).message).toContain('TIMEOUT');
      }
    }

    expect(settled).toBe(true); // BOUNDED — the permanently-hung op cannot wedge the loop forever
    expect(timeoutEpisodes).toBeGreaterThanOrEqual(1);
    expect(timeoutEpisodes).toBeLessThanOrEqual(3); // MAX_APPLY_THROWS-bounded, same as WI-255

    // Quarantined + logged distinctly from a throw (WI-3896, not WI-255).
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('WI-3896 quarantine'),
      expect.stringContaining('TIMEOUT'),
    );
    errSpy.mockRestore();

    // Winner recorded (beatsStored stops re-selecting it) and the cursor advanced —
    // the poison op is dropped, not applied; a newer op for the same key still wins.
    expect(cursor.winners.has(KEY('k1'))).toBe(true);
    expect(cursor.positions.get('A')).toBe(1);
  });

  it('a SLOW-but-eventually-successful apply is NOT mistaken for poison — it lands once it gets enough real time', async () => {
    const cursor = createMergeCursor();
    const applied: string[] = [];
    // Resolves after a short real delay — comfortably under the bound — modeling
    // a legitimately slow write under host load, not a genuine wedge.
    const apply = async (op: OpEnvelope): Promise<boolean> => {
      await new Promise((r) => setTimeout(r, 5));
      applied.push(op.hbKey ?? '');
      return true;
    };
    const log = memLog('A', [put('k1', 1000, { id: 'k1' })]);

    const result = await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: apply,
      getTimeoutMs: 0,
      applyTimeoutMs: 500, // generous relative to the 5ms write
    });

    expect(result.applied).toBe(1);
    expect(applied).toEqual(['k1']);
    expect(cursor.winners.has(KEY('k1'))).toBe(true);
  });

  it('applyTimeoutMs: 0 disables the bound entirely (explicit opt-out, pre-WI-3896 behavior)', async () => {
    const cursor = createMergeCursor();
    const applied: string[] = [];
    // Resolves, but only after longer than what would otherwise be the default
    // bound — proves 0 truly disables it rather than just using a big number.
    const apply = async (op: OpEnvelope): Promise<boolean> => {
      await new Promise((r) => setTimeout(r, 20));
      applied.push(op.hbKey ?? '');
      return true;
    };
    const log = memLog('A', [put('k1', 1000, { id: 'k1' })]);

    const result = await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: apply,
      getTimeoutMs: 0,
      applyTimeoutMs: 0,
    });

    expect(result.applied).toBe(1);
    expect(applied).toEqual(['k1']);
  });
});
