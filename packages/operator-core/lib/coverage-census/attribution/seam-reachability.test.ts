/**
 * THE POSITIVE CONTROL for coverage attribution — plan
 * design-to-code-coverage-seam-2026-09-02 (P-006).
 *
 * WHY THIS FILE EXISTS. `harness_shared.coverage_evidence` holds ZERO rows while
 * `harness_shared.testing_surfaces` holds ~2,000 live, freshly-censused surfaces. That zero has
 * at least four mutually-exclusive explanations, and NOTHING in the tree could tell them apart:
 *
 *   1. attribution was never armed in the process that ran the tests;
 *   2. it was armed, but no test drives a route/tool seam, so nothing is ever observed;
 *   3. traffic IS observed, but the flush stands down (the unit layer's no-real-PG rail);
 *   4. it flushes, but every row is dropped as an unmatched surface at the census join.
 *
 * An empty table is the SAME OBSERVATION under all four. P-006 names the hazard exactly: "a
 * still-zero result after arming means the seam is not reached, NOT that coverage is zero."
 * You cannot act on that distinction without an instrument that FAILS when the seam is broken
 * — which is what a positive control is. Before this file, `sink.test.ts` drove the sink's own
 * `recordHttpTraffic`/`recordMcpTraffic` entry points directly and `pg-evidence-store.integration.test.ts`
 * drove the store directly; both halves were pinned and the SEAM BETWEEN THEM — does real route
 * traffic actually reach the sink through the real call site — was pinned by nothing. That gap
 * is this plan's own thesis (two records, each individually gated, with the space between them
 * unowned) applied to its own instrumentation.
 *
 * WHAT IS AND IS NOT PROVEN HERE. These tests drive the REAL `registerRoute` → `runRouteStack`
 * path with a throwaway Hono app, so a passing run is evidence that explanation (2) is false
 * FOR THE HTTP SEAM in a process where arming reached the fork. Each positive assertion is
 * paired with a negative control that must observe nothing, so a test that silently stopped
 * exercising anything fails instead of passing vacuously.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mirrors `endpoint-route/__tests__/route-stack.test.ts`: the route stack imports these at
// module scope, and the real modules reach auth state and Postgres — neither is the subject.
vi.mock('../../auth/require-principal', async () => {
  const actual =
    await vi.importActual<typeof import('../../auth/require-principal')>(
      '../../auth/require-principal',
    );
  return { ...actual, requirePrincipal: vi.fn() };
});
vi.mock('../../auth/principal/from-cookie', () => ({
  principalFromCookie: vi.fn(async () => null),
}));
// Route telemetry writes to PG and is a DIFFERENT observer from the one under test. Mocking it
// also keeps the two apart: if attribution ever regressed into piggybacking on telemetry, this
// mock would make these tests fail rather than hide it.
vi.mock('../../endpoint-route/telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('@papercusp/flags/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/flags/server')>();
  return { ...actual, getFlag: vi.fn(async () => true) };
});

import { defineTool } from '@papercusp/agent-mcp';
import { registerRoute } from '../../endpoint-route/define-route';
import {
  ATTRIBUTION_ENV,
  FORBID_REAL_PG_ENV,
  resetAttributionArmingForTests,
  setAmbientTestContext,
} from './context';
import {
  HTTP_ROUTE_KIND,
  MCP_TOOL_KIND,
  attributionStatus,
  flushTrafficEvidence,
  peekBufferedEvidence,
  recordMcpTraffic,
  resetAttributionSinkForTests,
  setEvidenceStoreForTests,
  type EvidenceStore,
} from './sink';

/** The probe surface. Deliberately not a real route: a real one would make the assertion
 *  depend on whichever product route happened to survive a refactor. */
const PROBE_PATH = '/attribution-seam-probe';
const PROBE_SURFACE = `GET ${PROBE_PATH}`;

function probeApp(): Hono {
  const app = new Hono();
  registerRoute(
    app,
    defineTool({
      method: 'GET',
      path: PROBE_PATH,
      auth: 'public',
      handler: () => Response.json({ ok: true }),
    }),
  );
  return app;
}

function arm(): void {
  process.env[ATTRIBUTION_ENV] = '1';
  resetAttributionArmingForTests();
}

function disarm(): void {
  delete process.env[ATTRIBUTION_ENV];
  resetAttributionArmingForTests();
}

let priorArming: string | undefined;
let priorRail: string | undefined;

beforeEach(() => {
  priorArming = process.env[ATTRIBUTION_ENV];
  priorRail = process.env[FORBID_REAL_PG_ENV];
  resetAttributionSinkForTests();
  setAmbientTestContext(null);
});

afterEach(() => {
  resetAttributionSinkForTests();
  setAmbientTestContext(null);
  if (priorArming === undefined) delete process.env[ATTRIBUTION_ENV];
  else process.env[ATTRIBUTION_ENV] = priorArming;
  if (priorRail === undefined) delete process.env[FORBID_REAL_PG_ENV];
  else process.env[FORBID_REAL_PG_ENV] = priorRail;
  resetAttributionArmingForTests();
  vi.clearAllMocks();
});

describe('the HTTP seam is actually reached by real route traffic', () => {
  it('observes a route call made through registerRoute → runRouteStack', async () => {
    arm();
    const res = await probeApp().request(PROBE_PATH);
    // Guard the DRIVE before asserting on the OBSERVATION: a 500 here would buffer an
    // `error` row and still satisfy a bare "something was observed" assertion, which is how
    // a positive control quietly stops proving what it claims.
    expect(res.status).toBe(200);

    const observed = peekBufferedEvidence().filter((b) => b.kind === HTTP_ROUTE_KIND);
    expect(observed.map((b) => b.surfaceId)).toContain(PROBE_SURFACE);
    expect(observed.find((b) => b.surfaceId === PROBE_SURFACE)?.verdict).toBe('pass');
  });

  it('NEGATIVE CONTROL: the identical drive observes nothing while disarmed', async () => {
    disarm();
    const res = await probeApp().request(PROBE_PATH);
    expect(res.status).toBe(200);
    expect(peekBufferedEvidence()).toEqual([]);
    expect(attributionStatus().armed).toBe(false);
  });

  it('stamps the ambient test identity onto the observation', async () => {
    arm();
    setAmbientTestContext({ file: 'lib/probe.test.ts', case: 'a named case' });
    const res = await probeApp().request(PROBE_PATH);
    expect(res.status).toBe(200);

    const row = peekBufferedEvidence().find((b) => b.surfaceId === PROBE_SURFACE);
    // Without this, a row still lands but joins to no test — coverage that credits no test is
    // worse than a gap, because it reads as evidence.
    expect(row?.testFile).toBe('lib/probe.test.ts');
    expect(row?.testCase).toBe('a named case');
  });

  it('collapses repeated calls to one binding rather than one row per call', async () => {
    arm();
    const app = probeApp();
    await app.request(PROBE_PATH);
    await app.request(PROBE_PATH);
    await app.request(PROBE_PATH);

    const rows = peekBufferedEvidence().filter((b) => b.surfaceId === PROBE_SURFACE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.calls).toBe(3);
  });
});

describe('observation reaches the store through the real flush path', () => {
  it('delivers the route observation to an injected store', async () => {
    arm();
    const written: Array<{ kind: string; surfaceId: string }> = [];
    const store: EvidenceStore = {
      write: async (_scope, rows) => {
        for (const r of rows) written.push({ kind: r.kind, surfaceId: r.surfaceId });
        return { written: rows.length, unmatchedSurfaces: 0 };
      },
    };
    // An injected store also lifts the no-real-PG rail (`realPgForbidden()` is
    // `!state.store && …`), which is what lets the WHOLE chain run in the unit layer.
    setEvidenceStoreForTests(store);

    const res = await probeApp().request(PROBE_PATH);
    expect(res.status).toBe(200);
    await flushTrafficEvidence();

    expect(written.map((w) => `${w.kind} ${w.surfaceId}`)).toContain(
      `${HTTP_ROUTE_KIND} ${PROBE_SURFACE}`,
    );
    const status = attributionStatus();
    expect(status.written).toBeGreaterThan(0);
    expect(status.lastError).toBeNull();
  });

  it('carries an MCP tool observation over the same path', async () => {
    arm();
    const written: string[] = [];
    setEvidenceStoreForTests({
      write: async (_scope, rows) => {
        for (const r of rows) written.push(`${r.kind} ${r.surfaceId}`);
        return { written: rows.length, unmatchedSurfaces: 0 };
      },
    });

    recordMcpTraffic({ toolName: 'plans:get', status: 'ok' });
    await flushTrafficEvidence();

    expect(written).toContain(`${MCP_TOOL_KIND} plans:get`);
  });
});

describe('the unit layer cannot write evidence, and says so rather than looking empty', () => {
  it('stands down on the no-real-PG rail and reports why', async () => {
    // THE FINDING P-006 EXISTS TO SURFACE. `npm run test:affected` (and therefore the
    // green-checkpoint gate, whose greenCmd defaults to it) runs the UNIT lane, and
    // `defineVitestConfig` wires `setup-no-real-pg.ts` into exactly that lane, pinning
    // PAPERCUSP_FORBID_REAL_PG=1. Arming attribution there can never produce a row — not
    // because no test drives a seam, but because the flush is DESIGNED to stand down. So a
    // zero from the unit lane is not a measurement of coverage at all.
    arm();
    setEvidenceStoreForTests(null);
    process.env[FORBID_REAL_PG_ENV] = '1';

    const res = await probeApp().request(PROBE_PATH);
    expect(res.status).toBe(200);
    // Observation still happens — the rail gates the STORE, not the hooks.
    expect(peekBufferedEvidence().length).toBeGreaterThan(0);

    await flushTrafficEvidence();

    const status = attributionStatus();
    expect(status.disabled).toBe(true);
    expect(status.written).toBe(0);
    expect(status.buffered).toBe(0);
    expect(status.lastError).toContain(FORBID_REAL_PG_ENV);
  });

  it('NEGATIVE CONTROL: without the rail the same flush is not stood down', async () => {
    arm();
    delete process.env[FORBID_REAL_PG_ENV];
    setEvidenceStoreForTests({
      write: async (_scope, rows) => ({ written: rows.length, unmatchedSurfaces: 0 }),
    });

    await probeApp().request(PROBE_PATH);
    await flushTrafficEvidence();

    const status = attributionStatus();
    expect(status.disabled).toBe(false);
    expect(status.written).toBeGreaterThan(0);
  });
});
