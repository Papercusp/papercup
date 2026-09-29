/**
 * Wire-parse coverage for the desktop-perf ingest route
 * (no-http-anywhere-2026-07-28 P-003c).
 *
 * WHY THIS FILE EXISTS. `parseMeasure` REBUILDS its result field by field instead
 * of spreading the wire object, so any field not named in it is dropped silently.
 * That is the correct posture for untrusted input, but it makes the `invariant`
 * flag a uniquely quiet failure: a dropped flag does not error, does not warn, and
 * does not change the recorded value — the run still ingests and still looks
 * healthy. It only shows up much later, as a release gate that observed a breached
 * invariant and let the deploy through, because by the time the gate read the row
 * the measure was an ordinary budget again.
 *
 * A round-trip assertion is the only thing that catches that class, so it is worth
 * a test file of its own even though the parser is four lines long.
 */
import { describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({ record: vi.fn(), notify: vi.fn() }));
vi.mock('../../../system-health/desktop-perf-runs', () => ({ recordDesktopPerfRun: M.record }));
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: M.notify }));

import route, { hasDesktopPerfOutcomeMeasure, parseBuildSha, parseMeasure } from './testing-desktop-perf-ingest';

const base = { key: 'invariant:webview-http-egress', value: 9, unit: 'count', budget: 0, ok: false };

describe('desktop-perf durable acknowledgement', () => {
  it('waits for persistence but acknowledges without waiting for the optional notification', async () => {
    let commit!: (id: string) => void;
    let notify!: () => void;
    M.record.mockReset().mockReturnValue(new Promise<string>((resolve) => { commit = resolve; }));
    M.notify.mockReset().mockReturnValue(new Promise<void>((resolve) => { notify = resolve; }));
    let response: Response | undefined;
    const pending = Promise.resolve(route.handler(new Request('http://localhost/api/admin/testing/desktop-perf-runs', {
      method: 'POST', body: JSON.stringify({ measures: [base], workspaceId: 'ws-perf' }),
    }), {} as never)).then((value) => { response = value; });
    try {
      await vi.waitFor(() => expect(M.record).toHaveBeenCalledOnce());
      expect(response).toBeUndefined();
      expect(M.notify).not.toHaveBeenCalled();
      commit('persisted-run');
      await vi.waitFor(() => expect(response?.status).toBe(200), { timeout: 500 });
      expect(await response!.json()).toEqual({ id: 'persisted-run', recorded: 1, status: 'fail' });
      await vi.waitFor(() => expect(M.notify).toHaveBeenCalledWith('desktopPerfTrend', { workspaceId: 'ws-perf' }));
    } finally {
      commit('persisted-run');
      notify();
      await pending;
    }
  });
});

describe('parseMeasure — invariant passthrough (P-003c)', () => {
  it('carries invariant:true through to the persisted measure', () => {
    const parsed = parseMeasure({ ...base, invariant: true });
    expect(parsed).not.toBeNull();
    expect(parsed?.invariant).toBe(true);
    // The rest of the shape must survive unchanged alongside it.
    expect(parsed?.key).toBe('invariant:webview-http-egress');
    expect(parsed?.value).toBe(9);
    expect(parsed?.unit).toBe('count');
    expect(parsed?.budget).toBe(0);
    expect(parsed?.ok).toBe(false);
  });

  it('leaves invariant undefined when the producer omits it', () => {
    const parsed = parseMeasure({ key: 'interaction:plan-popup-open', value: 1800, unit: 'ms', budget: 1500, ok: false });
    expect(parsed).not.toBeNull();
    expect(parsed?.invariant).toBeUndefined();
  });

  it('only a literal true arms the flag — no truthy coercion', () => {
    // A blocking gate must never be armed by a sloppy producer sending "true"/1.
    for (const bogus of ['true', 1, {}, [], 'yes']) {
      expect(parseMeasure({ ...base, invariant: bogus })?.invariant).toBeUndefined();
    }
    expect(parseMeasure({ ...base, invariant: false })?.invariant).toBeUndefined();
  });

  it('still rejects a malformed measure regardless of the flag', () => {
    // Guards the spec's -1 sentinel choice: a non-finite value is rejected, and the
    // route rejects the WHOLE post on one bad measure — which is why the egress
    // spec records -1 rather than NaN for an absent detector.
    expect(parseMeasure({ ...base, value: Number.NaN, invariant: true })).toBeNull();
    expect(parseMeasure({ ...base, value: Number.POSITIVE_INFINITY, invariant: true })).toBeNull();
    expect(parseMeasure({ ...base, unit: 'furlongs', invariant: true })).toBeNull();
    expect(parseMeasure({ ...base, ok: 'no', invariant: true })).toBeNull();
    expect(parseMeasure({ ...base, key: '', invariant: true })).toBeNull();
  });

  it('accepts a budget-less invariant (the gate catches those too)', () => {
    const parsed = parseMeasure({ key: 'invariant:console-errors', value: 3, unit: 'count', budget: null, ok: false, invariant: true });
    expect(parsed?.budget).toBeNull();
    expect(parsed?.invariant).toBe(true);
  });
});

describe('buildSha — measured-binary identity (desktop-perf-measure-candidate-build P-001)', () => {
  const post = (body: Record<string, unknown>) =>
    route.handler(new Request('http://localhost/api/admin/testing/desktop-perf-runs', {
      method: 'POST', body: JSON.stringify({ measures: [base], workspaceId: 'ws-perf', ...body }),
    }), {} as never);

  it('parses absent / null / empty as null (legacy producer, unattributable run)', () => {
    expect(parseBuildSha(undefined)).toBeNull();
    expect(parseBuildSha(null)).toBeNull();
    expect(parseBuildSha('')).toBeNull();
  });

  it('accepts a short or full hex sha and normalises it to lower case', () => {
    expect(parseBuildSha('4223F93')).toBe('4223f93');
    expect(parseBuildSha(' 4223f93417df132eec90ace218a6017f5a97b8b3 ')).toBe('4223f93417df132eec90ace218a6017f5a97b8b3');
  });

  it('flags malformed identities as undefined rather than storing them', () => {
    for (const bogus of ['abc', 'not-a-sha', 'g'.repeat(40), 'a'.repeat(65), 42, {}, ['4223f93']]) {
      expect(parseBuildSha(bogus)).toBeUndefined();
    }
  });

  it('round-trips a valid buildSha into the recorded run', async () => {
    M.record.mockReset().mockResolvedValue('run-with-identity');
    M.notify.mockReset().mockResolvedValue(undefined);
    const res = await post({ buildSha: '4223F93417DF' });
    expect(res.status).toBe(200);
    expect(M.record).toHaveBeenCalledOnce();
    expect(M.record.mock.calls[0][0]).toMatchObject({ buildSha: '4223f93417df', source: 'wdio' });
  });

  it('records buildSha:null when the producer omits it', async () => {
    M.record.mockReset().mockResolvedValue('legacy-run');
    M.notify.mockReset().mockResolvedValue(undefined);
    const res = await post({});
    expect(res.status).toBe(200);
    expect(M.record.mock.calls[0][0]).toMatchObject({ buildSha: null });
  });

  it('rejects the whole post on a malformed buildSha and records nothing', async () => {
    M.record.mockReset();
    const res = await post({ buildSha: 'definitely-not-hex' });
    expect(res.status).toBe(400);
    expect(M.record).not.toHaveBeenCalled();
  });
});

describe('desktop-perf run outcome admission', () => {
  it('rejects host-only context as a vacuous run', () => {
    expect(hasDesktopPerfOutcomeMeasure([
      { key: 'host:psi-cpu-some-avg10-pct:start', value: 0.1, unit: 'count', budget: null, ok: true },
      { key: 'host:loadavg1-not-authoritative:end', value: 12, unit: 'count', budget: null, ok: true },
    ])).toBe(false);
  });

  it('rejects a batch of only host + build stamps (WI-10003815: build: is context too)', () => {
    expect(hasDesktopPerfOutcomeMeasure([
      { key: 'host:psi-cpu-some-avg10-pct:start', value: 0.1, unit: 'count', budget: null, ok: true },
      { key: 'build:packaged-binary-mtime-ms', value: 1_789_600_000_000, unit: 'count', budget: null, ok: true },
    ])).toBe(false);
  });

  it('admits a measured timing or invariant alongside host context', () => {
    const host = { key: 'host:psi-cpu-some-avg10-pct:start', value: 0.1, unit: 'count' as const, budget: null, ok: true };
    expect(hasDesktopPerfOutcomeMeasure([
      host,
      { key: 'interaction:plan-popup-open', value: 300, unit: 'ms', budget: 1500, ok: true },
    ])).toBe(true);
    expect(hasDesktopPerfOutcomeMeasure([
      host,
      { key: 'invariant:webview-http-egress', value: 0, unit: 'count', budget: 0, ok: true, invariant: true },
    ])).toBe(true);
  });
});
