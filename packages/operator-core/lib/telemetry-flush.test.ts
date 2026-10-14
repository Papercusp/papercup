import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostedPrincipal } from './auth/hosted-principal';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT } from './telemetry-kinds';
vi.mock('./posthog-config', () => ({ getPosthogConfigWithSource: () => ({ config: { host: 'https://sink.invalid', projectKey: 'capture-test-key' } }) }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));
vi.mock('./operator-state-pg', () => ({ readOperatorState: vi.fn(), writeOperatorState: vi.fn() }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: vi.fn() }));
vi.mock('./setup-wizard-install-id', () => ({ ensureInstallId: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
import { deliverCloudPosthog, readCloudCaptureHealth } from './telemetry-flush';
afterEach(() => vi.unstubAllGlobals());

describe('strict cloud PostHog transport', () => {
  const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: 'tenant-a', userId: 'user-a',
    sessionId: 'session-a', sessionVersion: 1, permissions: [] });
  const context = { principal, environment: 'staging' as const, release: 'abcdef1234567', origin: 'portal' as const, hostingMode: 'byoc' as const };
  const event = { event: 'cloud_portal_session', operation_id: '00000000-0000-4000-8000-000000000001', properties: { action: 'returned' } };
  const consent = { ...DEFAULT_CLOUD_TELEMETRY_CONSENT, analytics: { enabled: true, since: '2000-01-01T00:00:00Z' } };
  it('distinguishes capture health from a responsive admin API and handles outages', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response('missing data', { status: 400 })).mockRejectedValueOnce(new Error('unreachable'));
    vi.stubGlobal('fetch', fetcher);
    expect(await readCloudCaptureHealth()).toEqual({ healthy: false, status: 502 });
    expect(await readCloudCaptureHealth()).toEqual({ healthy: true, status: 400 });
    expect(await readCloudCaptureHealth()).toEqual({ healthy: false, status: null });
  });
  it('sends strict opaque metadata with a stable vendor dedup identity and drops default/revoked input', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })); vi.stubGlobal('fetch', fetcher);
    const readConsent = vi.fn(async () => consent);
    expect(await deliverCloudPosthog(event, context, readConsent)).toEqual({ delivered: true });
    expect(await deliverCloudPosthog(event, context, readConsent)).toEqual({ delivered: true });
    const bodies = fetcher.mock.calls.map(call => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)));
    expect(bodies[0].batch[0].properties.$insert_id).toBe(bodies[1].batch[0].properties.$insert_id);
    expect(bodies[0].batch[0].properties.$insert_id).toBe(bodies[0].batch[0].properties.operation_id);
    expect(JSON.stringify(bodies)).not.toMatch(/tenant-a|user-a|session-a/);
    expect(await deliverCloudPosthog(event, context, async () => DEFAULT_CLOUD_TELEMETRY_CONSENT)).toMatchObject({ delivered: false });
    expect(await deliverCloudPosthog({ ...event, properties: { ...event.properties, prompt: 'private' } }, context, readConsent)).toMatchObject({ delivered: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('returns a dropped-event receipt for capture rejection without rejecting product work', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
    expect(await deliverCloudPosthog(event, context, async () => consent)).toEqual({ delivered: false, code: 'delivery_unavailable' });
  });
});
