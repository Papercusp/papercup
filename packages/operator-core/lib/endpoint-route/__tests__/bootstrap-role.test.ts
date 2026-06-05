/**
 * Unit tests for POST /api/agent-mcp/console/bootstrap-role (P-021).
 * Mocks the heavy deps; asserts feature-gating, the role-scoped spec
 * composition, and the recorded session shape. Filesystem writes go to a
 * throwaway launch-context dir.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const LC_DIR = mkdtempSync(join(tmpdir(), 'bootstrap-role-lc-'));
process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = LC_DIR;

const recordAdvSessionMock = vi.fn(async (_o: unknown) => 7 as number | null);
const buildRoleLaunchSpecMock = vi.fn();
const roleConsumesMock = vi.fn();
const writeRoleCodexHomeMock = vi.fn();

vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => {}),
  PrincipalCheckError: class extends Error { status = 401; reason = 'denied'; },
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'default',
  workspaceById: (id: string) => (id === 'default' ? { id, name: 'Default' } : undefined),
}));
vi.mock('../../adv-sessions', () => ({ recordAdvSession: recordAdvSessionMock }));
vi.mock('../../role-registry', () => ({ roleConsumes: (...a: unknown[]) => roleConsumesMock(...a) }));
vi.mock('../../role-launch-spec', () => ({ buildRoleLaunchSpec: (...a: unknown[]) => buildRoleLaunchSpecMock(...a) }));
vi.mock('../../role-codex-home', () => ({ writeRoleCodexHome: (...a: unknown[]) => writeRoleCodexHomeMock(...a) }));
// No-op the best-effort saved-prompts materialize side effect — this unit test
// isn't exercising it (the materialize integration test is), and running it for
// real would query the DB + write/prune the dev box's ~/.claude/commands.
vi.mock('../../saved-prompts-materialize', () => ({
  materializeWorkspacePrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeHarnessPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeCodexPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
}));
const getPlanContextBySlugMock = vi.fn(async () => '## Source Plan Context\n\n**Plan:** `p1`');
vi.mock('../../plan-context-for-feature', () => ({ getPlanContextBySlug: (...a: unknown[]) => getPlanContextBySlugMock(...a) }));

const CTX: RouteContext = { principal: null, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal };

async function callPost(body: unknown): Promise<Response> {
  const mod = await import('../routes/agent-mcp/bootstrap-role');
  const post = (mod.default as Array<{ method: string; handler: (r: Request, c: RouteContext) => Promise<Response> }>)
    .find((r) => r.method === 'POST')!;
  const req = new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-role', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return post.handler(req, CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  recordAdvSessionMock.mockResolvedValue(7);
  roleConsumesMock.mockReturnValue({ feature: 'required', plan: 'none' });
  getPlanContextBySlugMock.mockResolvedValue('## Source Plan Context\n\n**Plan:** `p1`');
  writeRoleCodexHomeMock.mockReturnValue({
    codexHome: '/tmp/role-codex-homes/session-7',
    agentsPath: '/tmp/role-codex-homes/session-7/AGENTS.md',
    configPath: '/tmp/role-codex-homes/session-7/config.toml',
  });
  buildRoleLaunchSpecMock.mockResolvedValue({
    role: 'worker', runId: 'worker-F-001-1', spawnId: 'sp-1', harnessSlug: 'papercup', featureId: 'F-001',
    cwd: LC_DIR, promptText: 'WORKER PROMPT', promptFile: '/h/prompts/worker.md',
    mcpUrl: 'http://localhost:3070/api/mcp?role=worker&sig=x',
    mcpJsonContents: JSON.stringify({ mcpServers: { papercusp: { type: 'http', url: 'http://localhost:3070/api/mcp?role=worker&sig=x' } } }),
  });
});

describe('bootstrap-role', () => {
  it('worker + feature → role-scoped session recorded with role+feature+agent', async () => {
    const res = await callPost({ role: 'worker', agent: 'claude', harness_slug: 'papercup', feature: 'F-001' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.role).toBe('worker');
    expect(json.feature).toBe('F-001');
    expect(json.agent).toBe('claude');
    expect(json.cwd).toBe(LC_DIR);
    expect(json.envelopeEnv.PAPERCUSP_ROLE).toBe('worker');
    expect(json.envelopeEnv.PAPERCUSP_FEATURE_ID).toBe('F-001');
    expect(buildRoleLaunchSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'worker', harnessSlug: 'papercup', featureId: 'F-001' }),
    );
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'worker', feature: 'F-001', agent: 'claude' }),
    );
  });

  it('rejects a feature-required role with no feature', async () => {
    const res = await callPost({ role: 'worker', agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('feature_required');
    expect(buildRoleLaunchSpecMock).not.toHaveBeenCalled();
  });

  it('allows a no-feature role (scoper) when consumes.feature=none', async () => {
    roleConsumesMock.mockReturnValue({ feature: 'none', plan: 'optional' });
    buildRoleLaunchSpecMock.mockResolvedValue({
      role: 'scoper', runId: 'scoper-1', spawnId: 'sp-2', harnessSlug: 'papercup', featureId: null,
      cwd: LC_DIR, promptText: 'SCOPER PROMPT', promptFile: '/h/prompts/scoper.md',
      mcpUrl: 'http://localhost:3070/api/mcp?role=scoper&sig=y',
      mcpJsonContents: '{}',
    });
    const res = await callPost({ role: 'scoper', agent: 'omp', harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.role).toBe('scoper');
    expect(json.feature).toBeNull();
  });

  it('plan-consuming role (scoper, consumes.plan=optional) → fetches + injects plan context', async () => {
    roleConsumesMock.mockReturnValue({ feature: 'none', plan: 'optional' });
    buildRoleLaunchSpecMock.mockResolvedValue({
      role: 'scoper', runId: 'scoper-1', spawnId: 'sp-3', harnessSlug: 'papercup', featureId: null,
      cwd: LC_DIR, promptText: 'SCOPER PROMPT', promptFile: '/h/prompts/scoper.md',
      mcpUrl: 'http://localhost:3070/api/mcp?role=scoper&sig=z', mcpJsonContents: '{}',
    });
    const res = await callPost({ role: 'scoper', agent: 'omp', harness_slug: 'papercup', plan: 'my-plan' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.planSlug).toBe('my-plan');
    expect(getPlanContextBySlugMock).toHaveBeenCalledWith('my-plan');
    // planContext is forwarded to the spec builder...
    expect(buildRoleLaunchSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'scoper', planContext: expect.stringContaining('Source Plan Context') }),
    );
    // ...and recorded on the session.
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'scoper', planSlug: 'my-plan' }),
    );
  });

  it('ignores a plan for a non-plan-consuming role (consumes.plan=none)', async () => {
    roleConsumesMock.mockReturnValue({ feature: 'required', plan: 'none' });
    const res = await callPost({ role: 'worker', agent: 'claude', harness_slug: 'papercup', feature: 'F-001', plan: 'my-plan' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.planSlug).toBeNull();
    expect(getPlanContextBySlugMock).not.toHaveBeenCalled();
    expect(buildRoleLaunchSpecMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ planContext: expect.anything() }),
    );
  });

  it('codex → per-session CODEX_HOME, exported via envelopeEnv.CODEX_HOME', async () => {
    const res = await callPost({ role: 'worker', agent: 'codex', harness_slug: 'papercup', feature: 'F-001' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.agent).toBe('codex');
    expect(json.codexHome).toBe('/tmp/role-codex-homes/session-7');
    // codex's prompt + MCP live INSIDE the CODEX_HOME (AGENTS.md + config.toml).
    expect(json.promptFile).toBe('/tmp/role-codex-homes/session-7/AGENTS.md');
    expect(json.mcpJsonPath).toBe('/tmp/role-codex-homes/session-7/config.toml');
    expect(json.envelopeEnv.CODEX_HOME).toBe('/tmp/role-codex-homes/session-7');
    // The CODEX_HOME is built from the SAME signed role-scoped url as claude/omp.
    expect(writeRoleCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ mcpUrl: 'http://localhost:3070/api/mcp?role=worker&sig=x', promptText: 'WORKER PROMPT' }),
    );
    // No .mcp.json written into the harness cwd for codex.
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'worker', feature: 'F-001', agent: 'codex' }),
    );
  });

  it('requires a harness slug', async () => {
    const res = await callPost({ role: 'worker', agent: 'claude', feature: 'F-001' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid role id', async () => {
    const res = await callPost({ role: 'Bad Role!', agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(400);
  });
});
