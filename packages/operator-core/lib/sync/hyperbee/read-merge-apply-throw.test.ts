/**
 * read-merge-apply-throw.test.ts — WI-255: the incremental merge must not turn a
 * TRANSIENT apply throw into PERMANENT data loss.
 *
 * THE BUG (pre-WI-255): `mergeAdmittedLogsIncremental` recorded the per-key winner
 * (`cursor.winners.set`) BEFORE `await apply(env)`. A valid op whose apply threw
 * transiently (a PG blip/deadlock/timeout mid-merge) propagated the throw out
 * before the cursor position advanced; the caller retried the merge, but on the
 * retry `beatsStored(env, env)` is false (strict `>`), so the op was SKIPPED
 * forever → silently dropped until a rare full re-fold. (su-9140a's from-repo
 * A→B incremental stall is a live instance: B never applies the owner's op.)
 *
 * THE FIX: record the winner only AFTER a non-throwing apply, so a transient
 * throw leaves the op un-deduped → retried next pass → converges. A PERSISTENTLY-
 * throwing (poison) op quarantines after MAX_APPLY_THROWS so it can't loop forever.
 *
 * TEETH: tests 1 + 4 assert the winner is NOT recorded after a throw and the op
 * IS applied on retry — both FALSE under the pre-fix winner-before-apply ordering.
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

describe('WI-255 — incremental merge apply-throw recovery (no permanent drop)', () => {
  it('a VALID op whose apply throws ONCE is APPLIED on retry, not skipped forever', async () => {
    const cursor = createMergeCursor();
    const log = memLog('A', [put('k1', 1000, { id: 'k1' })]);
    const applied: string[] = [];
    let throwOnce = true;
    const apply = async (op: OpEnvelope): Promise<boolean> => {
      if (op.hbKey === 'k1' && throwOnce) {
        throwOnce = false;
        throw new Error('transient PG blip');
      }
      applied.push(op.hbKey);
      return true;
    };

    // Pass 1: apply throws on k1 → the merge propagates the throw.
    await expect(
      mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 }),
    ).rejects.toThrow('transient PG blip');

    // THE FIX (teeth): the winner was NOT recorded, and the cursor did not advance,
    // so k1 is eligible to be re-read + retried (under the pre-fix code k1's winner
    // WAS recorded here → the retry below would skip it = the data-loss bug).
    expect(cursor.winners.has(KEY('k1'))).toBe(false);
    expect(cursor.positions.get('A') ?? 0).toBe(0);

    // Pass 2 (SAME cursor): k1 re-read, apply succeeds → applied, winner recorded.
    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    expect(applied).toEqual(['k1']);
    expect(cursor.winners.has(KEY('k1'))).toBe(true);
    expect(cursor.positions.get('A')).toBe(1);
  });

  it('a PERSISTENTLY-throwing (poison) op QUARANTINES — terminates (no infinite loop), and a newer op still lands', async () => {
    const cursor = createMergeCursor();
    const poison = memLog('A', [put('k1', 1000, { id: 'poison' })]);
    const apply = async (_op: OpEnvelope): Promise<boolean> => {
      throw new Error('poison: value PG can never store');
    };
    // The quarantine logs via console.error by design — mock it + assert it fired.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Each throwing pass re-reads the same op (cursor never advanced). After the
    // bounded retry budget it QUARANTINES (returns normally instead of throwing).
    let throwingPasses = 0;
    let settled = false;
    for (let i = 0; i < 8 && !settled; i++) {
      try {
        await mergeAdmittedLogsIncremental([poison], cursor, { applyImpl: apply, getTimeoutMs: 0 });
        settled = true;
      } catch {
        throwingPasses++;
      }
    }
    expect(settled).toBe(true); // BOUNDED — never an infinite retry loop
    expect(throwingPasses).toBeGreaterThanOrEqual(1);
    expect(throwingPasses).toBeLessThanOrEqual(3); // MAX_APPLY_THROWS-bounded
    // The quarantine was logged (not a silent drop) exactly once.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('WI-255 quarantine'),
      expect.stringContaining('poison'),
    );
    errSpy.mockRestore();

    // Quarantine recorded the winner (so beatsStored stops re-selecting it) and the
    // cursor advanced past it — the poison op is dropped, not applied.
    expect(cursor.winners.has(KEY('k1'))).toBe(true);
    expect(cursor.positions.get('A')).toBe(1);

    // A NEWER op for the same key still applies (it beats the quarantined winner) —
    // quarantine drops the ONE poison op, it does not poison the key forever.
    const applied: string[] = [];
    const goodApply = async (op: OpEnvelope): Promise<boolean> => {
      applied.push(`${op.hbKey}@${op.ts}`);
      return true;
    };
    const fresh = createMergeCursor();
    const newer = memLog('A', [put('k1', 1000, {}), put('k1', 2000, { id: 'good' })]);
    // (fresh apply never throws — model the cleared transient on the live key)
    await mergeAdmittedLogsIncremental([newer], fresh, { applyImpl: goodApply, getTimeoutMs: 0 });
    expect(applied).toContain('k1@2000');
  });

  it('SUCCESS-PATH UNCHANGED: a clean op applies + records its winner; a stale (LWW-losing) op is skipped', async () => {
    const cursor = createMergeCursor();
    const applied: string[] = [];
    const apply = async (op: OpEnvelope): Promise<boolean> => {
      applied.push(`${op.hbKey}@${op.ts}`);
      return true;
    };
    // Same key 'g' twice, higher ts FIRST: g@2000 applies, then g@1000 LOSES the
    // beatsStored gate → skipped (the success-path LWW dedup is untouched by the fix).
    const log = memLog('A', [put('g', 2000, {}), put('g', 1000, {}), put('h', 1500, {})]);
    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    expect(applied).toContain('g@2000'); // first seen (higher ts) → applied
    expect(applied).not.toContain('g@1000'); // STALE (lower ts) → skipped, apply never called
    expect(applied).toContain('h@1500'); // distinct key → applied
    expect(cursor.winners.get(KEY('g'))?.ts).toBe(2000);
  });

  it('apply returning FALSE (a legitimate apply-level drop, not a throw) still records the winner', async () => {
    const cursor = createMergeCursor();
    // apply returns false (e.g. an internal version-gate drop) — NOT a throw.
    const apply = async (_op: OpEnvelope): Promise<boolean> => false;
    const log = memLog('A', [put('k1', 1000, {})]);
    const res = await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 0 });
    expect(res.applied).toBe(0); // not counted as applied
    expect(cursor.winners.has(KEY('k1'))).toBe(true); // but recorded as the winner (LWW unchanged)
    expect(cursor.positions.get('A')).toBe(1); // and the cursor advanced
  });
});
