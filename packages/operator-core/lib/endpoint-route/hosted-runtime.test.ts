import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
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

function serviceRunner(currentUser = 'hosted_service', bootOrder?: string[]): HostedServiceContextRunner {
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join(' ');
    if (!query.includes('current_user')) throw new Error(`unexpected hosted service query: ${query}`);
    return [{ current_user: currentUser }];
  }) as unknown as Sql;
  return async <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => {
    bootOrder?.push('service-role');
    return fn(sql);
  };
}

describe('hosted runtime composition', () => {
  it('probes the service role before resolving only the hosted cookie secret and pins the mounted surface', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bootOrder: string[] = [];
    const resolveSecret = vi.fn(async (reference: string) => {
      bootOrder.push(`secret:${reference}`);
      if (reference === configuration.hostedSessionCookieSecretRef) {
        return 'hosted-runtime-cookie-secret-that-is-more-than-32-bytes';
      }
      if (reference === configuration.workosWebhookSecretRef) return 'whsec_runtime_test';
      throw new Error(`unexpected eager secret read: ${reference}`);
    });
    const plane = await createHostedRuntime(configuration, {
      resolveSecret,
      runService: serviceRunner('hosted_service', bootOrder),
    });

    expect(plane.mounted.map((route) => `${route.method} ${route.path}`)).toEqual(HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS);
    expect(plane.components.providerDelegationManager).toBeTypeOf('function');
    expect(bootOrder.slice(0, 2)).toEqual(['service-role', `secret:${configuration.hostedSessionCookieSecretRef}`]);
    expect(resolveSecret).toHaveBeenCalledTimes(1);
    expect(resolveSecret).toHaveBeenCalledWith(configuration.hostedSessionCookieSecretRef);

    expect((await plane.app.request('/api/health')).status).toBe(200);
    expect((await plane.app.request('/api/auth/login', { method: 'POST' })).status).toBe(404);
    expect((await plane.app.request(
      '/api/hosted/workspaces/customer-1/provider-delegations/onboard',
      { method: 'POST' },
    )).status).toBe(401);

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

  it('refuses boot before resolving secrets when the service runner does not enter hosted_service', async () => {
    const resolveSecret = vi.fn(async () => 'must-not-resolve');

    await expect(
      createHostedRuntime(configuration, {
        resolveSecret,
        runService: serviceRunner('harness_app'),
      }),
    ).rejects.toThrow('hosted_runtime_service_role_mismatch:harness_app');
    expect(resolveSecret).not.toHaveBeenCalled();
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
