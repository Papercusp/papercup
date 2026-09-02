/**
 * read-merge-read-stall.test.ts — WI-2141796: a log position that never becomes
 * readable pins its cursor forever, and that MUST NOT be silent.
 *
 * THE INCIDENT (2026-09-02, tower). The `papercusp` merge cursor on log
 * `cb54460d98d8` sat at position 12048 while the writer ran on past 25,000. Every
 * inbound coordination row written after 09:42Z lived at a position the cursor had
 * never reached, so cross-machine coordination was dead for ~7.5 hours.
 *
 * WHY NOTHING CAUGHT IT. The `unavailable` branch of the read loop `break`s with no
 * output whatsoever. No apply is attempted at a position that never reads, so no
 * apply-timeout, no quarantine, no constraint error and no rollback ever fires. The
 * peer stays connected, so replication-liveness reports `live` and the substrate
 * health verdict reports `healthy`. Worse, the cursor ROW looks fresh: positions are
 * persisted as ONE map, so a SIBLING log advancing re-stamps the frozen row's
 * `updated_at`. A moving `updated_at` next to a frozen `position` is indistinguishable
 * from a healthy merge unless you compare the position against the writer's length.
 *
 * THE FIX IS OBSERVABILITY ONLY — the retry stays UNBOUNDED and unchanged, because a
 * withheld block is usually transient and dead-lettering it would lose a
 * readable-later op. What changes is that the stall now announces itself, names the
 * position, and reports how many ops are stranded behind it.
 *
 * TEETH: assert the warning is EMITTED, names the position, and reports the stranded
 * backlog — and that the cursor really is held (the pin is real, not hypothetical).
 * Before the fix the merge emitted nothing at all on this path, so the first
 * assertion fails outright.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog } from './read-merge';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';

function put(hbKey: string, ts: number): PeerLogOp {
  return { type: 'put', table: 'features-by-id', hbKey, value: {}, ts, schema_version: 1, author_pubkey: 'pk' };
}

/** A log whose `get(stallIndex)` NEVER settles — models a peer that is connected and
 *  serving the swarm but never returns this particular block. Every other index
 *  resolves normally. */
function logWithStalledIndex(keyHex: string, ops: PeerLogOp[], stallIndex: number): AdmittedLog {
  return {
    keyHex,
    length: ops.length,
    get: async (i) => {
      if (i === stallIndex) return new Promise<never>(() => {}); // never settles
      return ops[i] ?? null;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('WI-2141796 — a permanently-unreadable position announces itself instead of pinning the cursor silently', () => {
  it('emits a read-stall warning naming the position and the ops stranded behind it, and holds the cursor there', async () => {
    const cursor = createMergeCursor();
    // index0 reads → index1 NEVER settles → index2/3 are stranded behind it.
    const log = logWithStalledIndex('ABCDEF0123456789', [put('a', 1000), put('b', 2000), put('c', 3000), put('d', 4000)], 1);
    const applied: string[] = [];
    const apply = async (op: OpEnvelope): Promise<boolean> => {
      applied.push(op.hbKey ?? '');
      return true;
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 15 });

    // The pin is real: index0 folded, then the fold stopped AT the stalled position.
    expect(applied).toEqual(['a']);
    expect(cursor.positions.get('ABCDEF0123456789')).toBe(1);

    // …and it is no longer silent. THIS is the assertion that fails before the fix.
    const stallWarnings = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('read stall'));
    expect(stallWarnings).toHaveLength(1);
    expect(stallWarnings[0]).toContain('ABCDEF012345#1'); // the exact wedged position
    expect(stallWarnings[0]).toContain('3 op(s) behind it'); // length 4 − position 1
  });

  it('throttles a persistent stall to 1st + every 100th pass, and counts consecutively on the SAME position', async () => {
    const cursor = createMergeCursor();
    const log = logWithStalledIndex('BEEF', [put('a', 1000), put('b', 2000)], 1);
    const apply = async (): Promise<boolean> => true;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 5 passes over a permanently-stalled position: the cursor never advances, but
    // the journal must not be flooded — only the FIRST pass logs.
    for (let i = 0; i < 5; i++) {
      await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 10 });
    }

    expect(cursor.positions.get('BEEF')).toBe(1); // still pinned, five passes later
    expect(cursor.readStalls?.get('BEEF:1')).toBe(5); // counted every pass
    const stallWarnings = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('read stall'));
    expect(stallWarnings).toHaveLength(1); // throttled: 1st only, next at the 100th
  });

  it('a stall that CLEARS resets the streak, so a transient blip cannot masquerade as a wedged log', async () => {
    const cursor = createMergeCursor();
    const ops = [put('a', 1000), put('b', 2000), put('c', 3000)];
    let stalled = true; // index1 withholds on the first pass, then serves
    const log: AdmittedLog = {
      keyHex: 'CAFE',
      length: ops.length,
      get: async (i) => {
        if (i === 1 && stalled) return new Promise<never>(() => {});
        return ops[i] ?? null;
      },
    };
    const applied: string[] = [];
    const apply = async (op: OpEnvelope): Promise<boolean> => {
      applied.push(op.hbKey ?? '');
      return true;
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 15 });
    expect(cursor.readStalls?.get('CAFE:1')).toBe(1);

    stalled = false; // the peer starts serving the block
    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 15 });

    expect(applied).toEqual(['a', 'b', 'c']); // the whole log folded once it cleared
    expect(cursor.readStalls?.get('CAFE:1')).toBeUndefined(); // streak cleared on success
    expect(cursor.positions.get('CAFE')).toBe(3);
  });

  /**
   * WI-2141796 follow-up, found by USING the fix above in production. The first
   * stall line it emitted read `cb54460d98d8#7585` — and the papercusp cursor was
   * at 14796, because ONE LOG IS FOLDED BY MANY HARNESSES, each through its own
   * cursor at its own position (39 rows on that log, spanning 6467..15595). A line
   * naming only `<log>#<pos>` cannot say WHOSE cursor stalled, and the numbers are
   * close enough to invite correlating one harness's stall with another's position.
   *
   * TEETH: the label must reach the emitted line. Dropping `cursorTag` from the
   * template, or failing to thread `cursorLabel` through from the caller, fails the
   * first assertion. The second pins the ambiguity itself: two harnesses stalling on
   * the SAME log at DIFFERENT positions must produce distinguishable lines.
   */
  it('names the cursor OWNER in the stall line, so two harnesses folding the same log are distinguishable', async () => {
    const ops = [put('a', 1000), put('b', 2000), put('c', 3000)];
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void lines.push(String(m)));
    const apply = async (): Promise<boolean> => true;

    // Same log keyHex, two harnesses, stalling at DIFFERENT positions.
    await mergeAdmittedLogsIncremental([logWithStalledIndex('CB54460D98D8', ops, 1)], createMergeCursor(), {
      applyImpl: apply,
      getTimeoutMs: 15,
      cursorLabel: 'papercusp-workspace/papercusp',
    });
    await mergeAdmittedLogsIncremental([logWithStalledIndex('CB54460D98D8', ops, 2)], createMergeCursor(), {
      applyImpl: apply,
      getTimeoutMs: 15,
      cursorLabel: 'papercusp-workspace/hive-canary',
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[papercusp-workspace/papercusp]');
    expect(lines[0]).toContain('CB54460D98D8#1');
    expect(lines[1]).toContain('[papercusp-workspace/hive-canary]');
    expect(lines[1]).toContain('CB54460D98D8#2');
    // The whole point: the two lines are not confusable with each other.
    expect(lines[0]).not.toEqual(lines[1]);
  });

  it('omits the label cleanly when no cursorLabel is supplied, so the line stays well-formed', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void lines.push(String(m)));
    await mergeAdmittedLogsIncremental(
      [logWithStalledIndex('BEEF', [put('a', 1000), put('b', 2000)], 1)],
      createMergeCursor(),
      { applyImpl: async (): Promise<boolean> => true, getTimeoutMs: 15 },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[read-merge] read stall'); // no stray brackets or double space
    expect(lines[0]).toContain('BEEF#1');
  });
});
