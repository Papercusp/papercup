/**
 * GET /__spa/build-id — the server half of the stale-bundle notice (EI-15848).
 *
 * WHAT ONLY AN INTEGRATION TEST CAN CATCH HERE, and why the unit tests on
 * `readBundleIdentity` are not enough:
 *
 *  1. REACHABILITY. `createSpaRoutes` ends in a `get('*')` catch-all that
 *     answers any extension-less path with index.html. If this route were
 *     registered after it — or removed — the endpoint would still respond 200,
 *     with an HTML document instead of JSON. A route that is shadowed does not
 *     look absent; it looks like a working endpoint returning nonsense, and the
 *     client's `typeof buildId === 'string'` guard would quietly render the
 *     whole feature inert rather than fail loudly.
 *  2. THE INJECTION AGREES WITH THE ENDPOINT. The notice compares the id baked
 *     into the shell against the id this route reports. If the two ever came
 *     from different sources they would disagree permanently and the toast
 *     would fire forever. Asserting they are EQUAL for one bundle is what pins
 *     that.
 *  3. IT ACTUALLY MOVES. The load-bearing case is the last one: replace the
 *     bundle, the reported id must CHANGE. Every other assertion here passes
 *     just as happily against a hard-coded constant, which would be a feature
 *     that can never fire.
 *
 * `PAPERCUSP_SPA_DIST` is set before the dynamic import on purpose: the module
 * resolves its dist root once at load time.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INDEX_A = '<html><head><title>a</title></head><body></body></html>';
const INDEX_B = '<html><head><title>b — a different build</title></head><body></body></html>';

// Derived from the real factory rather than hand-written: a structural stand-in
// drifts from Hono's actual `request` overloads and fails to typecheck while the
// suite still runs green (esbuild never typechecks), which is the exact split
// verdict this repo warns about.
type SpaRoutes = ReturnType<typeof import('../../bin/host-spa').createSpaRoutes>;

let dist: string;
let app: SpaRoutes;
let readBundleIdentity: (distRoot: string) => string | null;

const writeIndex = (html: string) => writeFileSync(join(dist, 'index.html'), html, 'utf8');

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'spa-build-id-route-'));
  writeIndex(INDEX_A);
  process.env.PAPERCUSP_SPA_DIST = dist;
  const hostSpa = await import('../../bin/host-spa');
  ({ readBundleIdentity } = await import('../spa-build-status'));
  app = hostSpa.createSpaRoutes();
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

describe('GET /__spa/build-id', () => {
  it('is reachable as JSON — not shadowed by the SPA catch-all', async () => {
    const res = await app.request('/__spa/build-id');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('reports the identity of the bundle on disk', async () => {
    const res = await app.request('/__spa/build-id');
    const body = (await res.json()) as { buildId?: string };
    expect(body.buildId).toBe(readBundleIdentity(dist));
  });

  it('is never cached — a cached answer would report the build that was current when it was cached', async () => {
    const res = await app.request('/__spa/build-id');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('agrees with the id injected into the served shell', async () => {
    const html = await (await app.request('/')).text();
    const injected = html.match(/__PAPERCUSP_BUILD_ID__=("[0-9a-f]+")/)?.[1];
    const body = (await (await app.request('/__spa/build-id')).json()) as { buildId?: string };
    expect(injected).toBe(JSON.stringify(body.buildId));
  });

  it('CHANGES when the bundle is replaced — the falsifier for the whole feature', async () => {
    const before = ((await (await app.request('/__spa/build-id')).json()) as { buildId?: string })
      .buildId;
    writeIndex(INDEX_B);
    const after = ((await (await app.request('/__spa/build-id')).json()) as { buildId?: string })
      .buildId;
    expect(typeof after).toBe('string');
    expect(after).not.toBe(before);
    writeIndex(INDEX_A);
  });
});
