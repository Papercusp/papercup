import { describe, expect, it, vi } from 'vitest';
import {
  HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS,
  createHostedRuntime,
  isHostedControlPlaneDistributionProfile,
  readHostedRuntimeConfiguration,
  type HostedRuntimeConfiguration,
} from './hosted-runtime';

const configuration: HostedRuntimeConfiguration = {
  publicOrigin: 'https://app.papercusp.com',
  controlPlaneWorkspaceId: 'hosted-control-plane',
  hostedSessionCookieSecretRef: 'env:PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET',
  workosClientId: 'client_workos_test',
  workosApiKeyRef: 'env:WORKOS_API_KEY',
  workosCookiePasswordRef: 'env:WORKOS_COOKIE_PASSWORD',
  workosWebhookSecretRef: 'env:WORKOS_WEBHOOK_SECRET',
  workosWebhookSignatureKeyRef: 'workos-webhook-key-2026-08',
};

describe('hosted runtime composition', () => {
  it('resolves only the hosted cookie secret at boot and pins the exact mounted surface', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resolveSecret = vi.fn(async (reference: string) => {
      if (reference === configuration.hostedSessionCookieSecretRef) {
        return 'hosted-runtime-cookie-secret-that-is-more-than-32-bytes';
      }
      if (reference === configuration.workosWebhookSecretRef) return 'whsec_runtime_test';
      throw new Error(`unexpected eager secret read: ${reference}`);
    });
    const plane = await createHostedRuntime(configuration, { resolveSecret });

    expect(plane.mounted.map((route) => `${route.method} ${route.path}`)).toEqual(HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS);
    expect(resolveSecret).toHaveBeenCalledTimes(1);
    expect(resolveSecret).toHaveBeenCalledWith(configuration.hostedSessionCookieSecretRef);

    expect((await plane.app.request('/api/health')).status).toBe(200);
    expect((await plane.app.request('/api/auth/login', { method: 'POST' })).status).toBe(404);

    const webhook = await plane.app.request('/api/auth/workos/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(webhook.status).toBe(401);
    expect(resolveSecret).toHaveBeenLastCalledWith(configuration.workosWebhookSecretRef);
    expect(warning).toHaveBeenCalledWith('[auth/workos-webhook] rejected', {
      code: 'missing_signature',
      retryable: false,
    });
    warning.mockRestore();
  });

  it('reads only ref-bearing production configuration and refuses an incomplete profile', () => {
    const env = {
      PAPERCUSP_HOSTED_PUBLIC_ORIGIN: configuration.publicOrigin,
      PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID: configuration.controlPlaneWorkspaceId,
      PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF: configuration.hostedSessionCookieSecretRef,
      WORKOS_CLIENT_ID: configuration.workosClientId,
      WORKOS_API_KEY_REF: configuration.workosApiKeyRef,
      WORKOS_COOKIE_PASSWORD_REF: configuration.workosCookiePasswordRef,
      WORKOS_WEBHOOK_SECRET_REF: configuration.workosWebhookSecretRef,
      WORKOS_WEBHOOK_SECRET_KEY_REF: configuration.workosWebhookSignatureKeyRef,
    };
    expect(readHostedRuntimeConfiguration(env)).toEqual(configuration);
    expect(() => readHostedRuntimeConfiguration({ ...env, WORKOS_API_KEY_REF: '' })).toThrow(
      'hosted_runtime_configuration_missing:WORKOS_API_KEY_REF',
    );
  });

  it('selects the hosted branch only through the explicit distribution profile', () => {
    expect(isHostedControlPlaneDistributionProfile({ PAPERCUSP_DISTRIBUTION_PROFILE: 'hosted-control-plane' })).toBe(
      true,
    );
    expect(isHostedControlPlaneDistributionProfile({ PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release' })).toBe(false);
    expect(isHostedControlPlaneDistributionProfile({})).toBe(false);
  });
});
