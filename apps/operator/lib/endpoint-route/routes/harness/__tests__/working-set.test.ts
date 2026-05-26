import { describe, expect, it } from 'vitest';
import routes, { parseWriteBody } from '../working-set';

describe('working-set routes — shape', () => {
  it('exports 3 routes', () => {
    expect(routes).toHaveLength(3);
  });

  it('GET /harness/:slug/working-set', () => {
    const r = routes.find((x) => x.method === 'GET');
    expect(r?.path).toBe('/harness/:slug/working-set');
    expect(r?.auth).toBe('public');
  });

  it('POST set-active', () => {
    const r = routes.find((x) => x.method === 'POST' && x.path.endsWith('/set-active'));
    expect(r?.path).toBe('/harness/:slug/working-set/:featureId/set-active');
  });

  it('POST clear-active', () => {
    const r = routes.find((x) => x.method === 'POST' && x.path.endsWith('/clear-active'));
    expect(r?.path).toBe('/harness/:slug/working-set/:featureId/clear-active');
  });
});

describe('parseWriteBody', () => {
  it('rejects null / non-object', () => {
    expect(parseWriteBody(null).ok).toBe(false);
    expect(parseWriteBody('x').ok).toBe(false);
  });
  it('rejects missing / non-positive / float user id', () => {
    expect(parseWriteBody({}).ok).toBe(false);
    expect(parseWriteBody({ github_user_id: 0 }).ok).toBe(false);
    expect(parseWriteBody({ github_user_id: -2 }).ok).toBe(false);
    expect(parseWriteBody({ github_user_id: 1.5 }).ok).toBe(false);
  });
  it('accepts positive int + coerces string', () => {
    const a = parseWriteBody({ github_user_id: 42 });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.userId).toBe(42);
    const b = parseWriteBody({ github_user_id: '99' });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.userId).toBe(99);
  });
  it('rejects non-numeric string', () => {
    expect(parseWriteBody({ github_user_id: 'bob' }).ok).toBe(false);
  });
});
