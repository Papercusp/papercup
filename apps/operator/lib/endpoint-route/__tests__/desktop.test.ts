/**
 * Verification for the ported `desktop` family. Covers the pure
 * spawn-spec builders (absorbed from the old setup-pty-commands
 * route.test.ts) and the route ports mounted on a throwaway Hono app.
 *
 * `requirePrincipal` is mocked to resolve a loopback principal so the
 * `auth: {}` routes pass the route-stack gate deterministically — this
 * is the first family test where the gate actually runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('@/lib/auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => ({
    kind: 'loopback', slug: 'loopback', workspaceId: 'ws',
    authMethod: 'loopback', trust: 'unverified-loopback',
    capabilities: new Set(['*']), label: 'loopback',
  })),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    constructor(public status: number, public reason: string) { super(reason); }
  },
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('@/lib/agent-auth-detect', () => ({
  claudeSignedIn: vi.fn(() => true),
  ompSignedIn: vi.fn(() => false),
  githubSignedIn: vi.fn(() => false),
  anyAgentSignedIn: vi.fn(() => true),
}));
vi.mock('@/lib/telemetry-flush', () => ({ flushTelemetry: vi.fn(async () => ({ flushed: 3 })) }));
vi.mock('@/lib/operator-state-pg', () => ({
  readOperatorState: vi.fn(async () => null),
  writeOperatorState: vi.fn(async () => {}),
}));
vi.mock('@/lib/voice-credentials', () => ({ readElevenLabsKey: vi.fn(async () => null) }));
vi.mock('@/lib/setup-wizard-install-id', () => ({ ensureInstallId: vi.fn(async () => 'install-1') }));

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import desktopAgentAuthStatus from '../routes/desktop/agent-auth-status';
import desktopAgentLoginEnvelope from '../routes/desktop/agent-login-envelope';
import desktopGitIdentity from '../routes/desktop/git-identity';
import desktopPreflight from '../routes/desktop/preflight';
import desktopSetupPtyCommands, {
  buildInstallSpec,
  buildLoginSpec,
  buildGithubLoginSpec,
} from '../routes/desktop/setup-pty-commands';
import desktopSetupWizardState from '../routes/desktop/setup-wizard-state';
import desktopTelemetryFlush from '../routes/desktop/telemetry-flush';
import desktopTelemetryReport from '../routes/desktop/telemetry-report';
import desktopWorkspaceValidate from '../routes/desktop/workspace-validate';
import { writeOperatorState, readOperatorState } from '@/lib/operator-state-pg';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function appWith(entry: AnyRoute | AnyRoute[]): Hono {
  const app = new Hono();
  for (const def of Array.isArray(entry) ? entry : [entry]) registerRoute(app, def);
  return app;
}
const json = (b: unknown) => ({
  method: 'POST',
  body: JSON.stringify(b),
  headers: { 'content-type': 'application/json' },
});

afterEach(() => vi.clearAllMocks());

describe('buildInstallSpec', () => {
  it('unix: spawns bash -c with a single script arg', () => {
    const spec = buildInstallSpec('linux', '/home/u');
    expect(spec.command).toBe('bash');
    expect(spec.args[0]).toBe('-c');
    expect(spec.args).toHaveLength(2);
    expect(spec.cwd).toBe('/home/u');
  });

  it('macOS uses the same bash path as linux', () => {
    expect(buildInstallSpec('darwin', '/Users/u').command).toBe('bash');
  });

  it('windows: spawns powershell.exe with -Command', () => {
    const spec = buildInstallSpec('win32', 'C:\\Users\\u');
    expect(spec.command).toBe('powershell.exe');
    expect(spec.args).toContain('-Command');
    expect(spec.args).toContain('-NoProfile');
  });

  it('install script installs all three components', () => {
    const unix = buildInstallSpec('linux', '/home/u').args[1];
    expect(unix).toContain('claude.ai/install.sh');
    expect(unix).toContain('@rynfar/meridian');
    expect(unix).toContain('@oh-my-pi/cli');
  });

  it('env is empty (inherits the parent process env)', () => {
    expect(buildInstallSpec('linux', '/home/u').env).toEqual({});
  });
});

describe('buildLoginSpec', () => {
  it('claude: spawns `claude /login`', () => {
    const spec = buildLoginSpec('claude', '/home/u');
    expect(spec.command).toBe('claude');
    expect(spec.args).toEqual(['/login']);
    expect(spec.cwd).toBe('/home/u');
  });

  it('omp: spawns `omp /login`', () => {
    expect(buildLoginSpec('omp', '/home/u').command).toBe('omp');
  });
});

describe('buildGithubLoginSpec', () => {
  it('spawns `gh auth login` (not /login like claude/omp)', () => {
    const spec = buildGithubLoginSpec('/home/u');
    expect(spec.command).toBe('gh');
    expect(spec.args).toEqual(['auth', 'login']);
    expect(spec.cwd).toBe('/home/u');
    expect(spec.env).toEqual({});
  });
});

describe('desktop route ports', () => {
  it('GET /desktop/agent-auth-status returns per-provider status', async () => {
    const res = await appWith(desktopAgentAuthStatus as AnyRoute).request('/desktop/agent-auth-status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claude: true, omp: false, github: false });
  });

  it('POST /desktop/agent-login-envelope rejects an unknown provider', async () => {
    const res = await appWith(desktopAgentLoginEnvelope as AnyRoute)
      .request('/desktop/agent-login-envelope', json({ provider: 'bogus' }));
    expect(res.status).toBe(400);
  });

  it('POST /desktop/agent-login-envelope builds an envelope for a known provider', async () => {
    const res = await appWith(desktopAgentLoginEnvelope as AnyRoute)
      .request('/desktop/agent-login-envelope', json({ provider: 'claude' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ greetingCmd: 'claude /login' });
  });

  it('GET /desktop/git-identity returns a source field', async () => {
    const res = await appWith(desktopGitIdentity as AnyRoute[]).request('/desktop/git-identity');
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).source).toBe('string');
  });

  it('POST /desktop/git-identity rejects a missing name (400)', async () => {
    const res = await appWith(desktopGitIdentity as AnyRoute[])
      .request('/desktop/git-identity', json({ email: 'a@b.com' }));
    expect(res.status).toBe(400);
  });

  it('POST /desktop/git-identity rejects a malformed email (400)', async () => {
    const res = await appWith(desktopGitIdentity as AnyRoute[])
      .request('/desktop/git-identity', json({ name: 'Ada', email: 'not-an-email' }));
    expect(res.status).toBe(400);
  });

  it('GET /desktop/setup-pty-commands returns the four specs', async () => {
    const res = await appWith(desktopSetupPtyCommands as AnyRoute).request('/desktop/setup-pty-commands');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installRuntime.command).toBeTruthy();
    expect(body.loginClaude.command).toBe('claude');
    expect(body.loginOmp.command).toBe('omp');
    expect(body.loginGithub.command).toBe('gh');
    expect(body.loginGithub.args).toEqual(['auth', 'login']);
  });

  it('OPTIONS /desktop/preflight answers the CORS preflight with 204', async () => {
    const res = await appWith(desktopPreflight as AnyRoute[]).request('/desktop/preflight', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('POST /desktop/telemetry-flush returns the flush result', async () => {
    const res = await appWith(desktopTelemetryFlush as AnyRoute).request('/desktop/telemetry-flush', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ flushed: 3 });
  });

  it('POST /desktop/telemetry-report rejects when telemetry is disabled (403)', async () => {
    vi.mocked(readOperatorState).mockResolvedValue(null);
    const res = await appWith(desktopTelemetryReport as AnyRoute[])
      .request('/desktop/telemetry-report', json({ kind: 'crash' }));
    expect(res.status).toBe(403);
  });

  it('POST /desktop/workspace-validate rejects an invalid body with 400', async () => {
    const res = await appWith(desktopWorkspaceValidate as AnyRoute)
      .request('/desktop/workspace-validate', json({ notpath: 1 }));
    expect(res.status).toBe(400);
  });

  it('POST /desktop/workspace-validate accepts an empty path', async () => {
    const res = await appWith(desktopWorkspaceValidate as AnyRoute)
      .request('/desktop/workspace-validate', json({ path: '' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, normalized: '' });
  });

  it('GET /desktop/setup-wizard-state returns the persisted state', async () => {
    const res = await appWith(desktopSetupWizardState as AnyRoute[]).request('/desktop/setup-wizard-state');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ step_status: {} });
  });

  it('PATCH /desktop/setup-wizard-state merge-writes', async () => {
    const res = await appWith(desktopSetupWizardState as AnyRoute[])
      .request('/desktop/setup-wizard-state', { ...json({ last_visited_step: 'keys' }), method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(writeOperatorState).toHaveBeenCalledOnce();
  });
});
