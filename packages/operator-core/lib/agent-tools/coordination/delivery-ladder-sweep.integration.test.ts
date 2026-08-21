/**
 * delivery-ladder-sweep.integration.test.ts — the ladder's WINDOW SQL against REAL
 * Postgres (EI-19325333358401288).
 *
 * WHY THIS FILE EXISTS. The unit suite (delivery-ladder-sweep.test.ts) DI's both
 * IO seams away via `io.fetchCandidates` / `io.fetchCapped`, and says so
 * explicitly ("the SQL filters are exercised by shape via the classifier's
 * inputs"). So the window predicates had NO coverage whatsoever — which is exactly
 * how the index-miss below survived long enough to become the single largest
 * consumer of `coord_event_log` (100.6h of DB time, 863ms mean to return ONE
 * aggregated row, across 299,921+ calls).
 *
 * THE FIX BEING PINNED. Both windows moved from `(body->>'ts')::timestamptz` — a
 * JSONB extraction + cast, which `coord_event_log_messages_ts_idx (workspace_id,
 * ts, id) WHERE surface='messages'` cannot serve — to the real `ts` COLUMN.
 * Measured on the live box over the same 24h window, identical row counts:
 *   (body->>'ts')::timestamptz -> Parallel Seq Scan, 37,148 buffers, 3 extra
 *                                 workers launched, 107ms
 *   ts                         -> Index Only Scan,      95 buffers, 0 workers, 3.2ms
 *
 * The tests below pin the two places where the column and the envelope field are
 * NOT interchangeable, because those are the only ways this change can be wrong:
 * a row whose two timestamps straddle the window edge, and a row with no
 * `body->>'ts'` at all (silently dropped before, correctly in scope now — and
 * dangerous without the COALESCE, see the `ts_ms` test).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/agent-tools/coordination/delivery-ladder-sweep.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import {
  findLadderCandidates,
  findStormCappedRecipients,
  LADDER_LOOKBACK_MS,
  LADDER_TTL_MS_DEFAULT,
  DELIVERY_LADDER_OWNER,
} from './delivery-ladder-sweep';

let fx: BaselineCoordFixture;

const NOW = Date.parse('2026-08-02T12:00:00.000Z');
const TTL = LADDER_TTL_MS_DEFAULT; // 5 min — the NEWEST-allowed edge
const MIN = 60_000;

/** The centre of the window: comfortably older than the TTL edge, comfortably
 *  newer than the 6h lookback. */
const IN_WINDOW = NOW - 60 * MIN;

/**
 * Insert one raw row with INDEPENDENT control over the `ts` COLUMN and the
 * envelope's `body.ts`. That independence is the whole point — no higher-level
 * write path lets them diverge, and their divergence is what this change turns on.
 * `bodyTsMs: null` omits `ts` from the body entirely.
 */
async function insertRow(opts: {
  msgId: string;
  colTsMs: number;
  bodyTsMs: number | null;
  from?: string;
  to?: string[];
  extra?: Record<string, unknown>;
}): Promise<void> {
  const { msgId, colTsMs, bodyTsMs, from = 'su-peer', to = ['su-deaf'], extra = {} } = opts;
  const body: Record<string, unknown> = {
    msg_id: msgId,
    from,
    to,
    kind: 'message',
    summary: msgId,
    ...(bodyTsMs === null ? {} : { ts: new Date(bodyTsMs).toISOString() }),
    ...extra,
  };
  await fx.admin`
    INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, ts, workspace_id, origin)
    VALUES ('messages', ${msgId}, ${fx.admin.json(body as postgres.JSONValue)}, ${new Date(colTsMs)}, 'default', 'local')
  `;
}

const recipients = (rows: { recipient: string }[]): string[] => rows.map((r) => r.recipient).sort();

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

describe('findLadderCandidates — window bounds (baseline behaviour, unchanged)', () => {
  it('includes a directed message sitting inside the window', async () => {
    await insertRow({ msgId: 'in', colTsMs: IN_WINDOW, bodyTsMs: IN_WINDOW });
    const rows = await findLadderCandidates(NOW, TTL);
    expect(recipients(rows)).toEqual(['su-deaf']);
    expect(Number(rows[0].cnt)).toBe(1);
  });

  it('excludes a message NEWER than the TTL edge — it has not had time to be read yet', async () => {
    await insertRow({ msgId: 'too-new', colTsMs: NOW - MIN, bodyTsMs: NOW - MIN });
    expect(await findLadderCandidates(NOW, TTL)).toEqual([]);
  });

  it('excludes a message older than the 6h lookback', async () => {
    const old = NOW - LADDER_LOOKBACK_MS - 10 * MIN;
    await insertRow({ msgId: 'too-old', colTsMs: old, bodyTsMs: old });
    expect(await findLadderCandidates(NOW, TTL)).toEqual([]);
  });
});

describe('findLadderCandidates — the window reads the ts COLUMN, not body->>ts (EI-19325333358401288)', () => {
  it('INCLUDES a row whose column ts is in-window even though its envelope ts is far outside it', async () => {
    // Straddles the edge in the direction that only the column can see. Under the
    // old `(body->>'ts')::timestamptz` predicate this row was invisible.
    await insertRow({
      msgId: 'col-in-body-ancient',
      colTsMs: IN_WINDOW,
      bodyTsMs: NOW - LADDER_LOOKBACK_MS - 60 * MIN,
    });
    const rows = await findLadderCandidates(NOW, TTL);
    expect(recipients(rows)).toEqual(['su-deaf']);
  });

  it('EXCLUDES a row whose column ts is out of window even though its envelope ts is in-window', async () => {
    await insertRow({
      msgId: 'col-ancient-body-in',
      colTsMs: NOW - LADDER_LOOKBACK_MS - 60 * MIN,
      bodyTsMs: IN_WINDOW,
    });
    expect(await findLadderCandidates(NOW, TTL)).toEqual([]);
  });

  it('a realistic sub-minute skew (max observed live: 49.44s) cannot flip a verdict either way', async () => {
    // The measured divergence across all 76,367 live message rows was <=49.44s,
    // against a 6h lookback and a 5m TTL edge — so both timestamps agree on
    // membership for any row that is not deliberately adversarial.
    await insertRow({ msgId: 'skew-a', colTsMs: IN_WINDOW, bodyTsMs: IN_WINDOW - 49_440 });
    await insertRow({ msgId: 'skew-b', colTsMs: IN_WINDOW, bodyTsMs: IN_WINDOW + 49_440 });
    const rows = await findLadderCandidates(NOW, TTL);
    expect(recipients(rows)).toEqual(['su-deaf']);
    expect(Number(rows[0].cnt)).toBe(2);
  });
});

describe('findLadderCandidates — rows with NO envelope ts', () => {
  it('now considers a row whose body has no ts (it was silently DROPPED before)', async () => {
    // `(NULL)::timestamptz >= x` is NULL, not false, so the old predicate dropped
    // these. `ts` is NOT NULL, so they are now correctly in scope.
    await insertRow({ msgId: 'no-body-ts', colTsMs: IN_WINDOW, bodyTsMs: null });
    const rows = await findLadderCandidates(NOW, TTL);
    expect(recipients(rows)).toEqual(['su-deaf']);
  });

  it('ts_ms falls back to the column so it is NEVER null — a null would read as 1970 and fire a spurious wake', async () => {
    // Number(null) === 0 in classifyLadderEscalations, i.e. epoch 1970, which reads
    // as maximally-stale unread mail. The COALESCE is what prevents that.
    await insertRow({ msgId: 'no-body-ts', colTsMs: IN_WINDOW, bodyTsMs: null });
    const [row] = await findLadderCandidates(NOW, TTL);
    expect(row.oldest_ts_ms).not.toBeNull();
    expect(Number(row.oldest_ts_ms)).toBe(IN_WINDOW);
    expect(Number(row.newest_ts_ms)).toBe(IN_WINDOW);
  });

  it('a null-ts row does not hijack newest_from — Postgres sorts NULLs FIRST under ORDER BY DESC', async () => {
    await insertRow({
      msgId: 'no-body-ts',
      colTsMs: IN_WINDOW - 30 * MIN,
      bodyTsMs: null,
      from: 'su-older',
    });
    await insertRow({ msgId: 'real-newest', colTsMs: IN_WINDOW, bodyTsMs: IN_WINDOW, from: 'su-newest' });
    const [row] = await findLadderCandidates(NOW, TTL);
    expect(Number(row.cnt)).toBe(2);
    expect(row.newest_from).toBe('su-newest');
  });
});

describe('findLadderCandidates — reported timestamps stay ENVELOPE-derived', () => {
  it('ts_ms prefers body->>ts, so only the WHERE moved to the column, not the SELECT', async () => {
    // Column and envelope deliberately differ by 20s; the reported value must be
    // the ENVELOPE's, exactly as before this change.
    await insertRow({ msgId: 'reported', colTsMs: IN_WINDOW, bodyTsMs: IN_WINDOW - 20_000 });
    const [row] = await findLadderCandidates(NOW, TTL);
    expect(Number(row.newest_ts_ms)).toBe(IN_WINDOW - 20_000);
  });
});

describe('findLadderCandidates — directedness filters still hold after the window change', () => {
  it('excludes broadcast / human / selector recipients and self-sends', async () => {
    await insertRow({ msgId: 'b1', colTsMs: IN_WINDOW, bodyTsMs: IN_WINDOW, to: ['*'] });
    await insertRow({ msgId: 'b2', colTsMs: IN_WINDOW, bodyTsMs: IN_WINDOW, to: ['human'] });
    await insertRow({ msgId: 'b3', colTsMs: IN_WINDOW, bodyTsMs: IN_WINDOW, to: ['@fleet:x'] });
    await insertRow({ msgId: 'b4', colTsMs: IN_WINDOW, bodyTsMs: IN_WINDOW, from: 'su-self', to: ['su-self'] });
    expect(await findLadderCandidates(NOW, TTL)).toEqual([]);
  });

  it('excludes machine senders and auto-stamped lifecycle notices', async () => {
    await insertRow({ msgId: 'm1', colTsMs: IN_WINDOW, bodyTsMs: IN_WINDOW, from: 'system:delivery-ladder' });
    await insertRow({ msgId: 'm2', colTsMs: IN_WINDOW, bodyTsMs: IN_WINDOW, from: 'claim-discipline-watch' });
    await insertRow({
      msgId: 'm3',
      colTsMs: IN_WINDOW,
      bodyTsMs: IN_WINDOW,
      extra: { auto: true },
    });
    expect(await findLadderCandidates(NOW, TTL)).toEqual([]);
  });
});

describe('findLadderCandidates — recipient replies clear the original candidate', () => {
  it('excludes a directed message answered by the recipient via related_msg_id', async () => {
    await insertRow({
      msgId: 'original-ask',
      colTsMs: IN_WINDOW,
      bodyTsMs: IN_WINDOW,
      from: 'su-peer',
      to: ['su-deaf'],
    });
    await insertRow({
      msgId: 'recipient-answer',
      colTsMs: IN_WINDOW + MIN,
      bodyTsMs: IN_WINDOW + MIN,
      from: 'su-deaf',
      to: ['su-peer'],
      extra: { related_msg_id: 'original-ask' },
    });

    const rows = await findLadderCandidates(NOW, TTL);
    expect(rows.map((row) => row.recipient)).toEqual(['su-peer']);
  });
});

describe('findStormCappedRecipients — same column swap', () => {
  it('finds a recipient the ladder woke inside the storm window', async () => {
    await insertRow({
      msgId: 'marker',
      colTsMs: NOW - 2 * MIN,
      bodyTsMs: NOW - 2 * MIN,
      from: DELIVERY_LADDER_OWNER,
      to: ['su-deaf'],
    });
    const capped = await findStormCappedRecipients(NOW, 10 * MIN);
    expect([...capped]).toEqual(['su-deaf']);
  });

  it('windows on the ts COLUMN: an in-window column ts counts even with an ancient envelope ts', async () => {
    await insertRow({
      msgId: 'marker',
      colTsMs: NOW - 2 * MIN,
      bodyTsMs: NOW - 6 * 3600_000,
      from: DELIVERY_LADDER_OWNER,
      to: ['su-deaf'],
    });
    expect([...(await findStormCappedRecipients(NOW, 10 * MIN))]).toEqual(['su-deaf']);
  });

  it('ignores a marker older than the storm window', async () => {
    await insertRow({
      msgId: 'marker',
      colTsMs: NOW - 30 * MIN,
      bodyTsMs: NOW - 30 * MIN,
      from: DELIVERY_LADDER_OWNER,
      to: ['su-deaf'],
    });
    expect([...(await findStormCappedRecipients(NOW, 10 * MIN))]).toEqual([]);
  });
});
