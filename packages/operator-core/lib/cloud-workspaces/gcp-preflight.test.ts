import { describe, expect, it, vi } from 'vitest';
import {
  GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS,
  inspectGcpLocalCredentialOnboarding,
  runGcpWorkspaceHostPreflight,
  type GcpPreflightDeps,
} from './gcp-preflight';

const SECRET = 'ya29.this-access-token-must-never-escape';
const PROJECT = 'active-alcove-504205-q3';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function successFetch(overrides: Record<string, Response | (() => Response)> = {}): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    for (const [needle, response] of Object.entries(overrides)) {
      if (url.includes(needle)) return typeof response === 'function' ? response() : response.clone();
    }
    if (url.includes('cloudresourcemanager.googleapis.com/v3/projects/')) return json({ state: 'ACTIVE' });
    if (url.includes('cloudbilling.googleapis.com')) return json({ billingEnabled: true });
    if (url.includes('serviceusage.googleapis.com')) return json({ state: 'ENABLED' });
    if (url.includes(':testIamPermissions')) {
      const requested = JSON.parse(String(init?.body ?? '{}')) as { permissions?: string[] };
      return json({ permissions: requested.permissions ?? [] });
    }
    if (url.includes('?fields=quotas')) return json({ quotas: [{ metric: 'CPUS_ALL_REGIONS', limit: 24, usage: 2 }] });
    if (url.includes('/regions?')) return json({ items: [{ name: 'us-central1', status: 'UP' }] });
    if (url.includes('/aggregated/machineTypes')) {
      return json({ items: { 'zones/us-central1-a': { machineTypes: [{ name: 'e2-standard-4' }] } } });
    }
    if (url.includes('/global/images/family/')) return json({ name: 'ubuntu-2404-noble-amd64-v20260801' });
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;
}

function deps(overrides: Partial<GcpPreflightDeps> = {}): GcpPreflightDeps {
  return {
    exec: vi.fn(async (file, args) => {
      if (file === 'gcloud' && args[0] === 'version') return { stdout: '{"Google Cloud SDK":"999.0.0"}' };
      if (file === 'gcloud' && args[0] === 'config') return { stdout: `${PROJECT}\n` };
      throw new Error(`unexpected exec ${file} ${args.join(' ')}`);
    }),
    readFile: vi.fn(async () => JSON.stringify({ type: 'authorized_user', refresh_token: 'must-not-escape' })),
    acquireAuth: vi.fn(async () => ({ accessToken: SECRET, projectId: PROJECT, identity: 'developer@example.com' })),
    fetch: successFetch(),
    env: {},
    homedir: () => '/home/tester',
    now: () => '2026-08-22T06:00:00.000Z',
    ...overrides,
  };
}

describe('GCP local credential onboarding', () => {
  it('returns the official authorized-user command when gcloud and ADC are absent', async () => {
    const report = await inspectGcpLocalCredentialOnboarding(
      {},
      deps({
        exec: vi.fn(async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }),
        readFile: vi.fn(async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }),
      }),
    );

    expect(report).toMatchObject({ gcloudInstalled: false, adcPresent: false, credentialType: 'missing' });
    expect(report.commands[0]?.argv).toEqual(['gcloud', 'auth', 'application-default', 'login']);
    expect(JSON.stringify(report)).not.toMatch(/keys create|private_key|refresh_token/);
  });

  it('renders an argv-safe impersonation flow and never suggests a downloaded key', async () => {
    const report = await inspectGcpLocalCredentialOnboarding(
      { impersonateServiceAccount: 'workspace-provisioner@example-project.iam.gserviceaccount.com' },
      deps({
        readFile: vi.fn(async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }),
      }),
    );

    expect(report.commands[0]?.argv).toEqual([
      'gcloud',
      'auth',
      'application-default',
      'login',
      '--impersonate-service-account=workspace-provisioner@example-project.iam.gserviceaccount.com',
    ]);
    expect(JSON.stringify(report)).not.toContain('service-accounts keys create');
  });
});

describe('GCP workspace-host preflight', () => {
  it('verifies project, billing, APIs, IAM, quota, catalogs, and image access without leaking credentials', async () => {
    const fetchImpl = successFetch();
    const report = await runGcpWorkspaceHostPreflight({}, deps({ fetch: fetchImpl }));

    expect(report.ok).toBe(true);
    expect(report.projectId).toBe(PROJECT);
    expect(report.credential.credentialRef).toEqual({ kind: 'cloud', ref: 'adc://authorized_user' });
    expect(report.checks.map((check) => check.id)).toEqual([
      'credential',
      'project',
      'billing',
      'services',
      'iam.project',
      'quotas',
      'regions',
      'machineTypes',
      'image',
    ]);
    expect(report.enabledServices).toEqual(['compute.googleapis.com', 'iap.googleapis.com', 'oslogin.googleapis.com']);
    expect(report.regions).toEqual(['us-central1']);
    expect(report.machineTypeCount).toBe(1);
    expect(report.selectedImage?.name).toBe('ubuntu-2404-noble-amd64-v20260801');
    expect(JSON.stringify(report)).not.toMatch(/ya29\.|refresh_token|private_key|client_secret/);

    const iamCall = vi.mocked(fetchImpl).mock.calls.find(([url]) => String(url).includes(':testIamPermissions'));
    expect(JSON.parse(String(iamCall?.[1]?.body))).toEqual({
      permissions: [...GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS],
    });
  });

  it('fails closed on a service-account key before acquiring a token or calling Google APIs', async () => {
    const acquireAuth = vi.fn();
    const fetchImpl = vi.fn();
    const report = await runGcpWorkspaceHostPreflight(
      {},
      deps({
        env: { GOOGLE_APPLICATION_CREDENTIALS: '/secrets/service-account.json' },
        readFile: vi.fn(async () => JSON.stringify({ type: 'service_account', private_key: 'must-not-escape' })),
        acquireAuth,
        fetch: fetchImpl as typeof fetch,
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ id: 'credential', status: 'fail' });
    expect(report.checks[0]?.remediation?.code).toBe('remove-service-account-key');
    expect(acquireAuth).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('must-not-escape');
  });

  it('returns exact least-privilege remediation for disabled services, missing IAM, and exhausted quota', async () => {
    const fetchImpl = successFetch({
      'services/iap.googleapis.com': json({ state: 'DISABLED' }),
      ':testIamPermissions': () => json({ permissions: ['resourcemanager.projects.get'] }),
      '?fields=quotas': json({ quotas: [{ metric: 'CPUS_ALL_REGIONS', limit: 8, usage: 8 }] }),
    });
    const report = await runGcpWorkspaceHostPreflight({}, deps({ fetch: fetchImpl }));

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'services')?.remediation).toMatchObject({
      code: 'enable-services',
      commands: [['gcloud', 'services', 'enable', 'iap.googleapis.com', `--project=${PROJECT}`]],
    });
    const iam = report.checks.find((check) => check.id === 'iam.project');
    expect(iam?.remediation?.code).toBe('grant-project-permissions');
    expect(iam?.remediation?.missingPermissions).toContain('iap.tunnelInstances.accessViaIAP');
    expect(iam?.remediation?.suggestedRoles).toContain('roles/iap.tunnelResourceAccessor');
    expect(report.checks.find((check) => check.id === 'quotas')?.remediation?.code).toBe('increase-quota');
  });

  it('checks iam.serviceAccounts.actAs on the selected runtime identity only', async () => {
    const fetchImpl = successFetch({
      'iam.googleapis.com': () => json({ permissions: [] }),
    });
    const report = await runGcpWorkspaceHostPreflight(
      { runtimeServiceAccount: 'workspace-runtime@example-project.iam.gserviceaccount.com' },
      deps({ fetch: fetchImpl }),
    );

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'iam.serviceAccount')?.remediation).toMatchObject({
      code: 'grant-service-account-user',
      suggestedRoles: ['roles/iam.serviceAccountUser'],
      missingPermissions: ['iam.serviceAccounts.actAs'],
    });
    expect(
      vi.mocked(fetchImpl).mock.calls.some(([url]) => String(url).includes('workspace-runtime%40example-project')),
    ).toBe(true);
  });
});
