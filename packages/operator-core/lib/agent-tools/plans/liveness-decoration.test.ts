/**
 * liveness-decoration.test.ts — WI-1442 fix (a) coverage: read-time liveness
 * decoration of su-* agent-id mentions in plan `## Now` prose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: {
    presenceRows: { owner_id: string; heartbeat_at: string; last_active_at: string | null }[];
    wakeability: Map<string, { wakeable: boolean; liveTurn: boolean }>;
    sqlError: boolean;
  } = { presenceRows: [], wakeability: new Map(), sqlError: false };
  return { state };
});

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: Object.assign(
      async (..._args: unknown[]) => {
        if (H.state.sqlError) throw new Error('pg unavailable');
        return H.state.presenceRows;
      },
      { json: (x: unknown) => ({ __json: x }) },
    ),
  }),
}));

vi.mock('../coordination/presence-wakeability', async (orig) => {
  const actual = await orig<typeof import('../coordination/presence-wakeability')>();
  return {
    ...actual,
    fetchWakeability: async (ownerIds: string[]) => {
      const out = new Map<string, { wakeable: boolean; liveTurn: boolean }>();
      for (const id of ownerIds) {
        const w = H.state.wakeability.get(id);
        if (w) out.set(id, w);
      }
      return out;
    },
  };
});

import { decorateAgentLiveness, decoratePlanNowBlock, formatLivenessTag } from './liveness-decoration';

beforeEach(() => {
  H.state.presenceRows = [];
  H.state.wakeability = new Map();
  H.state.sqlError = false;
});

describe('decorateAgentLiveness', () => {
  it('returns text unchanged when there is no su-* mention', async () => {
    const r = await decorateAgentLiveness('nothing to see here');
    expect(r).toEqual({ text: 'nothing to see here', decorated: 0 });
  });

  it('handles null/undefined/empty input without touching the DB', async () => {
    expect(await decorateAgentLiveness(null)).toEqual({ text: '', decorated: 0 });
    expect(await decorateAgentLiveness(undefined)).toEqual({ text: '', decorated: 0 });
    expect(await decorateAgentLiveness('')).toEqual({ text: '', decorated: 0 });
  });

  it('annotates an unambiguously-resolved mention with ENDED when not wakeable', async () => {
    H.state.presenceRows = [
      { owner_id: 'su-2c799e5a-aaaa-bbbb-cccc-000000000001', heartbeat_at: '2026-07-02T16:46:00.000Z', last_active_at: '2026-07-02T16:46:00.000Z' },
    ];
    H.state.wakeability = new Map([
      ['su-2c799e5a-aaaa-bbbb-cccc-000000000001', { wakeable: false, liveTurn: false }],
    ]);
    const r = await decorateAgentLiveness('queued behind su-2c799e5a per live presence');
    expect(r.decorated).toBe(1);
    expect(r.text).toBe('queued behind su-2c799e5a [ENDED 16:46] per live presence');
  });

  it('annotates a live mention as LIVE', async () => {
    const fresh = new Date().toISOString();
    H.state.presenceRows = [
      { owner_id: 'su-45e4cbc0-dfb3-4b67-9e25-5a4520cbf913', heartbeat_at: fresh, last_active_at: fresh },
    ];
    H.state.wakeability = new Map([
      ['su-45e4cbc0-dfb3-4b67-9e25-5a4520cbf913', { wakeable: true, liveTurn: true }],
    ]);
    const r = await decorateAgentLiveness('WI-9 actively worked by su-45e4c');
    expect(r.decorated).toBe(1);
    expect(r.text).toContain('[LIVE');
  });

  it('decorates every occurrence of the same resolved token', async () => {
    H.state.presenceRows = [
      { owner_id: 'su-2c799e5a-aaaa-bbbb-cccc-000000000001', heartbeat_at: '2026-07-02T16:46:00.000Z', last_active_at: null },
    ];
    H.state.wakeability = new Map([
      ['su-2c799e5a-aaaa-bbbb-cccc-000000000001', { wakeable: false, liveTurn: false }],
    ]);
    const r = await decorateAgentLiveness('su-2c799e5a started it; su-2c799e5a finished it');
    expect(r.decorated).toBe(2);
    expect(r.text.match(/\[ENDED/g)?.length).toBe(2);
  });

  it('leaves an AMBIGUOUS prefix (matches 2+ presence rows) undecorated — conservative like the WI-1612 backfill', async () => {
    H.state.presenceRows = [
      { owner_id: 'su-2c799e5a-aaaa-bbbb-cccc-000000000001', heartbeat_at: '2026-07-02T16:46:00.000Z', last_active_at: null },
      { owner_id: 'su-2c799e5b-dddd-eeee-ffff-000000000002', heartbeat_at: '2026-07-02T16:47:00.000Z', last_active_at: null },
    ];
    const r = await decorateAgentLiveness('su-2c799e5 owns this');
    expect(r).toEqual({ text: 'su-2c799e5 owns this', decorated: 0 });
  });

  it('leaves an UNMATCHED token (no presence row at all) undecorated', async () => {
    H.state.presenceRows = [];
    const r = await decorateAgentLiveness('su-ffffff never registered presence');
    expect(r).toEqual({ text: 'su-ffffff never registered presence', decorated: 0 });
  });

  it('degrades gracefully to the unmodified text on a PG failure', async () => {
    H.state.sqlError = true;
    const r = await decorateAgentLiveness('su-2c799e5a per live presence');
    expect(r).toEqual({ text: 'su-2c799e5a per live presence', decorated: 0 });
  });
});

describe('formatLivenessTag', () => {
  it('renders STATE + HH:MM', () => {
    expect(formatLivenessTag('ended', Date.parse('2026-07-02T16:46:00.000Z'))).toBe('ENDED 16:46');
  });
  it('renders a placeholder time when no timestamp is available', () => {
    expect(formatLivenessTag('live', null)).toBe('LIVE ??:??');
  });
});

describe('decoratePlanNowBlock', () => {
  it('passes through null', async () => {
    expect(await decoratePlanNowBlock(null)).toBeNull();
  });

  it('decorates both state and next, preserving other fields', async () => {
    H.state.presenceRows = [
      { owner_id: 'su-2c799e5a-aaaa-bbbb-cccc-000000000001', heartbeat_at: '2026-07-02T16:46:00.000Z', last_active_at: null },
    ];
    H.state.wakeability = new Map([
      ['su-2c799e5a-aaaa-bbbb-cccc-000000000001', { wakeable: false, liveTurn: false }],
    ]);
    const now = { state: 'su-2c799e5a is on it', next: 'nothing else queued', raw: 'raw', lineNumber: 1 };
    const out = await decoratePlanNowBlock(now);
    expect(out).not.toBeNull();
    expect(out!.state).toBe('su-2c799e5a [ENDED 16:46] is on it');
    expect(out!.next).toBe('nothing else queued');
    expect(out!.raw).toBe('raw');
    expect(out!.lineNumber).toBe(1);
  });

  it('returns the SAME reference when nothing was decorated (no su-* mentions)', async () => {
    const now = { state: 'no agents mentioned', next: 'still none', raw: 'r', lineNumber: 2 };
    const out = await decoratePlanNowBlock(now);
    expect(out).toBe(now);
  });
});
