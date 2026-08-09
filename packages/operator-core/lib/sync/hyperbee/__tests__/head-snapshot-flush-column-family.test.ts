/**
 * EI-20019309044931698 — recurrence guard for the head-snapshot durability flush.
 *
 * THE TRAP THIS EXISTS TO CATCH: hypercore-storage exposes BOTH `storage.flush()` and
 * `storage.db.flush()`, and only the second one flushes hypercore's data. A
 * rocksdb-native flush is scoped to the column family of the session it is called on
 * (rocksdb-native/lib/state.js — `binding.flush(this._handle, db._columnFamily._handle,
 * …)`). The root `rocks` session is pinned to the **'default'** column family, while all
 * hypercore data lives in the **'corestore'** one (hypercore-storage: COLUMN_FAMILY =
 * 'corestore'). So `storage.flush()` typechecks, runs without error, and flushes
 * NOTHING — a silent no-op that would only surface as a failed release cut ~1h in.
 *
 * The original filing proposed exactly that no-op call as the fix, which is why this
 * distinction is pinned behaviourally against a REAL corestore rather than left to a
 * code comment.
 *
 * NOTE ON WHAT IS *NOT* GUARDED HERE: the filing also proposed asserting that "a fresh
 * read-only open must resolve the just-appended snapshot". That assertion is NOT
 * falsifiable against this defect — it already passes with no flush at all, because a
 * read-only RocksDB open uses walRecoveryMode POINT_IN_TIME and replays the WAL. A guard
 * that passes both with and without the fix is worse than no guard, so it is deliberately
 * omitted. What the flush actually buys is independence from the WAL segments a live
 * writer rotates underneath the cutter — hence the SST-level assertions below.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'head-snapshot-flush-'));
  dirs.push(d);
  return d;
}

function sstCount(root: string): number {
  try {
    return readdirSync(join(root, 'db')).filter((f) => f.endsWith('.sst')).length;
  } catch {
    return 0;
  }
}

/** Append enough to have something worth flushing, then report SSTs before/after `flush`. */
async function appendThenFlush(
  flush: (store: Corestore) => Promise<void>,
): Promise<{ before: number; after: number }> {
  const root = freshDir();
  const store = new Corestore(root);
  await store.ready();
  const core = store.get({ name: 'ownlog' }) as {
    ready(): Promise<void>;
    append(b: Buffer): Promise<unknown>;
  };
  await core.ready();
  for (let i = 0; i < 45; i++) await core.append(Buffer.alloc(64 * 1024, i));

  const before = sstCount(root);
  await flush(store);
  const after = sstCount(root);

  await store.close();
  return { before, after };
}

describe('head-snapshot durability flush: column family', () => {
  it('storage.db.flush() actually lands the appended blocks in SSTs', async () => {
    const { before, after } = await appendThenFlush((s) => s.storage.db.flush());
    // This is the property the on-demand head-snapshot path depends on: once the waiter
    // resolves with appended:true, those blocks must exist outside the WAL.
    expect(after).toBeGreaterThan(before);
  }, 60_000);

  it('CALIBRATION: a no-flush run leaves the data WAL-only (so the check above can fail)', async () => {
    // Without this arm, "SSTs appeared" would be unfalsifiable — SSTs could simply
    // always be present. Proves the measurement discriminates.
    const { before, after } = await appendThenFlush(async () => {});
    expect(after).toBe(before);
  }, 60_000);

  it('the root-session flush is a NO-OP for hypercore data (why .db is required)', async () => {
    // Pins the trap itself. `storage.flush()` is intentionally NOT declared in
    // holepunch.d.ts so it cannot compile — this asserts the runtime reason.
    // If a dependency upgrade ever makes this flush the 'corestore' family, this test
    // fails LOUDLY, which is the correct signal to re-evaluate (and possibly simplify).
    const { before, after } = await appendThenFlush(
      (s) => (s.storage as unknown as { flush(): Promise<void> }).flush(),
    );
    expect(after).toBe(before);
  }, 60_000);
});

describe('head-snapshot flush call site', () => {
  it('boot.ts flushes via storage.db.flush(), never the no-op root flush', () => {
    // Subject path is overridable so falsifiability can be proven against a COPY
    // outside the tree (scripts/mutation-probe.sh) — never by mutating the shared
    // working tree, which git-sync would sweep into a commit mid-probe.
    const subject = process.env.PROBE_BOOT_TS ?? join(__dirname, '..', 'boot.ts');
    const src = readFileSync(subject, 'utf8');
    expect(src).toContain('store.storage.db.flush()');
    // The no-op form must never appear as a real call. (`storage.flush()` inside a
    // comment is fine; this matches an actual awaited call.)
    expect(src).not.toMatch(/await\s+store\.storage\.flush\(\)/);
  });
});
