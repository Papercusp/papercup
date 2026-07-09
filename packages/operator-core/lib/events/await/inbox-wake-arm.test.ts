/**
 * inbox-wake-arm.test.ts — armInboxWake / cancelInboxWake (GAP 8, was ZERO tests).
 *
 * Deps mocked (captureWakeHandleForOwner / upsertInboxWakeAwait /
 * cancelInboxWakeAwaits / startAwaitSweeper). Asserts the upsert is keyed on
 * inboxWakeKey(owner), the idleWakeFloorSec default + the
 * PAPERCUSP_WATCH_MIN_SLEEP_SEC env override (incl. a BAD value → fallback 60),
 * and that planRunId flows into the handle capture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inboxWakeKey } from '../../agent-tools/coordination/inbox-wake';

vi.mock('./handle', () => ({
  captureWakeHandleForOwner: vi.fn(async () => ({ handle: { kind: 'adv-session' }, note: 'resumable' })),
}));
vi.mock('./store', () => ({
  upsertInboxWakeAwait: vi.fn(async (i: Record<string, unknown>) => ({ id: 7, eventKey: i.eventKey })),
  cancelInboxWakeAwaits: vi.fn(async () => 2),
}));
vi.mock('./engine', () => ({ startAwaitSweeper: vi.fn() }));

// The self-heal helper probes PG (getOrgPg().sql). hoist a routable tagged-template
// mock: queries naming `event_awaits` return the "already armed?" rows, `adv_sessions`
// the "live tracked session?" rows. Tests set h.state before calling.
const h = vi.hoisted(() => {
  const state = { armed: [] as unknown[], live: [] as unknown[], fail: false };
  const sql = (strings: TemplateStringsArray) => {
    if (state.fail) return Promise.reject(new Error('pg down'));
    const text = strings.join(' ');
    if (text.includes('event_awaits')) return Promise.resolve(state.armed);
    if (text.includes('adv_sessions')) return Promise.resolve(state.live);
    return Promise.resolve([] as unknown[]);
  };
  return { state, sql };
});
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

import {
  armInboxWake,
  cancelInboxWake,
  ensureInboxWakeArmedForActiveSession,
} from './inbox-wake-arm';
import { captureWakeHandleForOwner } from './handle';
import { upsertInboxWakeAwait, cancelInboxWakeAwaits } from './store';
import { startAwaitSweeper } from './engine';

const ENV_KEY = 'PAPERCUSP_WATCH_MIN_SLEEP_SEC';
let savedEnv: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

describe('armInboxWake', () => {
  it('upserts on eventKey=inboxWakeKey(owner), starts the sweeper, returns awaitId/eventKey/handleNote', async () => {
    const res = await armInboxWake({ ownerId: 'su-bee' });
    expect(startAwaitSweeper).toHaveBeenCalledTimes(1);
    const key = inboxWakeKey('su-bee');
    expect(upsertInboxWakeAwait).toHaveBeenCalledWith(expect.objectContaining({ subscriberId: 'su-bee', eventKey: key }));
    expect(res).toEqual({ awaitId: 7, eventKey: key, handleNote: 'resumable' });
  });

  it('default floor: minSleepSec=60 when env unset', async () => {
    await armInboxWake({ ownerId: 'su-bee' });
    expect(upsertInboxWakeAwait).toHaveBeenCalledWith(expect.objectContaining({ minSleepSec: 60 }));
  });

  it('env override: PAPERCUSP_WATCH_MIN_SLEEP_SEC=300 → minSleepSec=300', async () => {
    process.env[ENV_KEY] = '300';
    await armInboxWake({ ownerId: 'su-bee' });
    expect(upsertInboxWakeAwait).toHaveBeenCalledWith(expect.objectContaining({ minSleepSec: 300 }));
  });

  it('env override: a BAD value (non-numeric) → falls back to 60', async () => {
    process.env[ENV_KEY] = 'not-a-number';
    await armInboxWake({ ownerId: 'su-bee' });
    expect(upsertInboxWakeAwait).toHaveBeenCalledWith(expect.objectContaining({ minSleepSec: 60 }));
  });

  it('env override: a negative value → falls back to 60 (floor must be >= 0)', async () => {
    process.env[ENV_KEY] = '-5';
    await armInboxWake({ ownerId: 'su-bee' });
    expect(upsertInboxWakeAwait).toHaveBeenCalledWith(expect.objectContaining({ minSleepSec: 60 }));
  });

  it('explicit minSleepSec wins over the env/default floor', async () => {
    process.env[ENV_KEY] = '300';
    await armInboxWake({ ownerId: 'su-bee', minSleepSec: 12 });
    expect(upsertInboxWakeAwait).toHaveBeenCalledWith(expect.objectContaining({ minSleepSec: 12 }));
  });

  it('planRunId flows into captureWakeHandleForOwner', async () => {
    await armInboxWake({ ownerId: 'su-bee', planRunId: 42 });
    expect(captureWakeHandleForOwner).toHaveBeenCalledWith('su-bee', { planRunId: 42 });
  });

  it('note flows into the upsert; default note when omitted; workspaceId is accepted but ignored (WI-3575, dead since events:await is single-workspace by design)', async () => {
    await armInboxWake({ ownerId: 'su-bee', note: 'idle now', workspaceId: 'ws-7' });
    expect(upsertInboxWakeAwait).toHaveBeenCalledWith(expect.objectContaining({ note: 'idle now' }));
    expect(vi.mocked(upsertInboxWakeAwait).mock.calls[0][0]).not.toHaveProperty('workspaceId');
    vi.clearAllMocks();
    await armInboxWake({ ownerId: 'su-bee' });
    const call = vi.mocked(upsertInboxWakeAwait).mock.calls[0][0];
    expect(call.note).toMatch(/always-armed inbox-wake/);
  });
});

describe('cancelInboxWake', () => {
  it('delegates to cancelInboxWakeAwaits(owner) and returns the rows cancelled; a passed workspaceId is accepted but ignored (WI-3575)', async () => {
    const n = await cancelInboxWake('su-bee', 'ws-7');
    expect(cancelInboxWakeAwaits).toHaveBeenCalledWith('su-bee');
    expect(n).toBe(2);
  });
});

describe('ensureInboxWakeArmedForActiveSession (self-heal)', () => {
  beforeEach(() => {
    h.state.armed = [];
    h.state.live = [];
    h.state.fail = false;
  });

  it('arms a LIVE tracked session that has NO inbox-wake yet (the lost-SessionStart-arm case)', async () => {
    h.state.armed = []; // no live await
    h.state.live = [{ one: 1 }]; // live adv_sessions row
    const armed = await ensureInboxWakeArmedForActiveSession({ ownerId: 'su-heal-1', workspaceId: 'ws-1' });
    expect(armed).toBe(true);
    // armInboxWake landed → the standing row was upserted on the right key.
    expect(upsertInboxWakeAwait).toHaveBeenCalledWith(
      expect.objectContaining({ subscriberId: 'su-heal-1', eventKey: inboxWakeKey('su-heal-1') }),
    );
  });

  it('NO-OP when the session is already wakeable (a live await exists)', async () => {
    h.state.armed = [{ one: 1 }]; // already armed
    h.state.live = [{ one: 1 }];
    const armed = await ensureInboxWakeArmedForActiveSession({ ownerId: 'su-heal-2' });
    expect(armed).toBe(false);
    expect(upsertInboxWakeAwait).not.toHaveBeenCalled();
  });

  it('NO-OP when there is no live tracked session (never arms a random/ended owner)', async () => {
    h.state.armed = [];
    h.state.live = []; // no live adv_sessions row
    const armed = await ensureInboxWakeArmedForActiveSession({ ownerId: 'su-heal-3' });
    expect(armed).toBe(false);
    expect(upsertInboxWakeAwait).not.toHaveBeenCalled();
  });

  it('throttles: a second call for the same owner within the window does not re-probe/re-arm', async () => {
    h.state.armed = [];
    h.state.live = [{ one: 1 }];
    const first = await ensureInboxWakeArmedForActiveSession({ ownerId: 'su-heal-4' });
    expect(first).toBe(true);
    vi.clearAllMocks();
    const second = await ensureInboxWakeArmedForActiveSession({ ownerId: 'su-heal-4' });
    expect(second).toBe(false); // throttled
    expect(upsertInboxWakeAwait).not.toHaveBeenCalled();
  });

  it('best-effort: a probe failure is swallowed (returns false, never throws)', async () => {
    h.state.fail = true; // the PG probe rejects
    await expect(
      ensureInboxWakeArmedForActiveSession({ ownerId: 'su-heal-5' }),
    ).resolves.toBe(false);
    expect(upsertInboxWakeAwait).not.toHaveBeenCalled();
  });
});
