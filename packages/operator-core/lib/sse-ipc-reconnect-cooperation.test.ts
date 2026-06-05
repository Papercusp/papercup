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
import { describe, it, expect } from 'vitest';
import { createResilientEventSource } from '@papercusp/sse';
import {
  IpcEventSource,
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

    // Terminal backend error → IpcEventSource.terminate() sets readyState CLOSED
    // before firing error → the wrapper recognizes the death and rebuilds.
    conns[0]!.push({ kind: 'error', code: 'invoke_failed', message: 'state not managed' });
    await waitFor(() => made.length === 2);
    expect(made).toHaveLength(2);

    handle.close();
  });
});
