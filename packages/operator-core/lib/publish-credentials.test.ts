import { describe, it, expect } from 'vitest';
import {
  maskPublishCredentials,
  PUBLISH_CREDENTIALS_PATH,
  type PublishCredentials,
} from './publish-credentials';

const TABLE = 'harness_shared.operator_publish_credentials';

describe('PUBLISH_CREDENTIALS_PATH', () => {
  it('returns the PG table identifier (no longer a file path)', () => {
    expect(PUBLISH_CREDENTIALS_PATH()).toBe(TABLE);
  });
});

describe('maskPublishCredentials', () => {
  it('returns an all-null masked shape when there are no credentials', () => {
    expect(maskPublishCredentials(null)).toEqual({
      tenantId: null,
      tenantSecretMasked: null,
      registeredAt: null,
      publishHost: null,
      path: TABLE,
    });
  });

  it('masks a long secret as first6 + ... + last4', () => {
    const c: PublishCredentials = {
      tenantId: 'tenant-1',
      tenantSecret: 'abcdef1234567890wxyz', // 20 chars
      registeredAt: 0,
      publishHost: 'https://publish.example',
    };
    const m = maskPublishCredentials(c);
    expect(m.tenantId).toBe('tenant-1');
    expect(m.tenantSecretMasked).toBe('abcdef...wxyz');
    expect(m.publishHost).toBe('https://publish.example');
    expect(m.path).toBe(TABLE);
  });

  it('never reveals the middle of the secret', () => {
    const secret = 'abcdef1234567890wxyz';
    const m = maskPublishCredentials({
      tenantId: 't', tenantSecret: secret, registeredAt: 0, publishHost: 'h',
    });
    expect(m.tenantSecretMasked).not.toContain('123456'); // the hidden middle
    expect(m.tenantSecretMasked).toContain('...');
  });

  it('fully redacts a short secret (< 12 chars) to ***', () => {
    const m = maskPublishCredentials({
      tenantId: 't', tenantSecret: 'short', registeredAt: 0, publishHost: 'h',
    });
    expect(m.tenantSecretMasked).toBe('***');
  });

  it('renders registeredAt as an ISO string', () => {
    const ts = Date.UTC(2026, 0, 2, 3, 4, 5);
    const m = maskPublishCredentials({
      tenantId: 't', tenantSecret: 'short', registeredAt: ts, publishHost: 'h',
    });
    expect(m.registeredAt).toBe(new Date(ts).toISOString());
  });
});
