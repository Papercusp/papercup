/**
 * CSRF guard for POST /desktop/bootstrap-pot/start. `auth: 'loopback'` is
 * source-IP based, so a cross-site browser POST must be refused BEFORE the
 * side-effecting startBootstrapPapercuspHive() runs.
 */
import { describe, it, expect } from 'vitest';
import routes from './bootstrap-hive-start';

const post = (routes as Array<{ method: string; handler: (req: unknown) => Promise<Response> }>).find(
  (r) => r.method === 'POST',
)!;

describe('POST /desktop/bootstrap-pot/start — CSRF guard', () => {
  it('refuses a cross-site request with 403 (no side effect)', async () => {
    const req = new Request('http://127.0.0.1/api/desktop/bootstrap-pot/start', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    const res = await post.handler(req);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'cross_site_forbidden' });
  });

  it('serves no Access-Control-Allow-Origin (same-origin only)', async () => {
    const req = new Request('http://127.0.0.1/api/desktop/bootstrap-pot/start', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    const res = await post.handler(req);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
