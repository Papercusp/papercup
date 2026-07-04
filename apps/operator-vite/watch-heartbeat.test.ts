// watch-heartbeat.ts (EI-5202) — the pure path-resolution + payload-construction
// functions that back the dev-watch heartbeat plugin. A wedged-but-running
// `vite build --watch` used to give no signal at all (dist/index.html mtime
// hours/days behind HEAD, no error); this stamps a heartbeat file after every
// rebuild so a future health probe can detect staleness.
import { describe, it, expect } from 'vitest';
import { resolveHeartbeatPath, buildHeartbeatPayload } from './watch-heartbeat';

describe('resolveHeartbeatPath (EI-5202)', () => {
  it('defaults to the watch-singleton default lock path + ".heartbeat" when nothing is set', () => {
    expect(resolveHeartbeatPath({})).toBe('/tmp/papercup-operator-vite-watch.lock.heartbeat');
  });

  it('rides alongside a custom VITE_WATCH_LOCK (the singleton and the heartbeat agree on one location)', () => {
    expect(resolveHeartbeatPath({ VITE_WATCH_LOCK: '/tmp/custom.lock' })).toBe('/tmp/custom.lock.heartbeat');
  });

  it('VITE_WATCH_HEARTBEAT overrides outright, even when VITE_WATCH_LOCK is also set', () => {
    expect(
      resolveHeartbeatPath({ VITE_WATCH_LOCK: '/tmp/custom.lock', VITE_WATCH_HEARTBEAT: '/tmp/explicit.json' }),
    ).toBe('/tmp/explicit.json');
  });

  it('an empty-string override is treated as unset (falls through to the lock-derived default)', () => {
    expect(resolveHeartbeatPath({ VITE_WATCH_HEARTBEAT: '   ' })).toBe(
      '/tmp/papercup-operator-vite-watch.lock.heartbeat',
    );
  });
});

describe('buildHeartbeatPayload (EI-5202)', () => {
  it('carries the given instant as both an epoch-ms and an ISO string, plus the git SHA', () => {
    const nowMs = Date.parse('2026-07-04T00:00:00.000Z');
    const payload = buildHeartbeatPayload(nowMs, 'abc123');
    expect(payload).toEqual({
      builtAtMs: nowMs,
      builtAt: '2026-07-04T00:00:00.000Z',
      gitSha: 'abc123',
    });
  });

  it('a null git SHA (unresolvable, e.g. no .git in this checkout) is carried through, never fatal', () => {
    const payload = buildHeartbeatPayload(0, null);
    expect(payload.gitSha).toBeNull();
    expect(payload.builtAt).toBe('1970-01-01T00:00:00.000Z');
  });
});
