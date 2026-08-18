/**
 * Unit tests for the attribution sink — arming, verdict mapping, and caller resolution.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-004).
 *
 * THE TWO PROPERTIES WORTH THE MOST HERE:
 *   1. DISARMED MEANS INERT. Both hooks sit inside production dispatch paths, so "records
 *      nothing when the env var is unset" is a production-safety claim, not a nicety.
 *   2. A GATE REJECTION IS NOT COVERAGE. `unauthorized`/`forbidden`/`quota-exceeded`/
 *      `role-not-allowed`/`replayed` must map to `skip`, because a test that only ever gets a
 *      401 from a route has not exercised it. Mapping those to `pass` is the single change that
 *      would manufacture the false confidence this census exists to prevent, so each is pinned.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTRIBUTION_ENV, resetAttributionArmingForTests, setAmbientTestContext } from './context';
import {
  peekBufferedEvidence,
  recordHttpTraffic,
  recordMcpTraffic,
  resetAttributionSinkForTests,
  verdictForRouteStatus,
  verdictForToolStatus,
} from './sink';

/** A minimal `Headers`-like bag; the hook only ever calls `.get()`. */
const headers = (entries: Record<string, string>) => ({
  get: (name: string) => entries[name.toLowerCase()] ?? null,
});

function arm(): void {
  process.env[ATTRIBUTION_ENV] = '1';
  resetAttributionArmingForTests();
}

function disarm(): void {
  delete process.env[ATTRIBUTION_ENV];
  resetAttributionArmingForTests();
}

beforeEach(() => {
  // The sink's state is pinned to the realm, and the pure lane shares a fork's module registry
  // across files — so without an explicit reset one file's buffered rows would leak into the
  // next file's assertions.
  resetAttributionSinkForTests();
  setAmbientTestContext(null);
  disarm();
});

afterEach(() => {
  resetAttributionSinkForTests();
  setAmbientTestContext(null);
  disarm();
});

describe('arming', () => {
  it('records NOTHING when the env var is unset', () => {
    recordHttpTraffic({ method: 'get', path: '/api/widgets', status: 'ok', httpStatus: 200 });
    recordMcpTraffic({ toolName: 'widgets:list', status: 'ok' });
    expect(peekBufferedEvidence()).toHaveLength(0);
  });

  it('records only when the env var is exactly "1"', () => {
    process.env[ATTRIBUTION_ENV] = 'true';
    resetAttributionArmingForTests();
    recordHttpTraffic({ method: 'get', path: '/api/widgets', status: 'ok' });
    expect(peekBufferedEvidence()).toHaveLength(0);

    arm();
    recordHttpTraffic({ method: 'get', path: '/api/widgets', status: 'ok' });
    expect(peekBufferedEvidence()).toHaveLength(1);
  });
});

describe('surface identity', () => {
  it('builds the http-route id exactly as the census provider does', () => {
    // `providers/hono-routes.ts` uses `${method.toUpperCase()} ${path}` over the MOUNTED path.
    // If these two ever diverge, evidence silently joins to nothing.
    arm();
    recordHttpTraffic({ method: 'get', path: '/api/widgets/:id', status: 'ok' });
    expect(peekBufferedEvidence()[0]).toMatchObject({
      kind: 'http-route',
      surfaceId: 'GET /api/widgets/:id',
    });
  });

  it('uses the bare tool name as the mcp-tool id', () => {
    arm();
    recordMcpTraffic({ toolName: 'plans:export', status: 'ok' });
    expect(peekBufferedEvidence()[0]).toMatchObject({
      kind: 'mcp-tool',
      surfaceId: 'plans:export',
    });
  });
});

describe('verdictForRouteStatus — did the handler actually run?', () => {
  it('counts a handled response as coverage', () => {
    expect(verdictForRouteStatus('ok')).toBe('pass');
    // Rejecting bad input IS the route's declared schema behaving — the stack reached the
    // route's own contract.
    expect(verdictForRouteStatus('invalid-input')).toBe('pass');
  });

  it('does NOT count an auth rejection as coverage', () => {
    expect(verdictForRouteStatus('unauthorized')).toBe('skip');
    expect(verdictForRouteStatus('forbidden')).toBe('skip');
  });

  it('reports a throw or timeout as error', () => {
    expect(verdictForRouteStatus('error')).toBe('error');
    expect(verdictForRouteStatus('timeout')).toBe('error');
  });
});

describe('verdictForToolStatus — did the handler actually run?', () => {
  it('counts a run handler as coverage, including a business-level refusal', () => {
    expect(verdictForToolStatus('ok')).toBe('pass');
    expect(verdictForToolStatus('refused')).toBe('pass');
    expect(verdictForToolStatus('invalid-input')).toBe('pass');
  });

  it('does NOT count a gate rejection or a replayed result as coverage', () => {
    expect(verdictForToolStatus('quota-exceeded')).toBe('skip');
    expect(verdictForToolStatus('role-not-allowed')).toBe('skip');
    // The replay store answered and the tool never ran — crediting it would let an idempotency
    // retry manufacture coverage for a call that executed nothing.
    expect(verdictForToolStatus('replayed')).toBe('skip');
  });

  it('reports an UNKNOWN status as error rather than silently passing', () => {
    // A new member of the dispatcher's status union that nobody taught this mapping must not
    // default into 'pass', which would quietly credit coverage for an unclassified outcome.
    expect(verdictForToolStatus('some-future-status')).toBe('error');
  });
});

describe('caller resolution', () => {
  it('uses the ambient test context for an in-process call', () => {
    arm();
    setAmbientTestContext({ file: 'packages/operator-core/lib/x.test.ts', case: 'does a thing' });
    recordHttpTraffic({ method: 'GET', path: '/api/a', status: 'ok' });

    expect(peekBufferedEvidence()[0]).toMatchObject({
      testFile: 'packages/operator-core/lib/x.test.ts',
      testCase: 'does a thing',
    });
  });

  it('lets explicit headers OVERRIDE the ambient context', () => {
    // The cross-process case: the operator may itself be running under a test harness, but the
    // caller is the only one who knows which test is really driving this request.
    arm();
    setAmbientTestContext({ file: 'ambient.test.ts', case: 'ambient case' });
    recordHttpTraffic({
      method: 'GET',
      path: '/api/a',
      status: 'ok',
      headers: headers({
        'x-papercusp-test-run-group': 'run-from-header',
        'x-papercusp-test-file': 'remote.test.ts',
        'x-papercusp-test-case': 'remote case',
      }),
    });

    expect(peekBufferedEvidence()[0]).toMatchObject({
      runGroupId: 'run-from-header',
      testFile: 'remote.test.ts',
      testCase: 'remote case',
    });
  });

  it('still records a row when no test identity resolves at all', () => {
    // "Something in this run hit this surface" is weaker evidence, not absent evidence — and
    // migration 846 documents a NULL test_case as exactly that file-level-only case.
    arm();
    recordHttpTraffic({ method: 'GET', path: '/api/a', status: 'ok' });
    expect(peekBufferedEvidence()[0]).toMatchObject({ testFile: null, testCase: null });
  });
});

describe('hook safety', () => {
  it('never throws when the header bag misbehaves', () => {
    arm();
    const hostile = {
      get() {
        throw new Error('hostile header bag');
      },
    };
    expect(() =>
      recordHttpTraffic({ method: 'GET', path: '/api/a', status: 'ok', headers: hostile }),
    ).not.toThrow();
  });

  it('keeps the route status and http status on the row for later triage', () => {
    arm();
    recordHttpTraffic({ method: 'GET', path: '/api/a', status: 'invalid-input', httpStatus: 400 });
    expect(peekBufferedEvidence()[0].details).toMatchObject({
      routeStatus: 'invalid-input',
      httpStatus: 400,
    });
  });
});
