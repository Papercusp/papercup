/**
 * WI-37526 — the snapshot SET must land at the anchor it advertises.
 *
 * THE DEFECT THIS PINS. `produceLogSnapshot` captured `coversUpTo = ownLog.length`
 * BEFORE an O(history) read and appended the chunks AFTER it. Any op appended by a
 * concurrent writer in that window displaced the set, so the chunks landed at
 * `coversUpTo + delta` while still advertising `coversUpTo`. The reader locates a set
 * STRICTLY by span — `verifySnapshotSet` reads chunk j at `coversUpTo + j`
 * (read-merge.ts:437) and on a miss seeks BACKWARD past `coversUpTo` (L558) — so a set
 * displaced by even one block is unfindable FOREVER.
 *
 * Measured on the live 1.23M-block log 2026-08-10: a 43.7s read raced 55 appends; all
 * 45 chunks landed at [1232912, 1232957) advertising coversUpTo=1232857. Every chunk
 * was present, readable and correctly tagged, and the scan still said `none-in-window`
 * ⇒ computeSparseFrom returned 0 ⇒ the seed guard refused a full-history seed. That is
 * P-014's "sparse cut degrades to full history", and it cost ~6 release cuts.
 *
 * WHY IT LOOKED INTERMITTENT: a FAST snapshot races fewer appends and sometimes lands
 * at offset 0 by luck. So a guard that snapshots a quiet log passes while production
 * fails — the log MUST be mutated mid-read for this test to mean anything.
 *
 * FALSIFIABILITY (repo tier-1 discipline for an imported module): `produceWithoutConverging`
 * below is a permanently-resident reimplementation of the PRE-FIX shape. The same
 * assertion must FAIL against it, so a regression that removes convergence cannot leave
 * this file green. Plus a calibration case on a QUIET log, which both shapes must pass —
 * without it, a broken assertion would "catch" the control for the wrong reason.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSnapshotOpsFromRows,
  isSnapshotOp,
  produceLogSnapshot,
  SnapshotRowFolder,
  SNAPSHOT_READ_CONCURRENCY,
  type SnapshotPayload,
} from '../log-snapshot';

type AnyOp = Record<string, unknown>;

function dataOp(i: number): AnyOp {
  return {
    table: 'features-by-id',
    hbKey: `k${i}`,
    type: 'put',
    value: { i },
    ts: 1_700_000_000_000 + i,
    schema_version: 1,
  };
}

/**
 * An own-log double whose length GROWS while it is being read — the concurrent-writer
 * condition the production log is always under. `growAfterReads` appends `growBy` ops
 * once that many blocks have been read, i.e. strictly mid-read.
 */
function makeGrowingLog(initial: number, growAfterReads: number, growBy: number) {
  const blocks: AnyOp[] = Array.from({ length: initial }, (_, i) => dataOp(i));
  let reads = 0;
  let grown = false;
  return {
    keyHex: 'ab'.repeat(32),
    get length() {
      return blocks.length;
    },
    blocks,
    async get(i: number) {
      reads++;
      if (!grown && reads >= growAfterReads) {
        grown = true;
        for (let g = 0; g < growBy; g++) blocks.push(dataOp(10_000 + g));
      }
      return blocks[i] ?? null;
    },
    async appendBatch(ops: AnyOp[]) {
      blocks.push(...ops);
    },
  };
}

/** The PRE-FIX shape, kept deliberately wrong as the control. */
async function produceWithoutConverging(log: ReturnType<typeof makeGrowingLog>) {
  const coversUpTo = log.length; // captured BEFORE the read — the bug
  const folder = new SnapshotRowFolder();
  for (let start = 0; start < coversUpTo; start += SNAPSHOT_READ_CONCURRENCY) {
    const end = Math.min(start + SNAPSHOT_READ_CONCURRENCY, coversUpTo);
    const window = await Promise.all(
      Array.from({ length: end - start }, (_, k) => log.get(start + k)),
    );
    for (const op of window) if (op) folder.add(op as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const ops = buildSnapshotOpsFromRows({
    rows: folder.finish({ now: 1_700_000_100_000 }),
    coversUpTo,
    author_pubkey: log.keyHex,
    ts: 1_700_000_100_000,
    schema_version: 1,
  });
  await log.appendBatch(ops as AnyOp[]);
  return { coversUpTo, chunkCount: ops.length };
}

/** Does index `anchor` actually hold chunk 0 of the set advertising `anchor`? */
function setLandedAtAnchor(log: { blocks: AnyOp[] }, anchor: number): boolean {
  const op = log.blocks[anchor];
  if (!op || !isSnapshotOp(op as never)) return false;
  const p = (op as { value?: SnapshotPayload }).value;
  return p?.coversUpTo === anchor && p?.chunkIdx === 0;
}

describe('snapshot anchor convergence (WI-37526)', () => {
  it('CONTROL: the pre-fix shape displaces the set when the log grows mid-read', async () => {
    const log = makeGrowingLog(600, 300, 55);
    const res = await produceWithoutConverging(log);

    // The control must genuinely reproduce the defect, otherwise the real assertion
    // below proves nothing. The log really did grow, and the set is really misplaced.
    expect(log.length).toBeGreaterThan(res.coversUpTo + res.chunkCount);
    expect(setLandedAtAnchor(log, res.coversUpTo)).toBe(false);
  });

  it('the set lands EXACTLY at the coversUpTo it advertises, even when the log grows mid-read', async () => {
    const log = makeGrowingLog(600, 300, 55);
    const res = await produceLogSnapshot(log as never, {
      now: 1_700_000_100_000,
      schemaVersion: 1,
    });

    expect(res.appended).toBe(true);
    // The anchor must have advanced past the pre-read length — proving convergence ran
    // rather than the growth simply not happening.
    expect(res.coversUpTo).toBeGreaterThan(600);
    expect(setLandedAtAnchor(log, res.coversUpTo)).toBe(true);

    // and the WHOLE set is contiguous from the anchor, which is what the reader verifies
    for (let j = 0; j < res.chunkCount; j++) {
      const op = log.blocks[res.coversUpTo + j];
      expect(isSnapshotOp(op as never)).toBe(true);
      const p = (op as { value?: SnapshotPayload }).value;
      expect(p?.coversUpTo).toBe(res.coversUpTo);
      expect(p?.chunkIdx).toBe(j);
      expect(p?.chunkCount).toBe(res.chunkCount);
    }
  });

  it('CALIBRATION: a quiet log still produces a correctly anchored set', async () => {
    // No growth. Both shapes must pass this — it proves the assertion is not simply
    // always-false (which would make the control pass for the wrong reason).
    const log = makeGrowingLog(600, Number.MAX_SAFE_INTEGER, 0);
    const res = await produceLogSnapshot(log as never, {
      now: 1_700_000_100_000,
      schemaVersion: 1,
    });
    expect(res.appended).toBe(true);
    expect(res.coversUpTo).toBe(600);
    expect(setLandedAtAnchor(log, 600)).toBe(true);
  });

  it('REFUSES to report success for a set it could not anchor (never a silent bad snapshot)', async () => {
    // A pathological writer that appends on EVERY read, including the ones convergence
    // makes, so the anchor can never settle. The contract is a loud throw — reporting
    // appended:true here is the failure that cost ~6 cut attempts, because the producer
    // claims success and the consequence surfaces 40+ min later in the cut.
    const blocks: AnyOp[] = Array.from({ length: 300 }, (_, i) => dataOp(i));
    let appendedSet = false;
    const hostile = {
      keyHex: 'cd'.repeat(32),
      get length() {
        return blocks.length;
      },
      async get(i: number) {
        // Grow forever, so every convergence pass finds more work.
        if (!appendedSet) blocks.push(dataOp(90_000 + blocks.length));
        return blocks[i] ?? null;
      },
      async appendBatch(ops: AnyOp[]) {
        appendedSet = true;
        // Displace the set by one block — the minimum that breaks span lookup.
        blocks.push(dataOp(99_999));
        blocks.push(...ops);
      },
    };

    await expect(
      produceLogSnapshot(hostile as never, { now: 1_700_000_100_000, schemaVersion: 1 }),
    ).rejects.toThrow(/anchor race/i);
  });
});
