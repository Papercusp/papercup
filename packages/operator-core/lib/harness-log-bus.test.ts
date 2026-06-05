/**
 * Coverage for harness-log-bus — the in-process per-harness log-line bus over
 * @papercusp/sse's in-memory channels. Exercises publish→envelope, live
 * delivery to subscribers, the recent ring on subscribe, unsubscribe stopping
 * delivery, and per-channel isolation. Real (in-memory) channels; reset per test.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { publish, subscribe, _resetForTest, type LogEnvelope } from './harness-log-bus';

beforeEach(() => _resetForTest());

describe('publish', () => {
  it('returns a sequenced envelope carrying the line', () => {
    const env = publish('h:log', 'hello');
    expect(env.channelKey).toBe('h:log');
    expect(env.line).toBe('hello');
    expect(typeof env.seq).toBe('number');
    expect(typeof env.ts).toBe('number');
  });
});

describe('subscribe', () => {
  it('delivers live lines published after subscribing', () => {
    const got: LogEnvelope[] = [];
    subscribe('h:log', (e) => got.push(e));
    publish('h:log', 'one');
    publish('h:log', 'two');
    expect(got.map((e) => e.line)).toEqual(['one', 'two']);
  });

  it('hands the recent ring to a late subscriber', () => {
    publish('h:log', 'a');
    publish('h:log', 'b');
    const sub = subscribe('h:log', () => {});
    expect(sub.recent.map((e) => e.line)).toEqual(['a', 'b']);
  });

  it('stops delivery after unsubscribe', () => {
    const got: LogEnvelope[] = [];
    const sub = subscribe('h:log', (e) => got.push(e));
    publish('h:log', 'before');
    sub.unsubscribe();
    publish('h:log', 'after');
    expect(got.map((e) => e.line)).toEqual(['before']);
  });

  it('isolates channels', () => {
    const logLines: string[] = [];
    subscribe('h:log', (e) => logLines.push(e.line));
    publish('h:raw', 'raw-line'); // different channel
    expect(logLines).toEqual([]);
  });
});
