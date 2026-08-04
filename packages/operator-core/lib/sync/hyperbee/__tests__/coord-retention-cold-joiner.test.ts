/**
 * coord-retention-cold-joiner.test.ts — plan
 * memory-corpus-hygiene-and-release-distribution-2026-08-03, item P-017.
 *
 * P-016/D-010 trims coord HISTORY out of a release seed by DELETING aged federated
 * `messages` rows: mig-150's `capture_coord_event_del_trg` turns each DELETE into a
 * `del` op, which the snapshot builder reconstitutes as a TOMBSTONE, and the
 * tombstone GCs out after `SNAPSHOT_TOMBSTONE_HORIZON_MS`. P-017 asks whether a peer
 * restoring from that trimmed seed still reconstitutes correct CURRENT coordination
 * state, and states the invariant as:
 *
 *     "Tombstone horizon must exceed the retention horizon, or a late-arriving stale
 *      PUT can resurrect a deleted key (EI-1688)."
 *
 * ⚠ THAT INVARIANT AS STATED IS A CATEGORY ERROR, AND THIS FILE IS THE EXECUTABLE
 * PROOF (see D-024). The two horizons are measured from DIFFERENT ORIGINS and are
 * never compared:
 *   - the RETENTION horizon is an age threshold on the ROW (delete it once it is
 *     older than N days);
 *   - the TOMBSTONE horizon is measured from the DEL, and `capture_substrate_outbox`
 *     stamps a del with `now()` + a fresh `hlc_now()` ("a del is its own event"),
 *     NOT with the deleted row's stale ts/fed_hlc.
 * So EVERY tombstone gets the FULL horizon starting at its delete, no matter how old
 * the row was. Raising the retention horizon above the tombstone horizon does not
 * shorten anyone's protection, and the real correctness condition is the one stated
 * in log-snapshot.ts: horizon >= the max partition-heal delay.
 *
 * The load-bearing property is therefore the FRESH DEL STAMP, not any ordering
 * between the two constants. `capture-outbox-wire-ts.integration.test.ts` guards it
 * at the capture boundary ("DELETE: the del op keeps a fresh capture-time ts"); this
 * file guards what that buys at the SNAPSHOT boundary, and includes the
 * born-expired CONTROL showing what breaks if a future change ever threads the row's
 * own ts onto a del — the plausible-looking change that would make P-017's stated
 * invariant true by making the system wrong.
 */
import { describe, it, expect } from 'vitest';
import { buildSnapshotRows, SNAPSHOT_TOMBSTONE_HORIZON_MS } from '../log-snapshot';
import type { PeerLogOp } from '../peer-log';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Every coord surface federates through the SAME capture function, so messages,
 * handoffs and escalations all ride table `coord_event_log` keyed by `msg_id`
 * (TG_TABLE_NAME / TG_ARGV[0] in `capture_substrate_outbox`). That shared table with
 * DISTINCT keys is why deleting a message cannot disturb a handoff.
 */
const T = 'coord_event_log';

function put(msgId: string, value: unknown, ts: number): PeerLogOp {
  return { type: 'put', table: T, hbKey: msgId, value, ts, schema_version: 1, author_pubkey: 'me' };
}
/** A del as the real capture trigger emits it: stamped with the DELETE's clock. */
function del(msgId: string, deletedAt: number): PeerLogOp {
  return { type: 'del', table: T, hbKey: msgId, ts: deletedAt, schema_version: 1, author_pubkey: 'me' };
}

const NOW = 1_800_000_000_000;
const byKey = (rows: ReturnType<typeof buildSnapshotRows>) =>
  Object.fromEntries(rows.map((r) => [r.hbKey, r]));

describe('P-017 — a cold joiner restoring from a TRIMMED seed', () => {
  it('still reconstitutes live coordination state; only the swept messages are tombstoned', () => {
    // The sweep is scoped to `surface = 'messages'` (message-log-gc.ts, both the base
    // CTE and the DELETE), so live coordination state is never a victim. Handoffs and
    // escalations are LIVE STATE with their own lifecycle collectors.
    const ops: PeerLogOp[] = [
      put('msg-aged-a', { kind: 'message', text: 'old chatter' }, NOW - 40 * DAY),
      put('msg-aged-b', { kind: 'message', text: 'older chatter' }, NOW - 60 * DAY),
      put('msg-recent', { kind: 'message', text: 'still inside retention' }, NOW - 1 * DAY),
      put('handoff-open', { kind: 'handoff', accepted: false }, NOW - 45 * DAY),
      put('escalation-unacked', { kind: 'escalation', resolved: false }, NOW - 50 * DAY),
      // The retention sweep runs NOW and deletes only the two fully-aged messages.
      del('msg-aged-a', NOW),
      del('msg-aged-b', NOW),
    ];

    const rows = byKey(buildSnapshotRows(ops, { now: NOW }));

    // LIVE STATE SURVIVES INTACT — this is P-017's actual acceptance. Note both are
    // FAR older than the messages that were swept: age is not what protects them,
    // surface scoping is.
    expect(rows['handoff-open']).toMatchObject({ value: { kind: 'handoff', accepted: false } });
    expect(rows['handoff-open'].deleted).toBeUndefined();
    expect(rows['escalation-unacked']).toMatchObject({ value: { kind: 'escalation', resolved: false } });
    expect(rows['escalation-unacked'].deleted).toBeUndefined();
    expect(rows['msg-recent']).toMatchObject({ value: { kind: 'message', text: 'still inside retention' } });

    // The swept messages are TOMBSTONES, not omissions — the joiner learns they were
    // deleted, which is what defeats a later stale PUT.
    expect(rows['msg-aged-a']).toMatchObject({ deleted: true, value: null });
    expect(rows['msg-aged-b']).toMatchObject({ deleted: true, value: null });

    // Their bodies are gone from the seed — the trim actually trimmed.
    expect(JSON.stringify(rows['msg-aged-a'])).not.toContain('old chatter');
  });

  it('the tombstone out-clocks the stale PUT it must defeat (the EI-1688 winner-gate precondition)', () => {
    const rows = byKey(
      buildSnapshotRows([put('msg-aged-a', { v: 1 }, NOW - 60 * DAY), del('msg-aged-a', NOW)], { now: NOW }),
    );
    // A peer that federates its surviving 60-day-old PUT after the joiner seeds loses:
    // the tombstone carries the DEL's clock, which is strictly later.
    expect(rows['msg-aged-a'].ts).toBeGreaterThan(NOW - 60 * DAY);
    expect(rows['msg-aged-a'].ts).toBe(NOW);
  });
});

describe('P-017 — WHY it holds: the fresh del stamp, not a horizon ordering', () => {
  it('an ancient row deleted NOW still gets the FULL tombstone horizon', () => {
    // Row is 60 days old — far past BOTH the 7d federated and 30d operator horizons,
    // and past the 14d tombstone horizon too. None of that matters: the del is its
    // own event, so the tombstone is 0 days old and survives the whole horizon.
    const ops = [put('msg-ancient', { v: 1 }, NOW - 60 * DAY), del('msg-ancient', NOW)];

    const atCut = byKey(buildSnapshotRows(ops, { now: NOW }));
    expect(atCut['msg-ancient']).toMatchObject({ deleted: true });

    // Still protected one hour before the horizon expires...
    const justInside = buildSnapshotRows(ops, { now: NOW + SNAPSHOT_TOMBSTONE_HORIZON_MS - 3_600_000 });
    expect(byKey(justInside)['msg-ancient']).toMatchObject({ deleted: true });

    // ...and only then does it GC back to omitted, a full horizon AFTER the delete.
    const past = buildSnapshotRows(ops, { now: NOW + SNAPSHOT_TOMBSTONE_HORIZON_MS + 1 });
    expect(past).toEqual([]);
  });

  it('CONTROL: threading the ROW ts onto the del makes the tombstone BORN EXPIRED', () => {
    // This is the change that would make P-017's stated invariant true — by breaking
    // the system. If a future edit ever "corrects" the del to carry the deleted row's
    // own ts/fed_hlc (superficially tidy: the op then matches the row it came from),
    // then a row older than the tombstone horizon tombstones into a row that is
    // ALREADY past the GC cutoff, and is dropped in the very snapshot that created it.
    const rowTs = NOW - 60 * DAY;
    const bornExpired = buildSnapshotRows(
      [put('msg-ancient', { v: 1 }, rowTs), del('msg-ancient', /* WRONG: the row's ts */ rowTs)],
      { now: NOW },
    );
    // No tombstone at all — the key silently reverts to omitted, so a joiner seeded
    // from this snapshot has NO record the key was ever deleted and a surviving peer's
    // stale PUT resurrects it. Protection would then genuinely depend on
    // tombstoneHorizon > retentionHorizon, exactly as P-017 assumed.
    expect(bornExpired).toEqual([]);

    // The real emitter avoids this for ANY row age, which is the whole point.
    expect(byKey(buildSnapshotRows(
      [put('msg-ancient', { v: 1 }, rowTs), del('msg-ancient', NOW)], { now: NOW },
    ))['msg-ancient']).toMatchObject({ deleted: true });
  });

  it('raising retention ABOVE the tombstone horizon does not shorten protection', () => {
    // The refutation of the stated invariant, stated as a test. Retention = 30d
    // (operator horizon) is LONGER than the 14d tombstone horizon. Under P-017's
    // premise that ordering resurrects keys; in fact the tombstone is unaffected,
    // because it is clocked from the delete.
    const retentionDays = 30;
    const rowTs = NOW - retentionDays * DAY;
    const rows = byKey(buildSnapshotRows([put('m', { v: 1 }, rowTs), del('m', NOW)], { now: NOW }));
    expect(rows['m']).toMatchObject({ deleted: true, ts: NOW });
    expect(retentionDays * DAY).toBeGreaterThan(SNAPSHOT_TOMBSTONE_HORIZON_MS);
  });
});
