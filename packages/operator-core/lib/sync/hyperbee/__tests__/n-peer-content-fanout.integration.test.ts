/**
 * n-peer-content-fanout.integration.test.ts — Brief N (shared-hive-release-testing):
 * the REAL-WIRE leg of N-peer scale. The existing N-peer integration test
 * (`cross-peer-coordination-scale`) federates ONLY presence + drives the authority
 * election cascade; no integration test proves a CONTENT type fans out to ALL of
 * 3+ peers over the actual Hyperswarm + the real PG projection. This does.
 *
 * Three REAL bootHarnessSubstrate Swarms of one Hive on a loopback testnet DHT
 * (the `_cross-peer-rig` `federatePeerSet` backbone — real Ed25519 announces, real
 * admission, per-peer throwaway PG with the REAL coord-message projection). Each
 * peer authors a coord-message; the assertion is the full fan-out MATRIX: every
 * peer's PG holds every peer's message, its OWN one `origin='local'` and every
 * other's `origin='remote'`. Lives in its OWN file (the rig's documented 5-peer
 * in-worker stall is a per-process artifact — a 3-peer mesh in a fresh worker is
 * clean).
 *
 * Boundary: like every rig here it wires matching topics directly
 * (`defaultResolveSwarmBinding` is bypassed), so the joiner-resolves-own-topic
 * discovery path is NOT exercised — that is Brief L's scope (noted in findings-N).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_ID,
  HARNESS_SLUG,
  COORD_EVENT_LOG_DDL,
  rigAfterEach,
  pollUntil,
  federatePeerSet,
} from './_cross-peer-rig';
import type { CoordMessageRow } from '../projections/coord-message';

// EI-279: the coord-message projection dynamically imports wakeRecipients for the
// federated deliver-and-wake fan — stub it so this content-crossing test needs no
// real await-event pump (messages carry wake:false anyway).
vi.mock('../../../agent-tools/coordination/inbox-wake', () => ({
  wakeRecipients: vi.fn(async (recipients: readonly string[]) => ({
    targets: [...recipients],
    keys: [],
    woken: 1,
    staged: 0,
  })),
}));

afterEach(rigAfterEach);

describe('Brief N — N-peer content fan-out over the real wire', () => {
  it(
    'a coord-message from every peer federates to ALL peers; own=local, others=remote (3-peer mesh)',
    async () => {
      const N = 3;
      const fleet = await federatePeerSet(N, 60_000);
      expect(fleet.federated, `presence federation incomplete — missing: ${fleet.lastMissing}`).toBeTruthy();

      // The N-peer rig stands up only the presence table per node; coord_event_log is
      // the content table THIS test federates. The coord-message projection is already
      // wired into each node's apply (buildPeerApply base set), so once the table
      // exists, coord-message ops project on every node.
      for (const n of fleet.nodes) await n.db.sql.unsafe(COORD_EVENT_LOG_DDL);

      // Each peer authors its OWN message: the local PG row coord:send would write
      // (origin='local'), then the op the substrate-outbox reshape appends on its own
      // peer-log (the production two-leg send shape).
      const msgId = (i: number) => `npeer-msg-${i}`;
      for (let i = 0; i < N; i++) {
        const n = fleet.nodes[i];
        const body = {
          ts: '2026-06-19T00:00:00Z',
          msg_id: msgId(i),
          from: `peer-${i}`,
          to: ['*'],
          kind: 'message',
          summary: `content fan-out from peer ${i}`,
          wake: false,
        };
        const row: CoordMessageRow = {
          harness_slug: HARNESS_SLUG,
          msg_id: msgId(i),
          surface: 'messages',
          writer_key: `peer-${i}`,
          body,
          ts: 1_700_000_000_000 + i,
        };
        await n.db.sql`
          INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug, origin)
          VALUES (${WORKSPACE_ID}, 'messages', ${`peer-${i}`}, ${msgId(i)}, ${n.db.sql.json(body as never)}, ${HARNESS_SLUG}, 'local')
        `;
        await n.peer.handle.append({
          type: 'put',
          table: 'coord-messages',
          hbKey: msgId(i),
          value: row,
          ts: 5_000 + i,
          schema_version: 1,
          writerPubkey: n.id.devicePubkey,
        });
      }

      // Negative isolation BEFORE merge: no peer has anyone else's message yet.
      for (let i = 0; i < N; i++) {
        const rows = await fleet.nodes[i].db.sql<Array<{ msg_id: string }>>`
          SELECT msg_id FROM harness_shared.coord_event_log ORDER BY msg_id`;
        expect(rows.map((r) => r.msg_id), `peer ${i} should hold only its own message pre-merge`).toEqual([msgId(i)]);
      }

      const allIds = Array.from({ length: N }, (_, i) => msgId(i));
      const converged = await pollUntil(
        async () => {
          for (const n of fleet.nodes) await n.peer.handle.mergeNow();
          for (let i = 0; i < N; i++) {
            const rows = await fleet.nodes[i].db.sql<Array<{ msg_id: string }>>`
              SELECT msg_id FROM harness_shared.coord_event_log`;
            const ids = new Set(rows.map((r) => r.msg_id));
            if (!allIds.every((id) => ids.has(id))) return undefined;
          }
          return true;
        },
        { timeoutMs: 40_000, intervalMs: 300 },
      );
      expect(converged, 'content never fanned out to all peers').toBeTruthy();

      // The full fan-out MATRIX: every peer holds every message; its OWN is local,
      // every OTHER peer's is remote (the origin column = it genuinely crossed).
      for (let i = 0; i < N; i++) {
        const rows = await fleet.nodes[i].db.sql<Array<{ msg_id: string; origin: string }>>`
          SELECT msg_id, origin FROM harness_shared.coord_event_log`;
        const byId = new Map(rows.map((r) => [r.msg_id, r.origin]));
        expect(byId.size, `peer ${i} key-set`).toBe(N);
        for (let j = 0; j < N; j++) {
          expect(byId.get(msgId(j)), `peer ${i} view of msg ${j}`).toBe(i === j ? 'local' : 'remote');
        }
      }
    },
    120_000,
  );

  it(
    'a joiner backfills a LARGE pre-existing coord-message history over the real wire (full set, no truncation, bounded latency)',
    async () => {
      // Backfill-at-size over the REAL wire + REAL PG projection (the merge-engine
      // layer proves this at 432 rows; this is the real-Hyperswarm + real-projection
      // counterpart, and the integration analog of su-9140a's live 2-peer 300-row note).
      const fleet = await federatePeerSet(2, 60_000);
      expect(fleet.federated, `presence federation incomplete — missing: ${fleet.lastMissing}`).toBeTruthy();
      const [owner, joiner] = fleet.nodes;
      for (const n of fleet.nodes) await n.db.sql.unsafe(COORD_EVENT_LOG_DDL);

      // Owner builds a SIZABLE pre-existing history on its own log (the joiner has
      // merged only presence so far — its first content merge is a cold backfill of
      // the whole set). Deterministic ids/ts (no Math.random).
      const ROWS = 250;
      for (let i = 0; i < ROWS; i++) {
        const id = `bulk-${i}`;
        const body = { ts: '2026-06-19T00:00:00Z', msg_id: id, from: 'owner', to: ['*'], kind: 'message', summary: `bulk ${i}`, wake: false };
        const row: CoordMessageRow = { harness_slug: HARNESS_SLUG, msg_id: id, surface: 'messages', writer_key: 'owner', body, ts: 1_700_000_000_000 + i };
        await owner.peer.handle.append({
          type: 'put',
          table: 'coord-messages',
          hbKey: id,
          value: row,
          ts: 6_000 + i,
          schema_version: 1,
          writerPubkey: owner.id.devicePubkey,
        });
      }

      const t0 = Date.now();
      const drained = await pollUntil(
        async () => {
          await owner.peer.handle.mergeNow();
          await joiner.peer.handle.mergeNow();
          const [{ c }] = await joiner.db.sql<Array<{ c: number }>>`
            SELECT count(*)::int AS c FROM harness_shared.coord_event_log WHERE origin = 'remote'`;
          return c >= ROWS ? c : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 300 },
      );
      const elapsedMs = Date.now() - t0;
      expect(drained, 'joiner never backfilled the full history').toBeTruthy();

      // The FULL set by id — not a truncated / top-N slice (set-semantics).
      const rows = await joiner.db.sql<Array<{ msg_id: string; origin: string }>>`
        SELECT msg_id, origin FROM harness_shared.coord_event_log`;
      const ids = new Set(rows.map((r) => r.msg_id));
      for (let i = 0; i < ROWS; i++) expect(ids.has(`bulk-${i}`), `joiner missing bulk-${i}`).toBe(true);
      expect(rows.length, 'joiner row count').toBe(ROWS);
      expect(rows.every((r) => r.origin === 'remote'), 'every backfilled row must be origin=remote').toBe(true);
      // Belt-and-braces latency bound (the live binary did 300 rows in ~6 s; 60 s is
      // generous CI headroom — it asserts "not pathologically slow", not a perf SLA).
      expect(elapsedMs, `backfill of ${ROWS} rows took ${elapsedMs}ms`).toBeLessThan(60_000);
    },
    120_000,
  );
});
