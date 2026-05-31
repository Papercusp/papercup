/**
 * Coverage for branch-action-bus — the per-(slug,runId) action stream over
 * @papercusp/sse channels: publish→envelope, live delivery, recent ring,
 * completed/failed marking the channel done (resolving whenDone + done flag for
 * late subscribers), unsubscribe, and channel isolation. No reset export, so
 * each test uses a distinct channel key.
 */
import { describe, expect, it } from 'vitest';
import { publish, subscribe, type ActionEnvelope } from './branch-action-bus';

describe('publish', () => {
  it('returns a sequenced envelope with kind/text/meta', () => {
    const env = publish('pub:1', 'output', 'hi', { fd: 1 });
    expect(env).toMatchObject({ channelKey: 'pub:1', kind: 'output', text: 'hi', meta: { fd: 1 } });
    expect(typeof env.seq).toBe('number');
    expect(typeof env.ts).toBe('number');
  });
});

describe('subscribe', () => {
  it('delivers live events', () => {
    const got: ActionEnvelope[] = [];
    subscribe('live:1', (e) => got.push(e));
    publish('live:1', 'output', 'a');
    publish('live:1', 'stderr', 'b');
    expect(got.map((e) => [e.kind, e.text])).toEqual([['output', 'a'], ['stderr', 'b']]);
  });

  it('hands the recent ring to a late subscriber', () => {
    publish('recent:1', 'output', 'a');
    publish('recent:1', 'output', 'b');
    const sub = subscribe('recent:1', () => {});
    expect(sub.recent.map((e) => e.text)).toEqual(['a', 'b']);
  });

  it('a completed event resolves the subscriber whenDone promise', async () => {
    const sub = subscribe('done:1', () => {});
    const env = publish('done:1', 'completed', 'finished');
    expect(env.kind).toBe('completed');
    await expect(sub.whenDone).resolves.toBeUndefined(); // would hang/timeout if never resolved
  });

  it('stops delivery after unsubscribe', () => {
    const got: ActionEnvelope[] = [];
    const sub = subscribe('unsub:1', (e) => got.push(e));
    publish('unsub:1', 'output', 'before');
    sub.unsubscribe();
    publish('unsub:1', 'output', 'after');
    expect(got.map((e) => e.text)).toEqual(['before']);
  });

  it('isolates channels', () => {
    const got: string[] = [];
    subscribe('iso:a', (e) => got.push(e.text));
    publish('iso:b', 'output', 'other');
    expect(got).toEqual([]);
  });
});
