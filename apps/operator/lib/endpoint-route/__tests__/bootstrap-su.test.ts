/**
 * Unit tests for POST /api/agent-mcp/console/bootstrap-su.
 *
 * Drives the route handler directly with a hand-built RouteContext and
 * mocks the heavy deps (auth, envelope, session writer). su-agents is
 * NOT mocked — wrapperBin assertions exercise the real mapping.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

// Redirect the launch-context file writes to a throwaway temp dir so the
// route's best-effort persistence doesn't touch the real ~/.papercusp.
const LC_DIR = mkdtempSync(join(tmpdir(), 'bootstrap-su-lc-'));
process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = LC_DIR;

const recordAdvSessionMock = vi.fn(async (_opts: unknown) => 42 as number | null);

vi.mock('@/lib/auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => {}),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    status = 401;
    reason = 'denied';
  },
}));
vi.mock('@/lib/workspace-registry', () => ({
  activeWorkspaceId: () => 'default',
  readRegistry: () => ({
    current: 'default',
    workspaces: [{ id: 'default', name: 'Default' }, { id: 'ws2', name: 'Second' }],
  }),
  workspaceById: (id: string) => (['default', 'ws2'].includes(id) ? { id, name: id } : undefined),
}));
vi.mock('@/lib/console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async (o: { slug: string | null }) => ({
    cwd: o.slug ? `/proj/${o.slug}` : '/workspace',
    env: { PAPERCUSP_OPERATOR_URL: 'http://localhost:3070', ...(o.slug ? { PAPERCUSP_HARNESS_SLUG: o.slug } : {}) },
    mcpJsonContents: '',
    greetingCmd: '',
    needsSuperuserBootstrap: false,
    mode: 'shell',
  })),
}));
vi.mock('@/lib/adv-sessions', () => ({ recordAdvSession: recordAdvSessionMock }));
vi.mock('@/lib/device-harnesses', () => ({
  listHarnessesFor: vi.fn(async () => [
    { slug: 'papercup', path: '/repo', harness_kind: null, has_state: true, status: 'active', iteration: 1, last_active_ts: null },
  ]),
}));
vi.mock('@/lib/agent-tools/plans/source', () => ({
  resolveHarnessPlansDir: vi.fn(async () => ({ harnessSlug: 'papercup', plans: '/repo/plans', archive: '/repo/plans/archive' })),
  listPlanFiles: vi.fn(async () => [
    { slug: 'plan-a', filePath: '/repo/plans/plan-a.md', archived: false },
    { slug: 'plan-archived', filePath: '/repo/plans/archive/plan-archived.md', archived: true },
  ]),
  readPlanBySlug: vi.fn(async () => ({
    parsed: { now: { state: 'do X', next: 'then Y' }, frontmatter: { title: 'My Plan' } },
    archived: false,
  })),
}));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

type Route = { method: string; handler: (req: Request, ctx: RouteContext) => Promise<Response> };

async function routesOf(): Promise<Route[]> {
  const mod = await import('../routes/agent-mcp/bootstrap-su');
  return mod.default as Route[];
}

async function callPost(body: unknown): Promise<Response> {
  const post = (await routesOf()).find((r) => r.method === 'POST')!;
  const req = new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-su', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return post.handler(req, CTX);
}

async function callGet(query = ''): Promise<Response> {
  const get = (await routesOf()).find((r) => r.method === 'GET')!;
  const req = new Request(`http://localhost:3070/api/agent-mcp/console/bootstrap-su/options${query}`, {
    method: 'GET',
  });
  return get.handler(req, CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  recordAdvSessionMock.mockResolvedValue(42);
});

describe('bootstrap-su', () => {
  it('plan_slug set → adv_sessions row carries the plan; claude-su wrapper + tracking env', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.sessionId).toBe(42);
    expect(json.cwd).toBe('/proj/papercup');
    expect(json.wrapperBin).toBe('claude-su');
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: 'my-plan', agent: 'claude', mode: 'console' }),
    );
    expect(json.envelopeEnv.PAPERCUSP_AGENT).toBe('claude');
    expect(json.envelopeEnv.PAPERCUSP_ADV_SESSION_ID).toBe('42');
    // Launch-context file is composed + persisted; env points the wrapper at it.
    expect(json.envelopeEnv.PAPERCUSP_LAUNCH_CONTEXT_FILE).toMatch(/session-42\.md$/);
    const ctx = readFileSync(json.envelopeEnv.PAPERCUSP_LAUNCH_CONTEXT_FILE, 'utf8');
    expect(ctx).toContain('scoped to harness `papercup`');
    expect(ctx).toContain('bound to plan `my-plan`');
    expect(ctx).toContain('— My Plan');
    expect(ctx).toContain('> **Now:** do X');
  });

  it('no harness + no plan → no launch-context file (playbook covers it)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: null, plan_slug: null, cwd: '/home/me' });
    const json = await res.json();
    expect(json.envelopeEnv.PAPERCUSP_LAUNCH_CONTEXT_FILE).toBeUndefined();
  });

  it('harness, no plan → launch-context with the scope block but no plan block', async () => {
    const res = await callPost({ agent: 'omp', harness_slug: 'papercup', plan_slug: null });
    const json = await res.json();
    expect(json.envelopeEnv.PAPERCUSP_LAUNCH_CONTEXT_FILE).toMatch(/session-42\.md$/);
    const ctx = readFileSync(json.envelopeEnv.PAPERCUSP_LAUNCH_CONTEXT_FILE, 'utf8');
    expect(ctx).toContain('scoped to harness `papercup`');
    expect(ctx).not.toContain('bound to plan');
  });

  it('plan_slug null → No-plan row; omp-su wrapper + mode omp', async () => {
    const res = await callPost({ agent: 'omp', harness_slug: 'papercup', plan_slug: null });
    const json = await res.json();
    expect(json.planSlug).toBeNull();
    expect(json.wrapperBin).toBe('omp-su');
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: null, agent: 'omp', mode: 'omp' }),
    );
  });

  it('codex → codex-su wrapper; workspace cwd when no harness', async () => {
    const res = await callPost({ agent: 'codex', harness_slug: null, plan_slug: null });
    const json = await res.json();
    expect(json.wrapperBin).toBe('codex-su');
    expect(json.cwd).toBe('/workspace');
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', mode: 'console' }),
    );
  });

  it('rejects an unknown agent kind', async () => {
    const res = await callPost({ agent: 'gemini', harness_slug: 'papercup' });
    expect(res.status).toBe(400);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('options (no harness) lists the active-workspace harnesses', async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.workspace).toBe('default');
    expect(json.harnesses).toEqual([{ slug: 'papercup', path: '/repo', status: 'active' }]);
  });

  it('options?harness lists non-archived plan slugs', async () => {
    const res = await callGet('?harness=papercup');
    const json = await res.json();
    expect(json.harness).toBe('papercup');
    expect(json.plans).toEqual([{ slug: 'plan-a' }]);
  });

  it('options lists workspaces + the active one', async () => {
    const json = await (await callGet()).json();
    expect(json.activeWorkspace).toBe('default');
    expect(json.workspaces).toEqual([{ id: 'default', name: 'Default' }, { id: 'ws2', name: 'Second' }]);
  });

  it('threads an explicit workspace to the session + result', async () => {
    const res = await callPost({ agent: 'claude', workspace: 'ws2', harness_slug: 'papercup' });
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.workspaceId).toBe('ws2');
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws2' }));
  });

  it('rejects an unknown workspace (no session)', async () => {
    const res = await callPost({ agent: 'claude', workspace: 'nope', harness_slug: 'papercup' });
    expect(res.status).toBe(400);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('no-harness launch uses the caller cwd (resume-friendly), not the internal dir', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: null, cwd: '/home/me/work' });
    const json = await res.json();
    expect(json.cwd).toBe('/home/me/work');
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/home/me/work' }));
  });

  it('harness launch ignores the caller cwd (uses the harness repo)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', cwd: '/home/me/work' });
    const json = await res.json();
    expect(json.cwd).toBe('/proj/papercup');
  });
});
