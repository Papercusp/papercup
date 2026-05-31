// @vitest-environment jsdom
/**
 * iframe.test.ts — plugin-sdk iframe postMessage protocol (P-021 of
 * test-coverage-rest-non-critical). The SDK iframe side talks to the operator
 * over tagged postMessage envelopes; this exercises the protocol in jsdom
 * (window.parent === window): the rpc-request → rpc-response round-trip with
 * base64 payloads, typed error rejection, event subscribe/emit/unsubscribe, and
 * the source-window guard that drops messages not from the parent.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initPapercupIframe, usePapercupAction, usePapercupEvent } from './iframe';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let postSpy: any;

/** Dispatch a message as if posted from the parent operator (default source). */
function fromParent(data: unknown, source: Window | null = window.parent) {
  window.dispatchEvent(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new MessageEvent('message', { data, source: source as any }),
  );
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastSent = () => postSpy.mock.calls.at(-1)![0] as any;

beforeAll(() => {
  initPapercupIframe(); // installs the window 'message' listener once
});
beforeEach(() => {
  postSpy = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('plugin-sdk iframe protocol (P-021)', () => {
  it('usePapercupAction posts an rpc-request (b64 payload) and resolves on the matching ok response', async () => {
    const p = usePapercupAction('doThing', enc('ping'));
    const sent = lastSent();
    expect(sent).toMatchObject({ kind: 'rpc-request', action: 'doThing' });
    expect(typeof sent.id).toBe('string');
    expect(atob(sent.payloadB64)).toBe('ping'); // payload base64-round-trips

    fromParent({ kind: 'rpc-response', id: sent.id, ok: true, payloadB64: btoa('pong') });
    expect(dec(await p)).toBe('pong');
  });

  it('usePapercupAction rejects with the typed tag on an error response', async () => {
    const p = usePapercupAction('denied', enc(''));
    const sent = lastSent();
    fromParent({
      kind: 'rpc-response',
      id: sent.id,
      ok: false,
      error: { tag: 'capability-denied', message: 'nope' },
    });
    await expect(p).rejects.toThrow(/capability-denied/);
  });

  it('usePapercupEvent subscribes, receives decoded payloads, and unsubscribes', () => {
    const seen: string[] = [];
    const unsub = usePapercupEvent('thing', (payload) => seen.push(dec(payload)));
    expect(
      postSpy.mock.calls.some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any[]) => c[0]?.kind === 'event-subscribe' && c[0]?.name === 'thing',
      ),
    ).toBe(true);

    fromParent({ kind: 'event', name: 'thing', payloadB64: btoa('data1') });
    expect(seen).toEqual(['data1']);

    unsub();
    expect(
      postSpy.mock.calls.some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (c: any[]) => c[0]?.kind === 'event-unsubscribe' && c[0]?.name === 'thing',
      ),
    ).toBe(true);
    fromParent({ kind: 'event', name: 'thing', payloadB64: btoa('data2') });
    expect(seen).toEqual(['data1']); // no delivery after unsubscribe
  });

  it('ignores a response whose source is not the parent window (source-window guard)', async () => {
    const p = usePapercupAction('guarded', enc(''));
    const sent = lastSent();
    // wrong source — must be dropped (would otherwise consume the pending rpc).
    fromParent({ kind: 'rpc-response', id: sent.id, ok: true, payloadB64: btoa('WRONG') }, null);
    // correct source — this one resolves the promise.
    fromParent({ kind: 'rpc-response', id: sent.id, ok: true, payloadB64: btoa('RIGHT') });
    expect(dec(await p)).toBe('RIGHT');
  });
});
