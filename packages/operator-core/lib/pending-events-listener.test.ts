/**
 * pending-events-listener.test.ts — onPendingEventInserted lifecycle (GAP 14,
 * was ZERO tests).
 *
 * The real module opens a long-lived `postgres()` LISTEN connection once per
 * process and ref-counts handlers. We mock `postgres` so `.listen()` captures
 * the NOTIFY callback (driven directly to simulate pg_notify) and `.end()` is a
 * spy, and mock `./embedded-pg-discovery` for the url. vi.resetModules per test
 * resets the module-scoped started/handlers/listenerSql state.
 *
 * Covers: ref-counted ensureStarted (2 handlers → listen once), maybeCloseListener
 * (closes only at handlers.size===0), bad-JSON.parse swallow, per-handler
 * try/catch isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let capturedChannel: string | null = null;
let capturedListen: ((raw: string) => void) | null = null;
const endSpy = vi.fn(async () => {});
let postgresCallCount = 0;

beforeEach(() => {
  // Hermeticity: this file exercises the DIRECT per-bus `postgres()` LISTEN path
  // (it mocks `postgres` and asserts on its ref-counted open/close). The runner's
  // ambient env may set PAPERCUSP_LISTEN_HUB=1 (and listenHubEnabled() also
  // DEFAULTS ON for server-class hosts), which diverts ensureStarted() onto the
  // shared pg-listen-hub connection whose ref-counting lives elsewhere — breaking
  // this file's assumptions (the green-checkpoint runner has the flag set live).
  // Force the kill-switch ('0', since '' still defaults ON) so the intended path
  // is exercised deterministically regardless of host env.
  vi.stubEnv('PAPERCUSP_LISTEN_HUB', '0');
  vi.resetModules();
  capturedChannel = null;
  capturedListen = null;
  postgresCallCount = 0;
  endSpy.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock('postgres');
  vi.doUnmock('./embedded-pg-discovery');
});

async function load() {
  vi.doMock('postgres', () => ({
    default: () => {
      postgresCallCount += 1;
      return {
        listen: (ch: string, cb: (raw: string) => void) => {
          capturedChannel = ch;
          capturedListen = cb;
          return Promise.resolve();
        },
        end: endSpy,
      };
    },
  }));
  vi.doMock('./embedded-pg-discovery', () => ({ getHarnessAdminUrl: () => 'postgres://test' }));
  return import('./pending-events-listener');
}

const PAYLOAD = {
  id: 'pe-1',
  kind: 'rescan',
  target_role: 'operator',
  workspace_id: 'ws-x',
  due_at: null,
  created_at: '2026-06-16T00:00:00Z',
};

/** ensureStarted/maybeCloseListener are fire-and-forget (void) inside the sync
 *  register/unregister — let the microtask queue drain so listen()/end() land. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('pending-events-listener lifecycle', () => {
  it('two handlers → LISTEN connection opened exactly once, on the right channel', async () => {
    const { onPendingEventInserted } = await load();
    onPendingEventInserted(vi.fn());
    onPendingEventInserted(vi.fn());
    await flush();
    expect(postgresCallCount).toBe(1);
    expect(capturedChannel).toBe('pending_events_inserted');
  });

  it('unregistering one of two handlers keeps the listener OPEN (end not called)', async () => {
    const { onPendingEventInserted } = await load();
    const off1 = onPendingEventInserted(vi.fn());
    onPendingEventInserted(vi.fn());
    await flush();
    off1();
    await flush();
    expect(endSpy).not.toHaveBeenCalled();
  });

  it('unregistering the LAST handler closes the listener (end called)', async () => {
    const { onPendingEventInserted } = await load();
    const off1 = onPendingEventInserted(vi.fn());
    const off2 = onPendingEventInserted(vi.fn());
    await flush();
    off1();
    off2();
    await flush();
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('a malformed (non-JSON) payload is swallowed — no throw, error logged', async () => {
    const { onPendingEventInserted } = await load();
    const h = vi.fn();
    onPendingEventInserted(h);
    await flush();
    expect(() => capturedListen!('not json{')).not.toThrow();
    expect(h).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('bad payload'), expect.anything());
  });

  it('a good payload reaches every registered handler with the parsed event', async () => {
    const { onPendingEventInserted } = await load();
    const a = vi.fn();
    const b = vi.fn();
    onPendingEventInserted(a);
    onPendingEventInserted(b);
    await flush();
    capturedListen!(JSON.stringify(PAYLOAD));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0][0]).toEqual(PAYLOAD);
    expect(b.mock.calls[0][0]).toEqual(PAYLOAD);
  });

  it('a throwing handler is isolated — the other still receives the event, error logged', async () => {
    const { onPendingEventInserted } = await load();
    const boom = vi.fn(() => {
      throw new Error('handler kaboom');
    });
    const ok = vi.fn();
    onPendingEventInserted(boom);
    onPendingEventInserted(ok);
    await flush();
    expect(() => capturedListen!(JSON.stringify(PAYLOAD))).not.toThrow();
    expect(boom).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('handler threw'), expect.anything());
  });

  it('_stopForTests tears down: end called, and a subsequent register reopens a fresh connection', async () => {
    const mod = await load();
    mod.onPendingEventInserted(vi.fn());
    await flush();
    await mod._stopForTests();
    expect(endSpy).toHaveBeenCalled();
    endSpy.mockClear();
    mod.onPendingEventInserted(vi.fn());
    await flush();
    expect(postgresCallCount).toBe(2); // reopened
  });
});
