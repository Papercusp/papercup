/**
 * delivery-ladder-sweep (coord-delivery-residual-gaps-2026-07-11 P-004,
 * WI-4160) — the pure escalation verdict + the DI'd sweep pass, no PG.
 * Ratified defaults pinned here: TTL 5m (clamped >=1m), storm cap
 * 1/recipient/10m, LIVE recipients only, directed-only candidates (the SQL
 * filters are exercised by shape via the classifier's inputs).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  classifyLadderEscalations,
  runDeliveryLadderSweepOnce,
  ladderTtlMs,
  ladderStormMs,
  LADDER_TTL_MS_DEFAULT,
  LADDER_STORM_MS_DEFAULT,
  DELIVERY_LADDER_OWNER,
  type LadderCandidateRow,
} from './delivery-ladder-sweep';
import type { sendMessage } from './messages';
import type { wakeRecipients } from './inbox-wake';

const NOW = Date.parse('2026-07-11T12:00:00Z');
const MIN = 60_000;

const LIVE = { wakeable: true, liveTurn: true };
const PARKED = { wakeable: true, liveTurn: false };
const ENDED = { wakeable: false, liveTurn: false };

function row(recipient: string, over: Partial<LadderCandidateRow> = {}): LadderCandidateRow {
  return {
    workspace_id: 'ws-1',
    recipient,
    cnt: 2,
    oldest_ts_ms: NOW - 20 * MIN,
    newest_ts_ms: NOW - 6 * MIN,
    newest_from: 'su-peer',
    newest_summary: 'please review X',
    ...over,
  };
}

describe('classifyLadderEscalations (pure verdict)', () => {
  it('escalates a LIVE recipient whose last read predates the newest candidate', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-deaf')],
      lastReadByOwner: new Map([['su-deaf', new Date(NOW - 30 * MIN).toISOString()]]),
      signals: new Map([['su-deaf', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      workspaceId: 'ws-1',
      recipient: 'su-deaf',
      candidateCount: 2,
      newestFrom: 'su-peer',
      newestSummary: 'please review X',
    });
    expect(out[0].oldestAgeMs).toBe(20 * MIN);
  });

  it('never escalates a recipient who has read since the newest candidate landed', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-fresh')],
      lastReadByOwner: new Map([['su-fresh', new Date(NOW - MIN).toISOString()]]),
      signals: new Map([['su-fresh', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it('a read exactly AT the newest candidate ts counts as read (boundary)', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-edge', { newest_ts_ms: NOW - 6 * MIN })],
      lastReadByOwner: new Map([['su-edge', new Date(NOW - 6 * MIN).toISOString()]]),
      signals: new Map([['su-edge', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it('escalates a NEVER-read live recipient (no coord read on record at all)', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-never')],
      lastReadByOwner: new Map(),
      signals: new Map([['su-never', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toHaveLength(1);
  });

  it('skips PARKED and ENDED recipients — LIVE sessions only (sender-intent rule)', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-parked'), row('su-ended')],
      lastReadByOwner: new Map(),
      signals: new Map([
        ['su-parked', PARKED],
        ['su-ended', ENDED],
      ]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it('skips a recipient with NO liveness signals (skip-toward-null — a wake is billable)', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-unknown')],
      lastReadByOwner: new Map(),
      signals: new Map(),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it('skips a storm-capped recipient (1 wake / recipient / window)', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-capped')],
      lastReadByOwner: new Map(),
      signals: new Map([['su-capped', LIVE]]),
      capped: new Set(['su-capped']),
      nowMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it('skips a row with an unparseable newest ts (never escalate on bad data)', () => {
    const out = classifyLadderEscalations({
      rows: [row('su-garbage', { newest_ts_ms: 'not-a-number' })],
      lastReadByOwner: new Map(),
      signals: new Map([['su-garbage', LIVE]]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out).toEqual([]);
  });

  it('orders longest-waiting first (oldest unread drains first under the batch limit)', () => {
    const out = classifyLadderEscalations({
      rows: [
        row('su-recent', { oldest_ts_ms: NOW - 7 * MIN }),
        row('su-ancient', { oldest_ts_ms: NOW - 300 * MIN }),
      ],
      lastReadByOwner: new Map(),
      signals: new Map([
        ['su-recent', LIVE],
        ['su-ancient', LIVE],
      ]),
      capped: new Set(),
      nowMs: NOW,
    });
    expect(out.map((e) => e.recipient)).toEqual(['su-ancient', 'su-recent']);
  });
});

describe('ladder tunables (env-clamped, ratified defaults)', () => {
  it('defaults: TTL 5m, storm cap 10m', () => {
    expect(ladderTtlMs({})).toBe(LADDER_TTL_MS_DEFAULT);
    expect(LADDER_TTL_MS_DEFAULT).toBe(5 * MIN);
    expect(ladderStormMs({})).toBe(LADDER_STORM_MS_DEFAULT);
    expect(LADDER_STORM_MS_DEFAULT).toBe(10 * MIN);
  });

  it('env overrides apply; sub-minute values clamp to 1m (wake-storm guard)', () => {
    expect(ladderTtlMs({ PAPERCUSP_COORD_LADDER_TTL_MS: '180000' })).toBe(180_000);
    expect(ladderTtlMs({ PAPERCUSP_COORD_LADDER_TTL_MS: '5000' })).toBe(MIN);
    expect(ladderStormMs({ PAPERCUSP_COORD_LADDER_STORM_MS: '1' })).toBe(MIN);
  });

  it('garbage / non-positive env falls back to the default', () => {
    expect(ladderTtlMs({ PAPERCUSP_COORD_LADDER_TTL_MS: 'soon' })).toBe(LADDER_TTL_MS_DEFAULT);
    expect(ladderTtlMs({ PAPERCUSP_COORD_LADDER_TTL_MS: '-5' })).toBe(LADDER_TTL_MS_DEFAULT);
    expect(ladderStormMs({ PAPERCUSP_COORD_LADDER_STORM_MS: '' })).toBe(LADDER_STORM_MS_DEFAULT);
  });
});

describe('runDeliveryLadderSweepOnce (DI end-to-end, no PG)', () => {
  const wakeOk = {
    targets: ['x'], keys: ['k'], woken: 1, staged: 0, stagedTargets: [], fanoutCapped: [],
  };

  function makeIo(over: Record<string, unknown> = {}) {
    const send = vi.fn(async () => ({}) as never);
    const wake = vi.fn(async () => wakeOk);
    return {
      send: send as unknown as typeof sendMessage,
      wake: wake as unknown as typeof wakeRecipients,
      sendMock: send,
      wakeMock: wake,
      fetchCandidates: vi.fn(async () => [row('su-deaf')]),
      fetchReads: vi.fn(async () => new Map<string, string>()),
      fetchSignals: vi.fn(async () => new Map([['su-deaf', LIVE]])),
      fetchCapped: vi.fn(async () => new Set<string>()),
      ...over,
    };
  }

  it('escalates: marker message to the recipient, then the standing inbox-wake fire', async () => {
    const io = makeIo();
    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io });
    expect(res).toEqual({ candidates: 1, escalations: 1, woken: 1, truncated: false });
    expect(io.sendMock).toHaveBeenCalledTimes(1);
    const [identity, sendArgs] = io.sendMock.mock.calls[0] as unknown as [
      { ownerId: string }, { to: string[]; summary: string; body: string },
    ];
    expect(identity.ownerId).toBe(DELIVERY_LADDER_OWNER);
    expect(sendArgs.to).toEqual(['su-deaf']);
    expect(sendArgs.summary).toContain('delivery-ladder');
    expect(sendArgs.body).toContain('coord:inbox');
    expect(io.wakeMock).toHaveBeenCalledWith(['su-deaf'], expect.objectContaining({
      source: DELIVERY_LADDER_OWNER,
      workspaceId: 'ws-1',
    }));
  });

  it('zero candidates short-circuits — no read/signal/cap fetches, no sends', async () => {
    const io = makeIo({ fetchCandidates: vi.fn(async () => []) });
    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io });
    expect(res).toEqual({ candidates: 0, escalations: 0, woken: 0, truncated: false });
    expect(io.fetchReads).not.toHaveBeenCalled();
    expect(io.fetchSignals).not.toHaveBeenCalled();
    expect(io.sendMock).not.toHaveBeenCalled();
  });

  it('batch limit truncates the pass (rest picked up next tick) and reports it', async () => {
    const io = makeIo({
      fetchCandidates: vi.fn(async () => [row('su-a'), row('su-b'), row('su-c')]),
      fetchSignals: vi.fn(async () => new Map([
        ['su-a', LIVE], ['su-b', LIVE], ['su-c', LIVE],
      ])),
    });
    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io, limit: 2 });
    expect(res.escalations).toBe(3);
    expect(res.woken).toBe(2);
    expect(res.truncated).toBe(true);
    expect(io.sendMock).toHaveBeenCalledTimes(2);
  });

  it('a wake failure is fail-soft: marker already sent, pass continues, woken uncounted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wake = vi.fn(async () => { throw new Error('pump down'); });
    const io = makeIo({ wake: wake as unknown as typeof wakeRecipients, wakeMock: wake });
    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io });
    expect(res.woken).toBe(0);
    expect(res.escalations).toBe(1);
    expect(io.sendMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a marker-send failure skips the wake for that recipient (no cap record ⇒ next tick retries)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn(async () => { throw new Error('log write failed'); });
    const io = makeIo({ send: send as unknown as typeof sendMessage, sendMock: send });
    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io });
    expect(res.woken).toBe(0);
    expect(io.wakeMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a read/parked/capped recipient produces zero escalations end-to-end', async () => {
    const io = makeIo({
      fetchCandidates: vi.fn(async () => [row('su-read'), row('su-parked'), row('su-capped')]),
      fetchReads: vi.fn(async () => new Map([['su-read', new Date(NOW).toISOString()]])),
      fetchSignals: vi.fn(async () => new Map([
        ['su-read', LIVE], ['su-parked', PARKED], ['su-capped', LIVE],
      ])),
      fetchCapped: vi.fn(async () => new Set(['su-capped'])),
    });
    const res = await runDeliveryLadderSweepOnce({ nowMs: NOW, io });
    expect(res).toEqual({ candidates: 3, escalations: 0, woken: 0, truncated: false });
    expect(io.sendMock).not.toHaveBeenCalled();
  });
});
