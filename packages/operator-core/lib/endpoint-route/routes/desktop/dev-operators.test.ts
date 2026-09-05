import { afterEach, describe, expect, it } from 'vitest';
import routes from './dev-operators';

const originalProfile = process.env.PAPERCUSP_DISTRIBUTION_PROFILE;
afterEach(() => {
  if (originalProfile === undefined) delete process.env.PAPERCUSP_DISTRIBUTION_PROFILE;
  else process.env.PAPERCUSP_DISTRIBUTION_PROFILE = originalProfile;
});

describe('desktop dev-operators vm-release guard', () => {
  it('refuses preference mutation before parsing or writing in an immutable runtime', async () => {
    process.env.PAPERCUSP_DISTRIBUTION_PROFILE = 'vm-release';
    const post = routes.find((route) => route.method === 'POST');
    expect(post).toBeTruthy();
    const response = await post!.handler(
      new Request('http://127.0.0.1/desktop/dev-operators/set-enabled', {
        method: 'POST',
        body: JSON.stringify({ id: 'staging', enabled: true }),
      }),
      {} as never,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'vm_release_immutable' });
  });
});

describe('EI-19421499550693822: GET serializes the source-tree readback', () => {
  it('carries sourceTree + omitted through the response body, not just the resolver', async () => {
    // vm-release is the one GET path that takes no network probe, so this asserts the
    // PASSTHROUGH (the JSON.stringify field list) hermetically. The resolver's own
    // measured/pending/terminal cases are covered in harness/dev-operators.test.ts.
    process.env.PAPERCUSP_DISTRIBUTION_PROFILE = 'vm-release';
    const get = routes.find((route) => route.method === 'GET');
    expect(get).toBeTruthy();
    const response = await get!.handler(
      new Request('http://127.0.0.1/desktop/dev-operators'),
      {} as never,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      sourceTree?: { status: string; reason?: string };
      omitted?: { id: string; reason: string }[];
    };
    expect(body.ok).toBe(true);
    // Absence must not render as a clean `false` (D-052) — the axis says it was not read.
    expect(body.sourceTree).toEqual({ status: 'not_measured', reason: 'vm-release-distribution' });
    expect(body.omitted?.map((o) => o.id)).toContain('dev');
  });
});
