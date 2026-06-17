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

import { armInboxWake, cancelInboxWake } from './inbox-wake-arm';
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

  it('note + workspaceId flow into the upsert; default note when omitted', async () => {
    await armInboxWake({ ownerId: 'su-bee', note: 'idle now', workspaceId: 'ws-7' });
    expect(upsertInboxWakeAwait).toHaveBeenCalledWith(expect.objectContaining({ note: 'idle now', workspaceId: 'ws-7' }));
    vi.clearAllMocks();
    await armInboxWake({ ownerId: 'su-bee' });
    const call = vi.mocked(upsertInboxWakeAwait).mock.calls[0][0];
    expect(call.note).toMatch(/always-armed inbox-wake/);
  });
});

describe('cancelInboxWake', () => {
  it('delegates to cancelInboxWakeAwaits(owner, workspaceId) and returns the rows cancelled', async () => {
    const n = await cancelInboxWake('su-bee', 'ws-7');
    expect(cancelInboxWakeAwaits).toHaveBeenCalledWith('su-bee', 'ws-7');
    expect(n).toBe(2);
  });
});
