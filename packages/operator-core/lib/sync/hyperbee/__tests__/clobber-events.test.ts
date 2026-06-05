import { afterEach, describe, expect, it } from 'vitest';
import {
  clobberEvents,
  observeMergedOp,
  recordLocalWrite,
  tupleGreater,
  _resetForTests,
  _setNowForTests,
  _trackerSizeForTests,
  type ClobberEvent,
} from '../clobber-events';

afterEach(() => _resetForTests());

describe('tupleGreater', () => {
  it('later ts wins regardless of pubkey', () => {
    expect(
      tupleGreater(
        { table: 't', hbKey: 'k', ts: 2, pubkey: 'a' },
        { table: 't', hbKey: 'k', ts: 1, pubkey: 'z' },
      ),
    ).toBe(true);
  });

  it('on ts tie, lexically-greater pubkey wins', () => {
    expect(
      tupleGreater(
        { table: 't', hbKey: 'k', ts: 5, pubkey: 'z' },
        { table: 't', hbKey: 'k', ts: 5, pubkey: 'a' },
      ),
    ).toBe(true);
    expect(
      tupleGreater(
        { table: 't', hbKey: 'k', ts: 5, pubkey: 'a' },
        { table: 't', hbKey: 'k', ts: 5, pubkey: 'z' },
      ),
    ).toBe(false);
  });

  it('equal tuple is not greater', () => {
    expect(
      tupleGreater(
        { table: 't', hbKey: 'k', ts: 5, pubkey: 'a' },
        { table: 't', hbKey: 'k', ts: 5, pubkey: 'a' },
      ),
    ).toBe(false);
  });
});

describe('observeMergedOp — no tracker entry', () => {
  it('returns false when no local write was recorded for the key', () => {
    expect(
      observeMergedOp({ table: 't', hbKey: 'k', ts: 100, pubkey: 'remote' }),
    ).toBe(false);
  });
});

describe('observeMergedOp — clobber detection', () => {
  it('emits clobber when remote has later ts than recent local write', () => {
    _setNowForTests(() => 1_000);
    const events: ClobberEvent[] = [];
    clobberEvents.on('clobber', (e) => events.push(e));
    recordLocalWrite({ table: 'queue', hbKey: '42/F-1', ts: 1_000, pubkey: 'me' });
    _setNowForTests(() => 1_500);
    const fired = observeMergedOp({
      table: 'queue',
      hbKey: '42/F-1',
      ts: 1_400,
      pubkey: 'remote',
    });
    expect(fired).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].my.pubkey).toBe('me');
    expect(events[0].theirs.pubkey).toBe('remote');
    expect(events[0].observedAt).toBe(1_500);
  });

  it('does NOT emit when remote has earlier ts than my local write', () => {
    _setNowForTests(() => 1_000);
    recordLocalWrite({ table: 'queue', hbKey: 'k', ts: 1_000, pubkey: 'me' });
    const fired = observeMergedOp({
      table: 'queue',
      hbKey: 'k',
      ts: 900,
      pubkey: 'remote',
    });
    expect(fired).toBe(false);
  });

  it('does NOT emit when incoming op is from the same pubkey (self-echo)', () => {
    _setNowForTests(() => 1_000);
    recordLocalWrite({ table: 'queue', hbKey: 'k', ts: 1_000, pubkey: 'me' });
    _setNowForTests(() => 1_005);
    const fired = observeMergedOp({
      table: 'queue',
      hbKey: 'k',
      ts: 1_002,
      pubkey: 'me',
    });
    expect(fired).toBe(false);
  });

  it('does NOT emit when the local write is older than the window', () => {
    _resetForTests({ windowMs: 100 });
    _setNowForTests(() => 1_000);
    recordLocalWrite({ table: 'queue', hbKey: 'k', ts: 1_000, pubkey: 'me' });
    _setNowForTests(() => 5_000); // > 100ms past
    const fired = observeMergedOp({
      table: 'queue',
      hbKey: 'k',
      ts: 4_000,
      pubkey: 'remote',
    });
    expect(fired).toBe(false);
    // Tracker entry should be evicted in the process.
    expect(_trackerSizeForTests()).toBe(0);
  });

  it('does not fire twice for the same local write', () => {
    _setNowForTests(() => 1_000);
    const events: ClobberEvent[] = [];
    clobberEvents.on('clobber', (e) => events.push(e));
    recordLocalWrite({ table: 'queue', hbKey: 'k', ts: 1_000, pubkey: 'me' });
    observeMergedOp({ table: 'queue', hbKey: 'k', ts: 1_100, pubkey: 'a' });
    observeMergedOp({ table: 'queue', hbKey: 'k', ts: 1_200, pubkey: 'b' });
    expect(events).toHaveLength(1);
    expect(events[0].theirs.pubkey).toBe('a');
  });

  it('separate keys do not interfere', () => {
    _setNowForTests(() => 1_000);
    const events: ClobberEvent[] = [];
    clobberEvents.on('clobber', (e) => events.push(e));
    recordLocalWrite({ table: 'queue', hbKey: 'k1', ts: 1_000, pubkey: 'me' });
    recordLocalWrite({ table: 'queue', hbKey: 'k2', ts: 1_000, pubkey: 'me' });
    observeMergedOp({ table: 'queue', hbKey: 'k1', ts: 1_100, pubkey: 'a' });
    expect(events).toHaveLength(1);
    expect(events[0].hbKey).toBe('k1');
  });

  it('different tables on the same hbKey do not interfere', () => {
    _setNowForTests(() => 1_000);
    const events: ClobberEvent[] = [];
    clobberEvents.on('clobber', (e) => events.push(e));
    recordLocalWrite({ table: 'queue', hbKey: 'k', ts: 1_000, pubkey: 'me' });
    observeMergedOp({ table: 'contributors', hbKey: 'k', ts: 1_100, pubkey: 'a' });
    expect(events).toHaveLength(0);
  });
});

describe('recordLocalWrite — FIFO eviction', () => {
  it('caps tracker size at maxEntries', () => {
    _resetForTests({ maxEntries: 3 });
    _setNowForTests(() => 1_000);
    for (let i = 0; i < 5; i++) {
      recordLocalWrite({ table: 't', hbKey: `k${i}`, ts: 1_000, pubkey: 'me' });
    }
    expect(_trackerSizeForTests()).toBe(3);
  });
});
