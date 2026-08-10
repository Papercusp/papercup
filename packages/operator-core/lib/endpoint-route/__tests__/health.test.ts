/**
 * GET /health — operator liveness probe (agent-coordination-architecture-v2
 * §10 / Q-5). The OMP coordination extension hits this to choose
 * attached vs detached mode, so the contract is locked here:
 *   - 200, no auth, no DB
 *   - { ok: true, service: 'papercusp-operator', ts: <ISO> }
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import miscHealth from '../routes/misc/health';
import { __resetBundleStalenessCacheForTests } from '../../bundle-staleness';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(): Hono {
  const app = new Hono();
  registerRoute(app, miscHealth as AnyRoute);
  return app;
}

describe('GET /health', () => {
  it('answers 200 with the liveness payload', async () => {
    const resp = await appWith().request('/health');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      service: string;
      ts: string;
    };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('papercusp-operator');
    // ts is a parseable ISO timestamp.
    expect(Number.isNaN(Date.parse(body.ts))).toBe(false);
  });

  it('requires no auth header', async () => {
    // No Authorization header at all — a probe must still answer.
    const resp = await appWith().request('/health');
    expect(resp.status).toBe(200);
  });
});

/**
 * EI-20093985382484201 — the probe must SAY when this process is serving a
 * bundle that is not the tree it was built from.
 *
 * bundle-host.sh (ExecStartPre for :3070/:3170/:3270) now boots the
 * last-known-good bundle when esbuild fails, instead of refusing to start — one
 * agent's mid-edit syntax error used to take :3170 down fleet-wide, measured
 * twice on 2026-08-10 alone. That trades an outage for a subtler hazard: an
 * agent verifies a fix against a process still running PRE-FIX code and
 * concludes the fix works. The trade only holds while the staleness is
 * impossible to miss, so this field IS the other half of that change.
 *
 * `sha` above cannot substitute — it reports the CHECKOUT, which has already
 * moved on to the very code that failed to build.
 */
describe('GET /health — bundle staleness', () => {
  let dir: string;
  let marker: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'health-bundle-stale-'));
    marker = join(dir, '.bundle-stale.json');
    process.env.PAPERCUSP_BUNDLE_STALE_MARKER = marker;
    __resetBundleStalenessCacheForTests();
  });

  afterEach(() => {
    delete process.env.PAPERCUSP_BUNDLE_STALE_MARKER;
    __resetBundleStalenessCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  async function body(): Promise<Record<string, unknown>> {
    const resp = await appWith().request('/health');
    expect(resp.status).toBe(200);
    return (await resp.json()) as Record<string, unknown>;
  }

  it('OMITS bundleStale entirely on a healthy process', async () => {
    // Absent, not `null`: a field that is always present forces every consumer
    // to distinguish null-from-missing, and healthy is ~100% of reads.
    expect('bundleStale' in (await body())).toBe(false);
  });

  it('reports bundleStale — naming the files to fix — when the marker is present', async () => {
    writeFileSync(
      marker,
      JSON.stringify({
        schema: 'bundle-stale-v1',
        failedAt: '2026-08-10T18:58:47.000Z',
        entry: 'bin/hono-host.ts',
        outfile: '/x/dist-host/hono-host.mjs',
        servingBundleMtime: '2026-08-10T17:00:00.000Z',
        servingBundleAgeSecAtFailure: 6527,
        failingFiles: ['../../packages/operator-core/lib/agent-tools/templates/new-app.ts:333:688'],
        error: '✘ [ERROR] Expected "}" but found "s"',
      }),
    );

    const b = await body();
    // Still ok:true and still 200 — the service IS serving traffic. The point
    // is that it now says WHAT it is serving.
    expect(b.ok).toBe(true);
    const stale = b.bundleStale as Record<string, unknown>;
    expect(stale.failingFiles).toEqual([
      '../../packages/operator-core/lib/agent-tools/templates/new-app.ts:333:688',
    ]);
    expect(stale.servingBundleMtime).toBe('2026-08-10T17:00:00.000Z');
  });

  it('holds the zero-dependency contract on a corrupt marker — reports stale, never 500s', async () => {
    // A liveness probe must answer even half-init, so an unreadable marker
    // degrades to a reported staleness rather than taking the probe down. It
    // must NOT degrade to "healthy": that is the one reading this whole change
    // exists to prevent.
    writeFileSync(marker, 'not json at all');
    const b = await body();
    expect(b.ok).toBe(true);
    expect(b.bundleStale).toBeTruthy();
  });
});
