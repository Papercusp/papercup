import { describe, it, expect } from 'vitest';
import {
  produceLogSnapshot,
  produceFilteredSnapshotIntoLog,
  SnapshotRowFolder,
  isSnapshotOp,
  type SnapshotPayload,
} from '../log-snapshot';
import type { OwnLog, PeerLogOp } from '../peer-log';

/**
 * EI-20108164746219771 — the SERVER installer ships the build box owner's identity.
 *
 * The seed corestore bundled by `tauri.server.conf.json` carried live `presence`
 * rows keyed by `<github_user_id>/<machine_label>`, so every published SERVER
 * artifact on every platform disclosed the owner's hostname, OS username and
 * GitHub ids to whoever downloaded it.
 *
 * These tests pin the fold-time exclusion that removes them at the source.
 *
 * ── WHY THE SNAPSHOT-EXPANSION CASE IS THE ONE THAT MATTERS ──────────────────
 * The obvious test — "a raw `put` to an excluded table is dropped" — would pass
 * against a filter that is USELESS in production. Measured 2026-08-11 against the
 * committed seed: its 45 shipped blocks are ENTIRELY a 45-chunk snapshot set
 * (snapshotChunks=45, rawOps=0). So in the real artifact the leaking rows never
 * arrive as raw ops at all; they arrive as rows expanded out of a PRIOR snapshot.
 * A filter applied only to the put/del branch would therefore be green on the
 * obvious test and still ship every identity row. `should drop excluded tables
 * when the source log is ITSELF a snapshot` is the test that can actually fail.
 */

function put(table: string, hbKey: string, value: unknown, ts: number): PeerLogOp {
  return { type: 'put', table, hbKey, value, ts, schema_version: 1, author_pubkey: 'me' };
}
function del(table: string, hbKey: string, ts: number): PeerLogOp {
  return { type: 'del', table, hbKey, ts, schema_version: 1, author_pubkey: 'me' };
}

function memLog(keyHex: string): OwnLog {
  const ops: PeerLogOp[] = [];
  return {
    get keyHex() {
      return keyHex;
    },
    get length() {
      return ops.length;
    },
    async append(op: PeerLogOp) {
      ops.push(op);
    },
    async appendBatch(batch: PeerLogOp[]) {
      ops.push(...batch);
    },
    async get(i: number) {
      return ops[i] ?? null;
    },
  } as unknown as OwnLog;
}

/** Collect every row carried by the snapshot set anchored at `coversUpTo`. */
async function rowsOfSetAt(log: OwnLog, coversUpTo: number, chunkCount: number) {
  const rows: { table: string; hbKey: string }[] = [];
  for (let j = 0; j < chunkCount; j++) {
    const op = await log.get(coversUpTo + j);
    if (!op || !isSnapshotOp(op)) throw new Error(`no snapshot chunk at ${coversUpTo + j}`);
    for (const r of (op.value as SnapshotPayload).rows) {
      rows.push({ table: r.table, hbKey: r.hbKey });
    }
  }
  return rows;
}

/**
 * A SYNTHETIC stand-in for the leaking row's shape — deliberately NOT the real
 * build box's github id or hostname.
 *
 * Pinning the actual literals here would have put the exact strings this fix
 * removes from the product back into shipped source, where `check-no-identity-
 * literals` reds the green-checkpoint gate and freezes `main` fleet-wide. (I wrote
 * them in on the first draft and the pre-write hook caught it — the same trap the
 * identity-gate test avoided by DERIVING its sentinel rather than hardcoding one.)
 *
 * The shape is what matters to the fold: `presence` is keyed
 * `<github_user_id>/<machine_label>`, and the filter keys off `table`, never the
 * value — so a synthetic id exercises exactly the same path.
 */
const SYNTHETIC_GITHUB_ID = '4242424242';
const SYNTHETIC_MACHINE_LABEL = 'synthetic-test-host-not-a-real-machine';
const IDENTITY_ROW = {
  table: 'presence',
  hbKey: `${SYNTHETIC_GITHUB_ID}/${SYNTHETIC_MACHINE_LABEL}`,
};

describe('SnapshotRowFolder excludeTables (EI-20108164746219771)', () => {
  it('defaults to excluding NOTHING — the live path must be unchanged', () => {
    const folder = new SnapshotRowFolder();
    folder.add(put('presence', IDENTITY_ROW.hbKey, { github_user_id: 1567022 }, 1));
    folder.add(put('plans', 'p1', { title: 'x' }, 2));
    const tables = folder.finish({ now: 10 }).map((r) => r.table).sort();
    expect(tables).toEqual(['plans', 'presence']);
  });

  it('drops excluded tables arriving as raw put/del ops', () => {
    const folder = new SnapshotRowFolder({ excludeTables: ['presence', 'usage'] });
    folder.add(put('presence', IDENTITY_ROW.hbKey, { github_user_id: 1567022 }, 1));
    folder.add(put('usage', 'u1', { tokens: 5 }, 2));
    folder.add(del('presence', 'other/host', 3));
    folder.add(put('plans', 'p1', { title: 'x' }, 4));
    folder.add(del('plans', 'p2', 5));

    const rows = folder.finish({ now: 10 });
    expect(rows.map((r) => r.table)).toEqual(['plans', 'plans']);
    // The surviving tombstone still reads as a delete — exclusion must not disturb
    // the tombstone semantics EI-1688 depends on.
    expect(rows.find((r) => r.hbKey === 'p2')?.deleted).toBe(true);
  });

  it('keeps hive-members, which the seed REQUIRES and the owner authorised', () => {
    // Guards against over-filtering: the membership roster is identity-bearing but
    // is intended content, unlike presence/usage. Widening the exclusion set to
    // "anything with an id in it" would break seeding.
    const folder = new SnapshotRowFolder({ excludeTables: ['presence', 'usage'] });
    folder.add(put('hive-members', 'm1', { github_user_id: 1567022 }, 1));
    expect(folder.finish({ now: 10 }).map((r) => r.table)).toEqual(['hive-members']);
  });

  it('drops excluded tables when the source log is ITSELF a snapshot (the shipped-seed shape)', async () => {
    const log = memLog('src');
    await log.append(put('plans', 'p1', { title: 'keep me' }, 1));
    await log.append(put('presence', IDENTITY_ROW.hbKey, { github_user_id: 1567022 }, 2));
    await log.append(put('usage', 'u1', { tokens: 5 }, 3));

    // Snapshot with NO filter: this is what the committed seed corestore contains.
    const first = await produceLogSnapshot(log, { now: 1000, schemaVersion: 1 });
    expect(first.appended).toBe(true);
    const firstRows = await rowsOfSetAt(log, first.coversUpTo, first.chunkCount);
    expect(firstRows.some((r) => r.table === 'presence')).toBe(true);

    // Re-snapshot WITH the filter. Every row now reaches the folder ONLY via
    // snapshot expansion — the branch the real artifact exercises.
    const second = await produceLogSnapshot(log, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence', 'usage'],
    });
    expect(second.appended).toBe(true);

    const secondRows = await rowsOfSetAt(log, second.coversUpTo, second.chunkCount);
    expect(secondRows.some((r) => r.table === 'presence')).toBe(false);
    expect(secondRows.some((r) => r.table === 'usage')).toBe(false);
    expect(secondRows.some((r) => r.table === 'plans')).toBe(true);
  });

  it('leaves no trace of the excluded identity string anywhere in the emitted bytes', async () => {
    // The end-to-end property the release identity gate scans for. Asserting on the
    // serialized set (not the row list) is deliberate: a row could be dropped from
    // `rows` while the identity survived in some other field of the payload.
    const log = memLog('src');
    await log.append(put('plans', 'p1', { title: 'keep me' }, 1));
    await log.append(
      put('presence', IDENTITY_ROW.hbKey, { machine_label: SYNTHETIC_MACHINE_LABEL }, 2),
    );
    const unfiltered = await produceLogSnapshot(log, { now: 1000, schemaVersion: 1 });

    const serializeSet = async (r: { coversUpTo: number; chunkCount: number }) =>
      JSON.stringify(
        await Promise.all(
          Array.from({ length: r.chunkCount }, (_, j) => log.get(r.coversUpTo + j)),
        ),
      );

    // CONTROL FIRST — the unfiltered set MUST carry the identity. Without this the
    // assertions below would pass against a filter that does nothing at all (and
    // against a typo'd table name, which is the likelier real-world mistake).
    const unfilteredBytes = await serializeSet(unfiltered);
    expect(unfilteredBytes).toContain(SYNTHETIC_MACHINE_LABEL);
    expect(unfilteredBytes).toContain(SYNTHETIC_GITHUB_ID);

    const filtered = await produceLogSnapshot(log, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence', 'usage'],
    });
    const bytes = await serializeSet(filtered);
    expect(bytes).not.toContain(SYNTHETIC_MACHINE_LABEL);
    expect(bytes).not.toContain(SYNTHETIC_GITHUB_ID);
  });
});

describe('produceFilteredSnapshotIntoLog — the synthetic seed core (EI-20108164746219771)', () => {
  /** A source log in the shape the real seed has: content already folded into a snapshot. */
  async function sourceInShippedSeedShape() {
    const src = memLog('source-own-log');
    await src.append(put('plans', 'p1', { title: 'keep me' }, 1));
    await src.append(put('presence', IDENTITY_ROW.hbKey, { machine_label: SYNTHETIC_MACHINE_LABEL }, 2));
    await src.append(put('usage', 'u1', { tokens: 5 }, 3));
    await produceLogSnapshot(src, { now: 1000, schemaVersion: 1 });
    return src;
  }

  it('NEVER writes the source log — the whole reason this function exists', async () => {
    const src = await sourceInShippedSeedShape();
    const lengthBefore = src.length;
    const target = memLog('synthetic-seed-core');

    await produceFilteredSnapshotIntoLog(src, target, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence', 'usage'],
    });

    // Filtering in place would make historical `usage` unreachable for every live
    // reader folding forward from the newest snapshot. The source must be untouched.
    expect(src.length).toBe(lengthBefore);
    expect(target.length).toBeGreaterThan(0);
  });

  it('anchors coversUpTo to the TARGET position, so the set is findable where the reader looks', async () => {
    const src = await sourceInShippedSeedShape();
    const target = memLog('synthetic-seed-core');

    const res = await produceFilteredSnapshotIntoLog(src, target, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence', 'usage'],
    });

    // A fresh core ⇒ the set begins at 0, NOT at the source's length. Anchoring to
    // the source would be readable but unfindable (WI-37526).
    expect(res.coversUpTo).toBe(0);
    expect(res.coversUpTo).not.toBe(src.length);

    // Every chunk present at [coversUpTo, coversUpTo + chunkCount), which is the span
    // verifySnapshotSet scans.
    for (let j = 0; j < res.chunkCount; j++) {
      const op = await target.get(res.coversUpTo + j);
      expect(op && isSnapshotOp(op)).toBe(true);
      expect((op!.value as SnapshotPayload).coversUpTo).toBe(res.coversUpTo);
    }
  });

  it('carries the intended content and none of the identity', async () => {
    const src = await sourceInShippedSeedShape();
    const target = memLog('synthetic-seed-core');

    const res = await produceFilteredSnapshotIntoLog(src, target, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence', 'usage'],
    });

    const rows = await rowsOfSetAt(target, res.coversUpTo, res.chunkCount);
    expect(rows.some((r) => r.table === 'plans')).toBe(true);
    expect(rows.some((r) => r.table === 'presence')).toBe(false);
    expect(rows.some((r) => r.table === 'usage')).toBe(false);

    const bytes = JSON.stringify(
      await Promise.all(
        Array.from({ length: res.chunkCount }, (_, j) => target.get(res.coversUpTo + j)),
      ),
    );
    expect(bytes).not.toContain(SYNTHETIC_MACHINE_LABEL);
    expect(bytes).not.toContain(SYNTHETIC_GITHUB_ID);
  });

  it('re-authors only the ENVELOPE — rows keep their original author_pubkey', async () => {
    // Row-level author_pubkey is bound into the epoch-decrypt AAD, so rewriting it
    // would make encrypted content undecryptable for a seeded joiner (WI-808 / the
    // seed-57-drop sibling). Only the snapshot op itself is authored by the new core.
    const src = memLog('source-own-log');
    await src.append(put('plans', 'p1', { title: 'keep me' }, 1));
    const target = memLog('synthetic-seed-core');

    const res = await produceFilteredSnapshotIntoLog(src, target, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence'],
    });

    const chunk = await target.get(res.coversUpTo);
    expect(chunk!.author_pubkey).toBe('synthetic-seed-core');
    expect((chunk!.value as SnapshotPayload).rows[0]!.author_pubkey).toBe('me');
  });

  it('reports appended:false for an empty source rather than claiming a set it never wrote', async () => {
    const src = memLog('source-own-log');
    const target = memLog('synthetic-seed-core');
    const res = await produceFilteredSnapshotIntoLog(src, target, { now: 2000, schemaVersion: 1 });
    expect(res.appended).toBe(false);
    expect(res.chunkCount).toBe(0);
    expect(target.length).toBe(0);
  });

  it('DOES append an empty snapshot when a non-empty source folds to zero rows', async () => {
    // The deliberate other half of the rule above. "No source at all" and "a real hive
    // whose every row was excluded" are different facts and must seed differently:
    // the second is a legitimate empty-content seed, the first is nothing to seed from.
    // Pinned because `chunkSnapshotRows([])` returns one empty chunk, so the two cases
    // are trivially easy to collapse into whichever the implementation happens to do.
    const src = memLog('source-own-log');
    await src.append(put('presence', IDENTITY_ROW.hbKey, { machine_label: SYNTHETIC_MACHINE_LABEL }, 1));
    const target = memLog('synthetic-seed-core');

    const res = await produceFilteredSnapshotIntoLog(src, target, {
      now: 2000,
      schemaVersion: 1,
      excludeTables: ['presence'],
    });

    expect(res.appended).toBe(true);
    expect(res.rowCount).toBe(0);
    expect(target.length).toBe(res.chunkCount);
    const bytes = JSON.stringify(await target.get(res.coversUpTo));
    expect(bytes).not.toContain(SYNTHETIC_MACHINE_LABEL);
  });
});
