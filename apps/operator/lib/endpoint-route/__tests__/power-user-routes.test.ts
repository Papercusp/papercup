/**
 * Integration tests for the three ported power-user routes:
 *
 *   POST /api/agent-tokens/power-user           — issue access+refresh
 *   POST /api/agent-tokens/power-user/refresh   — exchange refresh→access
 *   GET  /api/agent-bundle                       — fetch persona+tools.md+...
 *
 * These ports were done by the R5 endpoint-route migration (320220c1 +
 * 58de9cb0). The tests drive the actual `defineTool` handlers through
 * a Hono app — same code path as the production catch-all. PG and FS
 * are mocked; HMAC token logic runs for real.
 *
 * If R5 broke a behavior on the way through, the asserts here catch it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

/* ─── PG mocks — token signing key + sessions table ──────────────────── */

const FIXED_KEY_B64 = randomBytes(32).toString('base64');
const FIXED_ROTATED_AT = new Date('2026-05-20T00:00:00.000Z');

vi.mock('@/lib/ensure-schema', () => ({
  ensureOperatorSecretsTable: vi.fn(async () => {}),
  ensurePowerUserSessionsTable: vi.fn(async () => {}),
}));

const SESSIONS = new Map<string, { workspaceId: string; userId: string }>();

vi.mock('@/lib/power-user-sessions', () => ({
  createPowerUserSession: vi.fn(async (opts: { workspaceId: string; userId: string }) => {
    const id = `pus-${randomBytes(8).toString('hex')}`;
    SESSIONS.set(id, { workspaceId: opts.workspaceId, userId: opts.userId });
    return { authSessionId: id, workspaceId: opts.workspaceId, userId: opts.userId };
  }),
  getActivePowerUserSession: vi.fn(async (id: string) => {
    const row = SESSIONS.get(id);
    if (!row) return null;
    return { authSessionId: id, workspaceId: row.workspaceId, userId: row.userId };
  }),
  revokePowerUserSession: vi.fn(async (id: string) => {
    SESSIONS.delete(id);
  }),
}));

vi.mock(import('@restart/db-org'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getOrgPg: () =>
      ({
        db: {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [{ valueB64: FIXED_KEY_B64, rotatedAt: FIXED_ROTATED_AT }],
              }),
            }),
          }),
          insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
        },
        sql: ((..._args: unknown[]) => Promise.resolve([])) as unknown as {
          <T>(strings: TemplateStringsArray, ...vals: unknown[]): Promise<T>;
        },
      }) as never,
  };
});

/* ─── Auth + workspace mocks ─────────────────────────────────────────── */

vi.mock(import('@/lib/auth'), async (importOriginal) => {
  const actual = await importOriginal();
  const stubUser = {
    id: 'user-test',
    username: 'tester',
    display_name: 'Tester',
    has_password: true,
  };
  return {
    ...actual,
    getSessionUserOrDefault: vi.fn(async () => stubUser),
    getSessionUser: vi.fn(async () => stubUser),
  };
});

vi.mock('@/lib/workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'workspace-active'),
  workspaceById: vi.fn((id: string) =>
    id === 'workspace-active' || id === 'workspace-alt'
      ? { id, name: `Workspace ${id}` }
      : undefined,
  ),
  DEFAULT_WORKSPACE_ID: 'workspace-active',
}));

/* ─── FS mocks for /agent-bundle ──────────────────────────────────────── */

vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: ((p: string) => {
      if (typeof p !== 'string') return actual.existsSync(p);
      if (p.endsWith('.persona.md') || p.endsWith('.tools.md')) return true;
      if (p.endsWith('/prompts') || p.endsWith('/scripts')) return true;
      return actual.existsSync(p);
    }) as never,
    readFileSync: ((p: string, ...rest: unknown[]) => {
      if (typeof p === 'string') {
        if (p.endsWith('papercusp-su.tools.md')) return '# papercusp-su tools.md FIXTURE\n';
        if (p.endsWith('papercusp-su.persona.md')) return '# persona FIXTURE\n';
        if (p.endsWith('.persona.md')) return '# role persona stub\n';
        if (p.endsWith('.tools.md')) return '# role tools stub\n';
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never,
  };
});

/* ─── Telemetry mock ─────────────────────────────────────────────────── */

vi.mock('@/lib/endpoint-route/telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));

/* ─── Now bring the app online ───────────────────────────────────────── */

import { Hono } from 'hono';
import { registerAllRoutes } from '../register';
import {
  mintAccessToken,
  mintRefreshToken,
  verifyAccessToken,
  _resetPowerUserTokenKeyCache,
} from '@/lib/power-user-token';

let app: Hono;

beforeEach(() => {
  SESSIONS.clear();
  _resetPowerUserTokenKeyCache();
  app = new Hono().basePath('/api');
  registerAllRoutes(app);
});
afterEach(() => {
  vi.clearAllMocks();
});

/* ─── Helpers ────────────────────────────────────────────────────────── */

function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/* ─── 1. POST /api/agent-tokens/power-user ───────────────────────────── */

describe('POST /api/agent-tokens/power-user (issue)', () => {
  it('returns access + refresh + workspace + user + auth_session_id', async () => {
    const res = await postJson('/api/agent-tokens/power-user', {});
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(typeof j.access_token).toBe('string');
    expect(typeof j.refresh_token).toBe('string');
    expect(j.workspace_id).toBe('workspace-active');
    expect(j.user_id).toBe('user-test');
    expect(j.auth_session_id).toMatch(/^pus-/);
    expect(Date.parse(j.access_expires_at as string)).toBeGreaterThan(Date.now());
    expect(Date.parse(j.refresh_expires_at as string)).toBeGreaterThan(
      Date.parse(j.access_expires_at as string),
    );
  });

  it('honors body.workspace when present', async () => {
    const res = await postJson('/api/agent-tokens/power-user', { workspace: 'workspace-alt' });
    const j = (await res.json()) as { workspace_id: string };
    expect(j.workspace_id).toBe('workspace-alt');
  });

  it('falls back to activeWorkspaceId when body.workspace is missing/blank', async () => {
    const res = await postJson('/api/agent-tokens/power-user', { workspace: '   ' });
    const j = (await res.json()) as { workspace_id: string };
    expect(j.workspace_id).toBe('workspace-active');
  });

  it('issued access token has the right shape and claims', async () => {
    const r = await postJson('/api/agent-tokens/power-user', {});
    const { access_token, auth_session_id, workspace_id, user_id } = (await r.json()) as {
      access_token: string;
      auth_session_id: string;
      workspace_id: string;
      user_id: string;
    };
    const claims = await verifyAccessToken(access_token);
    expect(claims).not.toBeNull();
    expect(claims!.workspaceId).toBe(workspace_id);
    expect(claims!.userId).toBe(user_id);
    expect(claims!.authSessionId).toBe(auth_session_id);
  });
});

/* ─── 2. POST /api/agent-tokens/power-user/refresh ───────────────────── */

describe('POST /api/agent-tokens/power-user/refresh', () => {
  it('exchanges a valid refresh token for a fresh access token', async () => {
    const issue = (await (await postJson('/api/agent-tokens/power-user', {})).json()) as {
      refresh_token: string;
      workspace_id: string;
      user_id: string;
      auth_session_id: string;
    };
    const res = await postJson('/api/agent-tokens/power-user/refresh', {}, bearer(issue.refresh_token));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { access_token: string; access_expires_at: string };
    const claims = await verifyAccessToken(j.access_token);
    expect(claims).not.toBeNull();
    expect(claims!.authSessionId).toBe(issue.auth_session_id);
    expect(claims!.workspaceId).toBe(issue.workspace_id);
    expect(claims!.userId).toBe(issue.user_id);
  });

  it('401 when no Authorization header', async () => {
    const res = await postJson('/api/agent-tokens/power-user/refresh', {});
    expect(res.status).toBe(401);
  });

  it('401 when Authorization is garbage', async () => {
    const res = await postJson(
      '/api/agent-tokens/power-user/refresh',
      {},
      bearer('a.bogus.token'),
    );
    expect(res.status).toBe(401);
  });

  it('401 on type confusion — access token presented as refresh', async () => {
    const { token } = await mintAccessToken({
      workspaceId: 'workspace-active',
      userId: 'user-test',
      authSessionId: 'pus-typetest',
    });
    SESSIONS.set('pus-typetest', { workspaceId: 'workspace-active', userId: 'user-test' });
    const res = await postJson('/api/agent-tokens/power-user/refresh', {}, bearer(token));
    expect(res.status).toBe(401);
  });

  it('401 when the session has been revoked', async () => {
    const issue = (await (await postJson('/api/agent-tokens/power-user', {})).json()) as {
      refresh_token: string;
      auth_session_id: string;
    };
    SESSIONS.delete(issue.auth_session_id);
    const res = await postJson(
      '/api/agent-tokens/power-user/refresh',
      {},
      bearer(issue.refresh_token),
    );
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/revoked|unknown/i);
  });

  it('401 on an expired refresh token', async () => {
    SESSIONS.set('pus-expiretest', { workspaceId: 'workspace-active', userId: 'user-test' });
    const { token } = await mintRefreshToken({ authSessionId: 'pus-expiretest', ttlSec: -10 });
    const res = await postJson('/api/agent-tokens/power-user/refresh', {}, bearer(token));
    expect(res.status).toBe(401);
  });
});

/* ─── 3. GET /api/agent-bundle ────────────────────────────────────────── */

describe('GET /api/agent-bundle', () => {
  async function freshAccessToken(workspaceId = 'workspace-active'): Promise<string> {
    const res = await postJson('/api/agent-tokens/power-user', { workspace: workspaceId });
    const j = (await res.json()) as { access_token: string };
    return j.access_token;
  }

  it('returns the bundle with persona, toolsmd, mcp_url, workspace, user', async () => {
    const tok = await freshAccessToken();
    const res = await app.request('/api/agent-bundle', {
      method: 'GET',
      headers: { ...bearer(tok), host: 'localhost:3070' },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      persona: string;
      toolsmd: string;
      skills: Array<{ name: string; source: string }>;
      hooks: Array<{ name: string; source: string }>;
      mcp_url: string;
      workspace: { id: string; name: string };
      user: { id: string };
      expires_at: string;
    };
    expect(j.toolsmd).toContain('FIXTURE');
    expect(j.persona).toContain('FIXTURE');
    expect(j.workspace.id).toBe('workspace-active');
    expect(j.user.id).toBe('user-test');
    expect(Array.isArray(j.skills)).toBe(true);
    expect(Array.isArray(j.hooks)).toBe(true);
    expect(j.mcp_url).toMatch(/\/api\/mcp\?power_user=1$/);
    expect(Date.parse(j.expires_at)).toBeGreaterThan(Date.now());
  });

  it('mcp_url is derived from the request origin, never hardcoded', async () => {
    const tok = await freshAccessToken();
    const res = await app.request('http://operator.local:9999/api/agent-bundle', {
      method: 'GET',
      headers: { ...bearer(tok) },
    });
    const j = (await res.json()) as { mcp_url: string };
    expect(j.mcp_url).toBe('http://operator.local:9999/api/mcp?power_user=1');
  });

  it('401 with no Authorization header', async () => {
    const res = await app.request('/api/agent-bundle', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('401 with a refresh token instead of an access token (type confusion)', async () => {
    const issue = (await (await postJson('/api/agent-tokens/power-user', {})).json()) as {
      refresh_token: string;
    };
    const res = await app.request('/api/agent-bundle', {
      method: 'GET',
      headers: { ...bearer(issue.refresh_token) },
    });
    expect(res.status).toBe(401);
  });

  it('401 with a token whose session has been revoked', async () => {
    const issue = (await (await postJson('/api/agent-tokens/power-user', {})).json()) as {
      access_token: string;
      auth_session_id: string;
    };
    SESSIONS.delete(issue.auth_session_id);
    const res = await app.request('/api/agent-bundle', {
      method: 'GET',
      headers: { ...bearer(issue.access_token) },
    });
    expect(res.status).toBe(401);
  });

  it('401 with an expired access token', async () => {
    SESSIONS.set('pus-exp', { workspaceId: 'workspace-active', userId: 'user-test' });
    const { token } = await mintAccessToken({
      workspaceId: 'workspace-active',
      userId: 'user-test',
      authSessionId: 'pus-exp',
      ttlSec: -10,
    });
    const res = await app.request('/api/agent-bundle', {
      method: 'GET',
      headers: { ...bearer(token) },
    });
    expect(res.status).toBe(401);
  });
});
