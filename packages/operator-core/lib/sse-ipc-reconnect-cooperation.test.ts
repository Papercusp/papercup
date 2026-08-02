/**
 * Cross-layer integration test for the SSE-over-IPC reconnect fix (D-006).
 *
 * The unit suites prove each layer in isolation; this proves they COOPERATE —
 * the real `createResilientEventSource` (@papercusp/sse) driving the real
 * `IpcEventSource` (@papercusp/desktop-ipc) over a controllable fake dispatch.
 * That cooperation IS the fix, and it can't be observed by either unit suite
 * alone:
 *
 *   - a transient drop (server close / `done`) must keep ONE IpcEventSource
 *     alive (it reconnects internally) — the wrapper must NOT recreate it, or
 *     we're back to a fresh IPC channel + sync re-subscribe per blip (the
 *     dev-IPC flashing);
 *   - a fatal error (readyState CLOSED) must make the wrapper rebuild.
 *
 * Plan: calltool-endpoint-seam-2026-06-01 (Phase D, P-007 / D-006).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createResilientEventSource } from '@papercusp/sse';
import {
  IpcEventSource,
  configureDesktopIpc,
  type DispatchEndpointStreamFn,
  type EndpointStreamEvent,
} from '@papercusp/desktop-ipc';

/** One controllable upstream connection (one `dispatch(...)` call). */
interface Conn {
  push(ev: EndpointStreamEvent): void;
  /** End the generator without a terminal — IpcEventSource treats as a drop. */
  end(): void;
}

/** A dispatch where each call exposes its own pushable connection. */
function makeDispatch(): { dispatch: DispatchEndpointStreamFn; conns: Conn[] } {
  const conns: Conn[] = [];
  const dispatch: DispatchEndpointStreamFn = async function* () {
    const queue: EndpointStreamEvent[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    conns.push({
      push: (ev) => {
        queue.push(ev);
        wake?.();
        wake = null;
      },
      end: () => {
        ended = true;
        wake?.();
        wake = null;
      },
    });
    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (ended) return;
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  };
  return { dispatch, conns };
}

/** EventSource ctor that builds an IpcEventSource over `dispatch`, tracked in `made`. */
function makeCtor(dispatch: DispatchEndpointStreamFn, made: IpcEventSource[]): typeof EventSource {
  return class {
    constructor(url: string) {
      const es = new IpcEventSource(url, { dispatch, reconnectMs: 5 });
      made.push(es);
      // A constructor that returns an object makes `new Ctor()` yield it.
      return es as unknown as EventSource;
    }
  } as unknown as typeof EventSource;
}

async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 3));
  }
}

const HEAD_OK: EndpointStreamEvent = {
  kind: 'event',
  name: 'head',
  data: { status: 200, headers: { 'content-type': 'text/event-stream' } },
};

// WI-6257 added a STARTUP GRACE (DEFAULT_IPC_STARTUP_GRACE_MS = 3000): for the
// first few seconds of a source's life, "IPC isn't up yet" (`invoke_failed`) is
// RETRIED rather than treated as a dead backend, because the webview opens its
// streams before the Rust IPC handle has connected. Correct — but it made the
// fatal path below unreachable from a test, whose whole `waitFor` budget (1500ms)
// fits inside the grace, so the source never terminated and the wrapper never
// rebuilt (EI-18766012007545598). Each test now pins the grace it means to
// exercise instead of riding the default, and both sides of the branch are
// covered — the grace path is what silently broke the fatal one.
afterEach(() => configureDesktopIpc({ ipcStartupGraceMs: undefined }));

describe('SSE-over-IPC reconnect cooperation (createResilientEventSource × IpcEventSource)', () => {
  it('a transient drop keeps ONE IpcEventSource alive (no wrapper recreate)', async () => {
    const { dispatch, conns } = makeDispatch();
    const made: IpcEventSource[] = [];
    const handle = createResilientEventSource({
      url: '/api/zero-harness/sse',
      handlers: { update: () => {} },
      eventSourceCtor: makeCtor(dispatch, made),
      zombieTimeoutMs: 0, // isolate the error path
      maxConsecutiveFailures: 0,
      initialBackoffMs: 5,
    });

    await waitFor(() => conns.length === 1);
    conns[0]!.push(HEAD_OK);
    await waitFor(() => handle.status === 'open');
    expect(made).toHaveLength(1);

    // Server closes the stream → IpcEventSource drops to CONNECTING and
    // reconnects ITSELF (a 2nd dispatch call = conns[1]).
    conns[0]!.push({ kind: 'done', result: { content: [] } });
    await waitFor(() => conns.length === 2);

    // THE ASSERTION: the wrapper did NOT build a second IpcEventSource — the
    // same one reconnected internally. (The old code closed + recreated here.)
    expect(made).toHaveLength(1);

    conns[1]!.push(HEAD_OK);
    await waitFor(() => handle.status === 'open');
    expect(made).toHaveLength(1); // still one construction, two connects

    handle.close();
  });

  it('a fatal error (readyState CLOSED) DOES make the wrapper rebuild', async () => {
    // Grace 0 = "the bridge has had its chance".
    //
    // The fatal condition here used to be an unavailable BRIDGE
    // (`invoke_failed`/`state not managed`) after the grace. That is no longer
    // fatal: `requireIpc` now defaults ON (WI-6512), and its whole point is that
    // an unreachable bridge stays CONNECTING and retries rather than dying —
    // dying is what handed the stream to native HTTP, where a long-lived SSE
    // connection holds one of libsoup's ~6 sockets for the session.
    //
    // So this test now drives the rebuild with a condition that is terminal in
    // BOTH regimes: a bad HEAD. The bridge worked, the server answered, and the
    // answer was not an event-stream — no amount of waiting fixes that, so
    // IpcEventSource terminates and the wrapper must rebuild. The cooperation
    // being pinned (CLOSED ⇒ wrapper rebuilds) is unchanged; only the way we
    // provoke it had to stop depending on a fallback that no longer exists.
    configureDesktopIpc({ ipcStartupGraceMs: 0 });
    const { dispatch, conns } = makeDispatch();
    const made: IpcEventSource[] = [];
    const handle = createResilientEventSource({
      url: '/api/zero-harness/sse',
      handlers: { update: () => {} },
      eventSourceCtor: makeCtor(dispatch, made),
      zombieTimeoutMs: 0,
      maxConsecutiveFailures: 0,
      initialBackoffMs: 5,
    });

    await waitFor(() => conns.length === 1);
    conns[0]!.push(HEAD_OK);
    await waitFor(() => handle.status === 'open');
    expect(made).toHaveLength(1);

    // Terminal HEAD → IpcEventSource.terminate() sets readyState CLOSED before
    // firing error → the wrapper recognizes the death and rebuilds.
    conns[0]!.push({
      kind: 'event',
      name: 'head',
      data: { status: 500, headers: { 'content-type': 'text/plain' } },
    });
    await waitFor(() => made.length === 2);
    expect(made).toHaveLength(2);

    handle.close();
  });

  it('requireIpc: an unavailable BRIDGE past the grace does NOT kill the source', async () => {
    // The counterpart to the change above, pinned so the old behaviour cannot
    // quietly return. Before WI-6512 this rebuilt the source, and the rebuild
    // is what produced a native-HTTP EventSource holding a socket for the
    // session. Now it stays CONNECTING on the SAME source and waits for the
    // bridge — which is the entire fix for the owner's "clicking an agent takes
    // several seconds".
    configureDesktopIpc({ ipcStartupGraceMs: 0 });
    // requireIpc reports the degraded bridge via console.error ON PURPOSE — a
    // silent degrade is the defect. Assert it happened rather than suppressing
    // it blindly (the suite fails any un-asserted console.error).
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(String(a[0] ?? ''));
    });
    try {
      const { dispatch, conns } = makeDispatch();
      const made: IpcEventSource[] = [];
      const handle = createResilientEventSource({
        url: '/api/zero-harness/sse',
        handlers: { update: () => {} },
        eventSourceCtor: makeCtor(dispatch, made),
        zombieTimeoutMs: 0,
        maxConsecutiveFailures: 0,
        initialBackoffMs: 5,
      });

      await waitFor(() => conns.length === 1);
      conns[0]!.push({ kind: 'error', code: 'invoke_failed', message: 'state not managed' });
      // WI-6685: this used to be a fixed `setTimeout(r, 80)` sleep — a real-time
      // race against the async warn-once chain (push -> generator resume -> for-await
      // continuation -> warnIpcUnavailableOnce), unlike every OTHER wait in this file,
      // which polls a predicate via `waitFor`. On a heavily loaded shared dev box a
      // fixed sleep is exactly the kind of margin that occasionally isn't enough (3
      // failures observed within one 7-minute window under load, zero in the ~120
      // other recorded runs before/since — EI-18869662206197947). Waiting on the
      // actual condition removes the timing dependency entirely instead of just
      // widening the margin.
      await waitFor(() => errors.length > 0);
      expect(made).toHaveLength(1);
      expect(made[0]!.readyState).toBe(0); // CONNECTING, not CLOSED
      expect(errors.some((e) => e.includes('IPC bridge unavailable'))).toBe(true);

      handle.close();
    } finally {
      spy.mockRestore();
    }
  });

  it('WI-6257: INSIDE the startup grace the same error WAITS for the bridge — no rebuild, no native fallback', async () => {
    // The other half of the branch, and the one whose absence let the grace land
    // while silently disabling the fatal-path test above. A boot-era stream that
    // races the IPC handshake must retry on the SAME source: rebuilding would
    // hand it to native HTTP, and a long-lived SSE connection then holds one of
    // libsoup's ~6 per-host sockets for the life of the page — the starvation
    // WI-6257 exists to prevent.
    configureDesktopIpc({ ipcStartupGraceMs: 3_000 });
    const { dispatch, conns } = makeDispatch();
    const made: IpcEventSource[] = [];
    const handle = createResilientEventSource({
      url: '/api/zero-harness/sse',
      handlers: { update: () => {} },
      eventSourceCtor: makeCtor(dispatch, made),
      zombieTimeoutMs: 0,
      maxConsecutiveFailures: 0,
      initialBackoffMs: 5,
    });

    await waitFor(() => conns.length === 1);
    conns[0]!.push(HEAD_OK);
    await waitFor(() => handle.status === 'open');
    expect(made).toHaveLength(1);

    // "Not up YET" → the source re-dispatches on ITSELF rather than dying.
    conns[0]!.push({ kind: 'error', code: 'invoke_failed', message: 'state not managed' });
    await waitFor(() => conns.length === 2);

    // THE ASSERTION: a retry on the same source, NOT a wrapper rebuild.
    expect(made).toHaveLength(1);

    // And it still works once the bridge comes up.
    conns[1]!.push(HEAD_OK);
    await waitFor(() => handle.status === 'open');
    expect(made).toHaveLength(1);

    handle.close();
  });
});
