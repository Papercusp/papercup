/**
 * logs:read payload-tier shaper — EI-20203342112661815.
 *
 * The defect being pinned is NOT "the payload was large". It is that `limit`
 * bounds rows while the generic result door bounds bytes, and the door cuts an
 * over-long array by keeping its HEAD — so a 120-row read of a chatty unit came
 * back as 12 entries that were the OLDEST of the window, silently inverting the
 * newest-kept guarantee `journal-read.ts` documents and implements
 * (`merged.slice(-limit - 1)`). A forensic read then looks successful while
 * handing back the least relevant end of the window.
 *
 * So the load-bearing assertions here are the ORDER-SENSITIVE ones: which rows
 * survive, and in which direction. A test that only checked "payload got
 * smaller" would pass just as happily against the broken head-keeping behaviour.
 */
import { describe, expect, it } from 'vitest';
import { LOGS_READ_TIER_CAPS, shapeLogsRead } from './read-shape';

type Entry = Record<string, unknown>;
type Shaped = { entries: Entry[]; payloadBounded?: Record<string, unknown> } & Record<string, unknown>;

/** `n` entries in ascending (oldest→newest) order, as readJournal returns them. */
function entries(n: number, messageLen = 500): Entry[] {
  return Array.from({ length: n }, (_, i) => ({
    unit: 'papercusp-dev-api.service',
    ts: `2026-09-05T07:${String(i % 60).padStart(2, '0')}:00.000Z`,
    level: 'info',
    repeat: 1,
    // The index is embedded so a test can identify WHICH rows survived.
    message: `entry-${String(i).padStart(4, '0')} ${'x'.repeat(messageLen)}`,
  }));
}

const seqOf = (rows: Entry[]): number[] =>
  rows
    .filter((r) => !r._truncated)
    .map((r) => Number(/entry-(\d+)/.exec(String(r.message))?.[1] ?? NaN));

const entriesChars = (rows: Entry[]): number =>
  rows.filter((r) => !r._truncated).reduce((n, r) => n + JSON.stringify(r).length + 1, 0);

describe('shapeLogsRead — keeps the NEWEST rows (the inversion this fixes)', () => {
  it('drops the OLDEST rows, never the newest', () => {
    const all = entries(120);
    const out = shapeLogsRead({ entries: all, matched: 121, truncated: true }, 'trimmed') as Shaped;
    const kept = seqOf(out.entries);

    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(120);
    // The single assertion that fails against head-keeping: the last row of the
    // input must survive, and the first must not.
    expect(kept).toContain(119);
    expect(kept).not.toContain(0);
    expect(Math.min(...kept)).toBeGreaterThan(0);
  });

  it('returns the kept rows in ascending order, as callers already parse them', () => {
    const out = shapeLogsRead({ entries: entries(120) }, 'trimmed') as Shaped;
    const kept = seqOf(out.entries);
    expect(kept).toEqual([...kept].sort((a, b) => a - b));
  });

  it('keeps a CONTIGUOUS newest-end window (no holes in the middle)', () => {
    const out = shapeLogsRead({ entries: entries(120) }, 'trimmed') as Shaped;
    const kept = seqOf(out.entries);
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => 119 - kept.length + 1 + i));
  });
});

/**
 * PERMANENT FALSIFIABILITY CONTROL.
 *
 * A guard that has never failed is a guard nobody has tested, and every
 * assertion above passes trivially if the shaper simply returns fewer rows. What
 * makes them meaningful is that they REJECT the specific wrong behaviour this
 * fix removes — the generic result door's head-keeping. So that wrong behaviour
 * is kept here as a deliberately-incorrect reference implementation, per the
 * repo's mutation-probe guidance for an imported subject (mutate a control, never
 * the shared tree). If a future refactor reintroduces head-keeping, the real
 * subject starts behaving like `keepHeadLikeTheDoorDid` and the calibration case
 * below fails.
 */
function keepHeadLikeTheDoorDid(data: { entries: Entry[] }, keep: number): { entries: Entry[] } {
  return { entries: data.entries.slice(0, keep) };
}

describe('shapeLogsRead — falsifiability control (the assertions discriminate)', () => {
  const all = entries(120);
  const survivingRows = (out: Shaped) => seqOf(out.entries);
  /** The load-bearing assertion pair, as a predicate. */
  const newestKept = (kept: number[]) => kept.includes(119) && !kept.includes(0);

  it('CALIBRATION — the real subject satisfies the assertion', () => {
    expect(newestKept(survivingRows(shapeLogsRead({ entries: all }, 'trimmed') as Shaped))).toBe(true);
  });

  it('CONTROL — the old head-keeping behaviour FAILS the same assertion', () => {
    const keep = survivingRows(shapeLogsRead({ entries: all }, 'trimmed') as Shaped).length;
    // Same row COUNT as the real shaper, so the control isolates ORDER alone —
    // a test that only counted rows would pass here, which is the point.
    const mutant = seqOf(keepHeadLikeTheDoorDid({ entries: all }, keep).entries);
    expect(mutant.length).toBe(keep);
    expect(newestKept(mutant)).toBe(false);
  });
});

describe('shapeLogsRead — the budget is in BYTES, which is the actual defect', () => {
  it('bounds the serialized payload when messages are long', () => {
    const out = shapeLogsRead({ entries: entries(120, 500) }, 'trimmed') as Shaped;
    expect(entriesChars(out.entries)).toBeLessThanOrEqual(LOGS_READ_TIER_CAPS.trimmed.entriesChars);
  });

  it('a ROW cap alone would NOT have bounded it — positive control for the fix', () => {
    // The same rows under a plausible row-only cap (maxEntries, with no char
    // budget) blow the budget by a wide margin. This is what makes the char
    // budget load-bearing rather than decorative: capping rows harder would
    // reproduce the original bug one notch lower.
    const rowCapped = entries(120, 500).slice(-LOGS_READ_TIER_CAPS.trimmed.maxEntries);
    expect(entriesChars(rowCapped)).toBeGreaterThan(LOGS_READ_TIER_CAPS.trimmed.entriesChars * 3);
  });

  it('adapts the row count to message size — few long rows, many short ones', () => {
    const long = shapeLogsRead({ entries: entries(120, 500) }, 'trimmed') as Shaped;
    const short = shapeLogsRead({ entries: entries(120, 5) }, 'trimmed') as Shaped;
    expect(seqOf(short.entries).length).toBeGreaterThan(seqOf(long.entries).length);
  });

  it('clips an over-long message and marks it', () => {
    const out = shapeLogsRead({ entries: entries(3, 5_000) }, 'trimmed') as Shaped;
    const row = out.entries.filter((r) => !r._truncated).at(-1)!;
    expect(String(row.message).length).toBeLessThanOrEqual(LOGS_READ_TIER_CAPS.trimmed.message);
    expect(row.clipped).toBe(true);
  });

  it('still returns one row when a single row exceeds the whole budget', () => {
    // An empty entries[] reads exactly like a clean window, which is the
    // misreading logs:read's five-way empty-result diagnosis exists to prevent.
    const out = shapeLogsRead({ entries: entries(1, 50_000) }, 'trimmed') as Shaped;
    expect(seqOf(out.entries).length).toBe(1);
  });
});

describe('shapeLogsRead — the cut is stamped, and stamped at the right end', () => {
  it('puts the omission marker at the HEAD, where the missing rows are', () => {
    const out = shapeLogsRead({ entries: entries(120) }, 'trimmed') as Shaped;
    expect(out.entries[0]._truncated).toBe(true);
    expect(String(out.entries[0].message)).toMatch(/OLDER/);
    expect(out.entries.slice(1).some((r) => r._truncated)).toBe(false);
  });

  it('reports honest counts that add up', () => {
    const out = shapeLogsRead({ entries: entries(120) }, 'trimmed') as Shaped;
    const pb = out.payloadBounded!;
    expect(pb.ofEntries).toBe(120);
    expect(Number(pb.showingEntries) + Number(pb.droppedOldest)).toBe(120);
    expect(Number(pb.entriesChars)).toBeLessThanOrEqual(Number(pb.budgetChars));
  });

  it('is distinct from `truncated`, which means the row-limit cut', () => {
    // Conflating the two would hide a byte-budget cut behind a flag the caller
    // already expects to see set for an unrelated reason.
    const out = shapeLogsRead({ entries: entries(120), truncated: true }, 'trimmed') as Shaped;
    expect(out.truncated).toBe(true);
    expect(out.payloadBounded).toBeDefined();
  });

  it('adds no marker and no payloadBounded when everything fits', () => {
    const out = shapeLogsRead({ entries: entries(3, 20) }, 'trimmed') as Shaped;
    expect(out.payloadBounded).toBeUndefined();
    expect(out.entries.some((r) => r._truncated)).toBe(false);
    expect(seqOf(out.entries)).toEqual([0, 1, 2]);
  });
});

describe('shapeLogsRead — preserves the non-entry envelope (NOT an allowlist)', () => {
  it('keeps every diagnosis field a reader needs to interpret the result', () => {
    // ../locks/list-shape.ts carries two recorded repairs where an allowlist
    // silently dropped fields added upstream. These five fields are exactly the
    // ones that stop a reader misreading an empty or partial result.
    const envelope = {
      entries: entries(120),
      matched: 121,
      collapsed: 4,
      truncated: true,
      window: { since: '-2 hours', resolved: { sinceUtc: '2026-09-05T05:00:00Z' } },
      units: ['papercusp-dev-api.service'],
      unitsUnknown: ['typo.service'],
      unitsHistorical: ['gone.service'],
      historicalCommand: 'journalctl …',
      windowOutsideJournal: { aheadByMs: 1_000 },
      journalAvailable: true,
      journalError: null,
      command: 'journalctl -u papercusp-dev-api.service',
    };
    const out = shapeLogsRead(envelope, 'trimmed') as Shaped;
    for (const [k, v] of Object.entries(envelope)) {
      if (k === 'entries') continue;
      expect(out[k]).toEqual(v);
    }
  });

  it('passes through a payload with no entries[] untouched', () => {
    const clean = { entries: [], matched: 0, journalError: null };
    expect(shapeLogsRead(clean, 'trimmed')).toBe(clean);
    expect(shapeLogsRead(null, 'trimmed')).toBeNull();
  });

  it('standard tier keeps strictly more than trimmed', () => {
    const rows = entries(200, 500);
    const t = seqOf((shapeLogsRead({ entries: rows }, 'trimmed') as Shaped).entries).length;
    const s = seqOf((shapeLogsRead({ entries: rows }, 'standard') as Shaped).entries).length;
    expect(s).toBeGreaterThan(t);
  });
});
