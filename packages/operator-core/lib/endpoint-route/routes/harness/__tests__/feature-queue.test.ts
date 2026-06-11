import { describe, expect, it } from 'vitest';
import routes, { parseWriteBody } from '../feature-queue';

describe('feature-queue routes — shape', () => {
  it('exports 3 routes', () => {
    expect(routes).toHaveLength(3);
  });

  it('GET /harness/:slug/feature-queue-membership', () => {
    const r = routes.find((x) => x.method === 'GET');
    expect(r?.path).toBe('/harness/:slug/feature-queue-membership');
    // Read — stays public (W2: the loopback bind is the perimeter for reads).
    expect(r?.auth).toBe('public');
  });

  it('POST /harness/:slug/feature-queue/:featureId/enqueue', () => {
    const r = routes.find(
      (x) => x.method === 'POST' && x.path.endsWith('/enqueue'),
    );
    expect(r?.path).toBe('/harness/:slug/feature-queue/:featureId/enqueue');
    expect(r?.auth).toBe('loopback');
  });

  it('POST /harness/:slug/feature-queue/:featureId/dequeue', () => {
    const r = routes.find(
      (x) => x.method === 'POST' && x.path.endsWith('/dequeue'),
    );
    expect(r?.path).toBe('/harness/:slug/feature-queue/:featureId/dequeue');
    expect(r?.auth).toBe('loopback');
  });
});

describe('parseWriteBody', () => {
  it('rejects null', () => {
    const r = parseWriteBody(null);
    expect(r.ok).toBe(false);
  });

  it('rejects non-object body', () => {
    expect(parseWriteBody('foo').ok).toBe(false);
    expect(parseWriteBody(42).ok).toBe(false);
  });

  it('rejects missing github_user_id', () => {
    expect(parseWriteBody({}).ok).toBe(false);
  });

  it('rejects 0 / negative / float user id', () => {
    expect(parseWriteBody({ github_user_id: 0 }).ok).toBe(false);
    expect(parseWriteBody({ github_user_id: -3 }).ok).toBe(false);
    expect(parseWriteBody({ github_user_id: 1.5 }).ok).toBe(false);
  });

  it('accepts positive integer', () => {
    const r = parseWriteBody({ github_user_id: 42 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.userId).toBe(42);
  });

  it('coerces stringified positive integer (form-encoded clients)', () => {
    const r = parseWriteBody({ github_user_id: '12345' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.userId).toBe(12345);
  });

  it('rejects non-numeric string', () => {
    expect(parseWriteBody({ github_user_id: 'alice' }).ok).toBe(false);
  });
});
