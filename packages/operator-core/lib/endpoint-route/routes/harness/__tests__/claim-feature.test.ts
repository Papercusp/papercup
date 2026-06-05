import { describe, expect, it } from 'vitest';
import routes, { parseClaimBody } from '../claim-feature';

describe('claim-feature route — shape', () => {
  it('exports a single POST route', () => {
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe('POST');
    expect(routes[0].path).toBe('/harness/:slug/claim-feature');
    expect(routes[0].auth).toBe('public');
  });
});

describe('parseClaimBody', () => {
  it('rejects null/non-object body', () => {
    expect(parseClaimBody(null).ok).toBe(false);
    expect(parseClaimBody('foo').ok).toBe(false);
    expect(parseClaimBody(42).ok).toBe(false);
  });

  it('rejects missing feature_id', () => {
    expect(parseClaimBody({ github_user_id: 1 }).ok).toBe(false);
  });

  it('rejects empty feature_id', () => {
    expect(parseClaimBody({ feature_id: '', github_user_id: 1 }).ok).toBe(false);
  });

  it('rejects non-string feature_id', () => {
    expect(parseClaimBody({ feature_id: 42, github_user_id: 1 }).ok).toBe(false);
  });

  it('rejects missing github_user_id', () => {
    expect(parseClaimBody({ feature_id: 'F-1' }).ok).toBe(false);
  });

  it('rejects non-positive github_user_id', () => {
    expect(parseClaimBody({ feature_id: 'F-1', github_user_id: 0 }).ok).toBe(false);
    expect(parseClaimBody({ feature_id: 'F-1', github_user_id: -3 }).ok).toBe(false);
    expect(parseClaimBody({ feature_id: 'F-1', github_user_id: 1.5 }).ok).toBe(false);
  });

  it('accepts well-formed body', () => {
    const r = parseClaimBody({ feature_id: 'F-1', github_user_id: 42 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.featureId).toBe('F-1');
      expect(r.userId).toBe(42);
    }
  });

  it('coerces stringified user id', () => {
    const r = parseClaimBody({ feature_id: 'F-1', github_user_id: '99' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.userId).toBe(99);
  });

  it('rejects non-numeric user-id string', () => {
    expect(parseClaimBody({ feature_id: 'F-1', github_user_id: 'alice' }).ok).toBe(false);
  });
});
