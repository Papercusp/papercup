/**
 * messages-inbox.integration.test.ts — `readInbox` recipient-pushdown against REAL
 * Postgres (baseline-schema DB). Coverage for the fleet-concurrency-first P-003 /
 * round4 D-005 fix.
 *
 * BEFORE: `readInbox` loaded the ENTIRE `messages` surface through
 * `coordLog.readLines('messages')` and filtered in JS — O(all messages ever sent),
 * re-transferring + JSON-parsing + allocating every envelope on the operator's
 * single event loop. It is the dominant `coord_event_log` call (every agent, every
 * turn: always-armed inbox-wake + orient + manual coord:inbox), so that per-call
 * cost is multiplied by fleet size — a direct concurrency limiter.
 *
 * AFTER: a PG recipient-pushdown returns only this owner's + broadcast rows
 * (`jsonb_typeof(to)='array' AND (to ? owner OR to ? '*')`), with `filterInbox`
 * STILL run as the final authority over the reduced set. The contract this test
 * pins: the pushdown output is BYTE-IDENTICAL to the authoritative full-surface
 * scan (`filterInbox(readLines('messages'))`) across owners + option combos, and
 * the SQL membership predicate exactly matches filterInbox's recipient+array
 * conditions (broadcast `*` included; non-array `to` excluded; own/notify/since/
 * kinds handled by filterInbox on the reduced set).
 *
 * The fixture keeps the real `PgCoordLog` seam (re-pointed at the baseline DB), so
 * `coordHasPgFastPath()` is true and the pushdown branch is the one exercised here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { filterInbox, type CoordEnvelope, type InboxOptions } from '@papercusp/coordination/core';
import { coordLog } from './log';
import { readInbox } from './messages';

let fx: BaselineCoordFixture;

/** Build + append one raw envelope directly to the messages surface — bypasses
 *  sendMessage's audience expansion / slot-parking so the seeded `to`/`from`/`kind`
 *  are stored EXACTLY as written (we are testing the read path, not delivery). */
async function seed(env: Partial<CoordEnvelope> & { msg_id: string; ts: string; from: string }): Promise<void> {
  const full = { kind: 'message', summary: env.msg_id, to: [], ...env } as unknown as CoordEnvelope;
  await coordLog.appendLine('messages', env.from, full);
}

/** The authoritative reference: full-surface scan + filterInbox, the path the
 *  pushdown must reproduce exactly. */
async function reference(owner: string, opts: InboxOptions = {}): Promise<CoordEnvelope[]> {
  return filterInbox(await coordLog.readLines('messages'), owner, opts);
}

const ids = (envs: CoordEnvelope[]): string[] => envs.map((e) => e.msg_id);

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
});
afterAll(async () => {
  await fx.admin`TRUNCATE harness_shared.coord_event_log`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await fx.admin`TRUNCATE harness_shared.coord_event_log`;
});

describe('readInbox recipient-pushdown (P-003 / D-005 SQL path)', () => {
  /** A representative spread: direct, broadcast, other-recipient, own outbox,
   *  notify, multi-recipient ack, and a malformed non-array `to`. */
  async function seedSpread(): Promise<void> {
    await seed({ msg_id: 'm1', ts: '2026-01-01T00:00:01.000Z', from: 'bob', to: ['alice'] });
    await seed({ msg_id: 'm2', ts: '2026-01-01T00:00:02.000Z', from: 'carol', to: ['*'] }); // broadcast
    await seed({ msg_id: 'm3', ts: '2026-01-01T00:00:03.000Z', from: 'carol', to: ['dave'] }); // not alice
    await seed({ msg_id: 'm4', ts: '2026-01-01T00:00:04.000Z', from: 'alice', to: ['alice'] }); // alice's own
    await seed({ msg_id: 'm5', ts: '2026-01-01T00:00:05.000Z', from: 'bob', to: ['alice'], kind: 'notify' });
    await seed({ msg_id: 'm6', ts: '2026-01-01T00:00:06.000Z', from: 'eve', to: ['alice', 'dave'], kind: 'ack' });
    // Malformed: `to` is a bare string, not an array — both paths must exclude it.
    await seed({ msg_id: 'm7', ts: '2026-01-01T00:00:07.000Z', from: 'bob', to: 'alice' as unknown as string[] });
  }

  it('matches the authoritative full-scan + filterInbox, default opts', async () => {
    await seedSpread();
    const got = await readInbox('alice');
    expect(ids(got)).toEqual(await reference('alice').then(ids));
    // Concrete: direct (m1) + broadcast (m2) + ack (m6); NOT other (m3), own (m4),
    // notify (m5, default-excluded), or malformed non-array (m7).
    expect(ids(got)).toEqual(['m1', 'm2', 'm6']);
  });

  it('includes the broadcast (*) row and excludes a non-array `to`', async () => {
    await seedSpread();
    const got = await readInbox('alice');
    expect(ids(got)).toContain('m2'); // to:['*']
    expect(ids(got)).not.toContain('m7'); // to:'alice' (string, not array)
  });

  it('is byte-identical to the reference across owners + option combos', async () => {
    await seedSpread();
    const combos: Array<[string, InboxOptions]> = [
      ['alice', {}],
      ['alice', { excludeOwn: false }], // m4 (alice's own) now included
      ['alice', { kinds: ['notify'] }], // only m5
      ['alice', { kinds: ['message', 'ack'] }],
      ['alice', { since_ts: '2026-01-01T00:00:03.000Z' }],
      ['dave', {}], // direct m3 + broadcast m2 + multi-recipient m6
      ['nobody', {}], // only the broadcast m2
      ['', {}], // empty owner — only the broadcast
    ];
    for (const [owner, opts] of combos) {
      const got = await readInbox(owner, opts);
      const ref = await reference(owner, opts);
      expect({ owner, opts, ids: ids(got) }).toEqual({ owner, opts, ids: ids(ref) });
    }
  });

  it('excludeOwn:false surfaces the caller’s own outbox row (m4)', async () => {
    await seedSpread();
    expect(ids(await readInbox('alice', { excludeOwn: false }))).toContain('m4');
    expect(ids(await readInbox('alice'))).not.toContain('m4');
  });

  it('returns broadcasts only for an owner with no direct mail', async () => {
    await seedSpread();
    expect(ids(await readInbox('nobody'))).toEqual(['m2']);
  });

  it('returns empty when nothing matches', async () => {
    expect(await readInbox('alice')).toEqual([]);
  });
});
