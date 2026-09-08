/**
 * Unit tests for POST /api/agent-mcp/console/bootstrap-role (P-021).
 * Mocks the heavy deps; asserts feature-gating, the role-scoped spec
 * composition, and the recorded session shape. Filesystem writes go to a
 * throwaway launch-context dir.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const LC_DIR = mkdtempSync(join(tmpdir(), 'bootstrap-role-lc-'));
process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = LC_DIR;

// WI-6154: this mkdtemp dir was never cleaned up, so every run of this suite
// (local or CI, on this shared box) left a `bootstrap-role-lc-*` directory
// behind forever — 1600+ accumulated in /tmp over ~6 days. Worse than the disk
// leak: those leftover `.mcp.json` fixtures (written with this file's mocked
// `sig=x` placeholder, never a real HMAC signature) were mistaken for evidence
// of a LIVE gym-worker misconfiguration in WI-6154's original report. Clean up
// so the artifacts stop accumulating and stop looking like production data.
afterAll(() => {
  rmSync(LC_DIR, { recursive: true, force: true });
});

const recordAdvSessionMock = vi.fn(async (_o: unknown) => 7 as number | null);
const buildRoleLaunchSpecMock = vi.fn();
const roleConsumesMock = vi.fn();
const writeRoleCodexHomeMock = vi.fn();
const resolveAccountPinMock = vi.fn();
// WI-1408 (fleet-join-startup-assertion): a spy (not a fixed stub) so per-test cases
// can override the resolution outcome — the no-fleet default mirrors the prior fixed
// stub so every PRE-EXISTING test (none of which pass `fleet`/`fleet_name`) is unaffected.
const resolveFleetMock = vi.fn(
  async (
    ..._a: unknown[]
  ): Promise<{
    env: Record<string, string>;
    notice: string | null;
    fleetSlug: string | null;
    fleetRole: string | null;
  }> => ({ env: {}, notice: null, fleetSlug: null, fleetRole: null }),
);
// WI-1893 (cluster-safe fleet stamp): bootstrap-role appends the DURABLE membership
// fact via stampFleetMembershipAtBoot (exported by bootstrap-su) — null = success,
// a string = the loud-409 failure message.
const stampFleetMembershipMock = vi.fn(async (_opts: unknown) => null as string | null);
// EI-155: mock the interactive-claude config-dir materializer so this unit test
// never symlinks the dev box's real ~/.claude into a session dir.
const writeInteractiveClaudeConfigMock = vi.fn((opts: { sid: string }) => ({
  configDir: `/tmp/session-claude/${opts.sid}`,
}));

vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => {}),
  PrincipalCheckError: class extends Error { status = 401; reason = 'denied'; },
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'default',
  workspaceById: (id: string) => (id === 'default' ? { id, name: 'Default' } : undefined),
  // The SPAWN_HANDOFF_HYDRATION checkpoint source (getWorkItemCheckpoint) resolves its
  // concrete workspace via resolveConcreteWorkspaceId; a faithful stub (first non-'*',
  // non-empty candidate, else the active workspace) keeps this fully-mocked module
  // complete so the fail-soft hydration doesn't degrade on a missing export.
  resolveConcreteWorkspaceId: (...candidates: Array<string | null | undefined>) => {
    for (const c of candidates) {
      if (typeof c === 'string') {
        const t = c.trim();
        if (t && t !== '*') return t;
      }
    }
    return 'default';
  },
}));
// This route imports only recordAdvSession. Spawn hydration is mocked below, so
// importing and spreading the complete production adv-sessions module here
// needlessly pulls its database/liveness graph into the beforeAll transform.
vi.mock('../../adv-sessions', async (orig) => ({
  ...(await orig<typeof import('../../adv-sessions')>()),
  recordAdvSession: recordAdvSessionMock,
}));
vi.mock('../../role-registry', () => ({ roleConsumes: (...a: unknown[]) => roleConsumesMock(...a) }));
vi.mock('../../role-launch-spec', () => ({ buildRoleLaunchSpec: (...a: unknown[]) => buildRoleLaunchSpecMock(...a) }));
vi.mock('../../role-codex-home', () => ({ writeRoleCodexHome: (...a: unknown[]) => writeRoleCodexHomeMock(...a) }));
// Keep this unit suite off the live flag store. Without this mock the first
// request waits on getFlag's production datastore timeout (~7s), exceeding
// Vitest's 5s test budget before any route assertion can run.
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));
// bootstrap-role also resolves named-fleet env from bootstrap-su (P-005); these
// CODEX_HOME unit cases pass no fleet, so stub the no-fleet default (empty env).
vi.mock('../routes/agent-mcp/bootstrap-su', () => ({
  resolveAccountPin: (...a: unknown[]) => resolveAccountPinMock(...a),
  resolveFleet: (...a: unknown[]) => resolveFleetMock(...a),
  // WI-1347 added reconstructPsuLaunchArgv (a PURE argv builder) + a call site in
  // bootstrap-role; this fully-mocked module must export it or the handler throws
  // at the call. The tests don't assert argv content (it flows downstream), so a
  // faithful minimal stub suffices.
  reconstructPsuLaunchArgv: (o: { agent?: string; role?: string | null; stack?: string[] | null }) =>
    [
      'psu',
      '--no-picker',
      `--agent=${o?.agent ?? ''}`,
      ...(o?.role ? [`--role=${o.role}`] : []),
      ...(o?.stack ?? []).map((ref) => `--stack=${ref}`),
    ],
  // WI-1893: the durable membership stamp replaced the in-memory setPendingFleet
  // placement (which lived in ONE cluster worker and was lost cross-worker).
  stampFleetMembershipAtBoot: (opts: unknown) => stampFleetMembershipMock(opts),
}));
vi.mock('../../interactive-claude-config', () => ({ writeInteractiveClaudeConfig: (opts: { sid: string }) => writeInteractiveClaudeConfigMock(opts) }));
// No-op the best-effort saved-prompts materialize side effect — this unit test
// isn't exercising it (the materialize integration test is), and running it for
// real would query the DB + write/prune the dev box's ~/.claude/commands.
vi.mock('../../saved-prompts-materialize', () => ({
  materializeWorkspacePrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeHarnessPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeCodexPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
}));
// SPAWN_HANDOFF_HYDRATION is disabled by the flag mock above and has its own
// focused coverage. Loading its production dependency graph here made this
// otherwise-hermetic unit suite spend >10s in beforeAll module import and time
// out before any assertion ran. Stub both seams so this file tests bootstrap-role
// rather than the unrelated roster/checkpoint/loop graph behind hydration.
vi.mock('../../fleet/spawn-hydration', () => ({
  assembleSpawnHydration: vi.fn(async () => ({ text: '', sources: [] })),
}));
vi.mock('../../fleet/spawn-hydration-deps', () => ({
  productionSpawnHydrationDeps: vi.fn(() => ({})),
}));
const getPlanContextBySlugMock = vi.fn(async (_slug?: string) => '## Source Plan Context\n\n**Plan:** `p1`');
vi.mock('../../plan-context-for-feature', () => ({ getPlanContextBySlug: (slug: string) => getPlanContextBySlugMock(slug) }));

// P-013 / D-022 — the retirement gate on THIS (third) spawn door.
//
// ⚠ `importOriginal`-SPREAD, NOT a bare factory. `pot/started` exports far more
// than this flag, and a minimal factory would strand every other export the
// module graph might reach — the exact stranding EI-20017608270017874 measured
// when `mugKettleSystemEnabled` was added to this module (once loudly, once
// SILENTLY). Spreading keeps every real export and overrides ONE.
//
// ⚠ The override is KEY-AWARE by construction: it replaces a NAMED function, so
// it cannot answer for some other flag. The key-BLIND shape this plan was bitten
// by twice (`useFlag: () => mock()`) answers every flag alike, which silently
// turns an unrelated suite into an assertion about the retirement notice.
const mugKettleEnabledMock = vi.fn(async () => false);
vi.mock('../../pot/started', async (orig) => ({
  ...(await orig<typeof import('../../pot/started')>()),
  mugKettleSystemEnabled: () => mugKettleEnabledMock(),
}));

const CTX: RouteContext = { principal: null, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal };

let post: (r: Request, c: RouteContext) => Promise<Response>;
beforeAll(async () => {
  const mod = await import('../routes/agent-mcp/bootstrap-role');
  post = (mod.default as Array<{ method: string; handler: typeof post }>)
    .find((r) => r.method === 'POST')!.handler;
// The dynamic import must run after Vitest installs the mocks above. Its Vite
// transform is therefore charged to this hook (rather than file collection)
// and the route's legitimate module graph can exceed Vitest's 10s default on
// the shared runner. Give that one-time transform a bounded budget; individual
// request tests retain their ordinary timeout.
}, 30_000);

async function callPost(body: unknown): Promise<Response> {
  const req = new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-role', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return post(req, CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  recordAdvSessionMock.mockResolvedValue(7);
  roleConsumesMock.mockReturnValue({ feature: 'required', plan: 'none' });
  resolveAccountPinMock.mockResolvedValue({ env: {}, notice: null, accountId: null, provider: null });
  resolveFleetMock.mockResolvedValue({ env: {}, notice: null, fleetSlug: null, fleetRole: null });
  stampFleetMembershipMock.mockResolvedValue(null);
  getPlanContextBySlugMock.mockResolvedValue('## Source Plan Context\n\n**Plan:** `p1`');
  writeRoleCodexHomeMock.mockReturnValue({
    codexHome: '/tmp/role-codex-homes/session-7',
    agentsPath: '/tmp/role-codex-homes/session-7/AGENTS.md',
    configPath: '/tmp/role-codex-homes/session-7/config.toml',
  });
  buildRoleLaunchSpecMock.mockImplementation(async (input: { stack?: string[] | null }) => ({
    role: 'worker', runId: 'worker-F-001-1', spawnId: 'sp-1', harnessSlug: 'papercup', featureId: 'F-001',
    cwd: LC_DIR, promptText: 'WORKER PROMPT', promptFile: '/h/prompts/worker.md',
    mcpUrl: 'http://localhost:3070/api/mcp?role=worker&sig=x',
    mcpJsonContents: JSON.stringify({ mcpServers: { papercusp: { type: 'http', url: 'http://localhost:3070/api/mcp?role=worker&sig=x' } } }),
    // Launch invariants the primitive now produces (unify-launch-mechanics P-002).
    sid: 'role-abc', nativeSessionId: 'nsid-abc',
    claudeConfigDir: join(LC_DIR, 'session-claude', 'role-abc'),
    sessionMcpDir: join(LC_DIR, 'session-mcp', 'role-abc'),
    contextSize: 'trimmed',
    stack: input.stack ?? [],
    specificationArtifact: {},
    specificationRevision: 'a'.repeat(64),
    stateRevision: 'b'.repeat(64),
    compositionSource: 'compatibility',
  }));
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
    // Identity comes from the spec primitive now (P-002): PAPERCUSP_SID === spec.sid.
    expect(json.envelopeEnv.PAPERCUSP_SID).toBe('role-abc');
    // claude exact-resume (P-003 inv d): the forced native session id is exported
    // (the launcher turns it into `--session-id`) AND recorded on the adv row.
    expect(json.envelopeEnv.PAPERCUSP_NATIVE_SESSION_ID).toBe('nsid-abc');
    expect(json.specificationRevision).toBe('a'.repeat(64));
    expect(json.stateRevision).toBe('b'.repeat(64));
    expect(json.envelopeEnv.PAPERCUSP_SPECIFICATION_REVISION).toBe(json.specificationRevision);
    expect(json.envelopeEnv.PAPERCUSP_STATE_REVISION).toBe(json.stateRevision);
    expect(buildRoleLaunchSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'worker', harnessSlug: 'papercup', featureId: 'F-001' }),
    );
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'worker', feature: 'F-001', agent: 'claude', coordOwnerId: 'role-abc', sessionId: 'nsid-abc' }),
    );
  });

  it('threads explicit stack bindings through role compilation and launch argv', async () => {
    await callPost({
      role: 'worker',
      agent: 'claude',
      harness_slug: 'papercup',
      feature: 'F-001',
      stack: ['domain:papercusp-engineer', 'practice:careful-review'],
    });
    expect(buildRoleLaunchSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({ stack: ['domain:papercusp-engineer', 'practice:careful-review'] }),
    );
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        launchArgv: expect.arrayContaining([
          '--stack=domain:papercusp-engineer',
          '--stack=practice:careful-review',
        ]),
      }),
    );
  });

  it('EI-155: claude role session gets a per-session CLAUDE_CONFIG_DIR keyed by spec.sid', async () => {
    const json = await (await callPost({ role: 'worker', agent: 'claude', harness_slug: 'papercup', feature: 'F-001' })).json();
    // Keyed by spec.sid (=== coord_owner_id), so wake-by-resume resolves the same
    // dir — completing the half-wired spec.claudeConfigDir invariant.
    expect(writeInteractiveClaudeConfigMock).toHaveBeenCalledWith(expect.objectContaining({ sid: 'role-abc' }));
    expect(json.envelopeEnv.CLAUDE_CONFIG_DIR).toBe('/tmp/session-claude/role-abc');
  });

  it('EI-155: omp/codex role sessions get NO CLAUDE_CONFIG_DIR', async () => {
    roleConsumesMock.mockReturnValue({ feature: 'none', plan: 'none' });
    const omp = await (await callPost({ role: 'scoper', agent: 'omp', harness_slug: 'papercup' })).json();
    expect(omp.envelopeEnv.CLAUDE_CONFIG_DIR).toBeUndefined();

    const codex = await (await callPost({ role: 'worker', agent: 'codex', harness_slug: 'papercup', feature: 'F-001' })).json();
    expect(codex.envelopeEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('omp role session: no forced native session id (omp resumes by thread id)', async () => {
    roleConsumesMock.mockReturnValue({ feature: 'none', plan: 'none' });
    const res = await callPost({ role: 'scoper', agent: 'omp', harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    const json = await res.json();
    // sid still bound; but no native session id forced for omp.
    expect(json.envelopeEnv.PAPERCUSP_SID).toBe('role-abc');
    expect(json.envelopeEnv.PAPERCUSP_NATIVE_SESSION_ID).toBeUndefined();
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.anything() }),
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
      sid: 'role-sco', nativeSessionId: 'nsid-sco',
      claudeConfigDir: join(LC_DIR, 'session-claude', 'role-sco'),
      sessionMcpDir: join(LC_DIR, 'session-mcp', 'role-sco'),
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
      sid: 'role-sco2', nativeSessionId: 'nsid-sco2',
      claudeConfigDir: join(LC_DIR, 'session-claude', 'role-sco2'),
      sessionMcpDir: join(LC_DIR, 'session-mcp', 'role-sco2'),
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
    const res = await callPost({
      role: 'worker',
      agent: 'codex',
      model: 'gpt-5.6-sol:high',
      harness_slug: 'papercup',
      feature: 'F-001',
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.agent).toBe('codex');
    expect(json.codexHome).toBe('/tmp/role-codex-homes/session-7');
    // codex's prompt + MCP live INSIDE the CODEX_HOME (AGENTS.md + config.toml).
    expect(json.promptFile).toBe('/tmp/role-codex-homes/session-7/AGENTS.md');
    expect(json.mcpJsonPath).toBe('/tmp/role-codex-homes/session-7/config.toml');
    expect(json.envelopeEnv.CODEX_HOME).toBe('/tmp/role-codex-homes/session-7');
    expect(json.envelopeEnv.PAPERCUSP_NATIVE_SESSION_ID).toBeUndefined();
    // The CODEX_HOME is built from the SAME signed role-scoped url as claude/omp,
    // and bakes the SAME sid the primitive minted (EI-4: url client === PAPERCUSP_SID
    // === codex-home baked client).
    expect(writeRoleCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpUrl: 'http://localhost:3070/api/mcp?role=worker&sig=x',
        promptText: 'WORKER PROMPT',
        sid: 'role-abc',
        model: 'gpt-5.6-sol:high',
      }),
    );
    // No .mcp.json written into the harness cwd for codex.
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'worker', feature: 'F-001', agent: 'codex' }),
    );
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.anything() }),
    );
  });

  it('defaults a visible Codex role deliberately but refuses an unresolved headless role', async () => {
    const visible = await callPost({
      role: 'worker',
      agent: 'codex',
      harness_slug: 'papercup',
      feature: 'F-001',
    });
    expect(visible.status).toBe(200);
    const json = await visible.json();
    expect(json.envelopeEnv.PAPERCUSP_MODEL_SOURCE).toBe('configured-default');
    expect(writeRoleCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.6-sol:xhigh' }),
    );

    vi.clearAllMocks();
    const headless = await callPost({
      role: 'worker',
      agent: 'codex',
      headless: true,
      harness_slug: 'papercup',
      feature: 'F-001',
    });
    expect(headless.status).toBe(400);
    await expect(headless.json()).resolves.toMatchObject({ code: 'missing_model' });
    expect(writeRoleCodexHomeMock).not.toHaveBeenCalled();
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('codex account pin is resolved and baked into the role CODEX_HOME config', async () => {
    resolveAccountPinMock.mockResolvedValue({
      env: { PAPERCUSP_ACCOUNT_ID: 'codex-main' },
      notice: 'pinned to Codex account codex-main (routed through the inference gateway).',
      accountId: 'codex-main',
      provider: 'codex',
    });
    const res = await callPost({ role: 'worker', agent: 'codex', harness_slug: 'papercup', feature: 'F-001', account: 'codex-main' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(resolveAccountPinMock).toHaveBeenCalledWith('default', 'codex-main', 'codex', undefined, false, 'gpt-5.6-sol:xhigh');
    expect(json.accountNotice).toMatch(/pinned to Codex account codex-main/i);
    expect(json.envelopeEnv.PAPERCUSP_ACCOUNT_ID).toBe('codex-main');
    expect(writeRoleCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.6-sol:xhigh', codexGatewayAccountId: 'codex-main', codexGatewayPriority: 'worker' }),
    );
  });

  it('rejects an unavailable explicit account route before recording or building the role launch', async () => {
    resolveAccountPinMock.mockResolvedValue({
      env: {},
      notice: '--account auto could not be honored: the inference gateway is off.',
      error:
        '--account auto could not be honored: the inference gateway is off. Refusing to fall back to the default system login.',
      accountId: null,
      provider: null,
    });
    const res = await callPost({
      role: 'worker',
      agent: 'claude',
      harness_slug: 'papercup',
      feature: 'F-001',
      account: 'auto',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'error', error: expect.stringMatching(/refusing to fall back/i) });
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(buildRoleLaunchSpecMock).not.toHaveBeenCalled();
  });

  it('carries the explicit default-route marker into a Claude role launch envelope', async () => {
    resolveAccountPinMock.mockResolvedValue({
      env: { PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' },
      notice: 'using the default system account (inference gateway skipped).',
      accountId: null,
      provider: null,
    });
    const res = await callPost({
      role: 'worker',
      agent: 'claude',
      harness_slug: 'papercup',
      feature: 'F-001',
      account: 'default',
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.envelopeEnv.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('default');
    expect(json.envelopeEnv.ANTHROPIC_BASE_URL).toBeUndefined();
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

// WI-4608: bootstrap-role threads an explicit `context_size` body field through to
// buildRoleLaunchSpec (mirrors bootstrap-su's context_size) and surfaces the spec's
// RESOLVED contextSize on the response — the wire half of the mug/kettle
// "Prompt is too long" fix (the auto-select default itself lives in
// buildRoleLaunchSpec, covered by role-launch-spec.test.ts).
describe('bootstrap-role — WI-4608 context_size threading', () => {
  it('omitted context_size ⇒ bootstrap normalizes to trimmed before building the role spec', async () => {
    const res = await callPost({ role: 'worker', agent: 'claude', harness_slug: 'papercup', feature: 'F-001' });
    expect(res.status).toBe(200);
    expect(buildRoleLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ contextSize: 'trimmed' }));
    const json = await res.json();
    expect(json.contextSize).toBe('trimmed');
  });

  // P-013/D-022: this case's SUBJECT is context_size threading — the role is
  // incidental fixture. It used to use `mug`, which the retirement gate now
  // refuses (403) with the flag OFF, and the refusal happened BEFORE
  // buildRoleLaunchSpec was called — leaving the `mockResolvedValueOnce` below
  // UNCONSUMED, so it leaked into the next test that called the mock and failed
  // it with a stray `sid: 'role-mug'` (EI-18788176839043286, exactly). Switched
  // to a non-retired role so the case tests its own subject and no longer
  // depends on the retired tier being launchable. Coverage that a mug CAN
  // bootstrap with the flag ON lives in the D-022 SHOW control below.
  it('explicit context_size:"trimmed" is forwarded to buildRoleLaunchSpec and surfaced on the response', async () => {
    buildRoleLaunchSpecMock.mockResolvedValueOnce({
      role: 'scoper', runId: 'scoper-ctx-1', spawnId: 'sp-scoper', harnessSlug: 'papercup', featureId: null,
      cwd: LC_DIR, promptText: 'SCOPER PROMPT', promptFile: '/h/prompts/scoper.md',
      mcpUrl: 'http://localhost:3070/api/mcp?role=scoper&tools=a%2Cb&sig=x', mcpJsonContents: '{}',
      sid: 'role-scoper', nativeSessionId: 'nsid-scoper',
      claudeConfigDir: join(LC_DIR, 'session-claude', 'role-scoper'),
      sessionMcpDir: join(LC_DIR, 'session-mcp', 'role-scoper'),
      contextSize: 'trimmed',
    });
    roleConsumesMock.mockReturnValue({ feature: 'none', plan: 'none' });
    const res = await callPost({ role: 'scoper', agent: 'claude', harness_slug: 'papercup', context_size: 'trimmed' });
    expect(res.status).toBe(200);
    expect(buildRoleLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ contextSize: 'trimmed' }));
    const json = await res.json();
    expect(json.contextSize).toBe('trimmed');
  });

  it('rejects an invalid context_size value before building the role launch spec', async () => {
    const res = await callPost({ role: 'worker', agent: 'claude', harness_slug: 'papercup', feature: 'F-001', context_size: 'huge' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/context size must be 'trimmed'/);
    expect(buildRoleLaunchSpecMock).not.toHaveBeenCalled();
  });
});

// WI-1408 (fleet-join-startup-assertion) + WI-1893 (cluster-safe fleet stamp): a
// role+fleet launch must (a) fail LOUD when the fleet doesn't resolve — never a
// silent unfleeted member — and (b) append the DURABLE membership fact
// (stampFleetMembershipAtBoot → fleet_membership_events) keyed by spec.sid. The old
// in-memory setPendingFleet placement lived in ONE :3070 cluster worker and was lost
// when the member's first presence write landed on another worker (the 2026-07-03
// backlog-clearance batch lost all 10 members this way).
describe('bootstrap-role — fleet join (WI-1408 + WI-1893)', () => {
  it('a successful --fleet join appends the durable membership fact keyed by spec.sid', async () => {
    resolveFleetMock.mockResolvedValue({
      env: { PAPERCUSP_FLEET_SLUG: 'real-fleet', PAPERCUSP_FLEET_ROLE: 'member' },
      notice: 'joined fleet real-fleet as member.',
      fleetSlug: 'real-fleet',
      fleetRole: 'member',
    });
    const res = await callPost({ role: 'worker', agent: 'claude', harness_slug: 'papercup', feature: 'F-001', fleet: 'real-fleet' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.fleetSlug).toBe('real-fleet');
    expect(json.fleetRole).toBe('member');
    // The fact is keyed by spec.sid (== coord_owner_id == PAPERCUSP_SID), the same
    // identity the agent's first presence write looks itself up by (mig-430 triggers
    // cover fact-first AND row-first ordering).
    expect(stampFleetMembershipMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'role-abc', fleetSlug: 'real-fleet', fleetRole: 'member' }),
    );
  });

  it('a --fleet join that fails to resolve is a hard 409 — never a silent unfleeted launch, no membership stamp, no recorded session', async () => {
    resolveFleetMock.mockResolvedValue({
      env: {},
      notice: 'fleet `ghost-fleet` does not exist in this workspace — join skipped (check the slug, or create it first).',
      fleetSlug: null,
      fleetRole: null,
    });
    const res = await callPost({ role: 'worker', agent: 'claude', harness_slug: 'papercup', feature: 'F-001', fleet: 'ghost-fleet' });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.status).toBe('error');
    expect(json.error).toMatch(/fleet join failed/i);
    expect(json.error).toMatch(/ghost-fleet/i);
    expect(stampFleetMembershipMock).not.toHaveBeenCalled();
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('a membership-stamp failure is a hard 409 (WI-1893) — no silent ghost member, no recorded session', async () => {
    resolveFleetMock.mockResolvedValue({
      env: { PAPERCUSP_FLEET_SLUG: 'real-fleet', PAPERCUSP_FLEET_ROLE: 'member' },
      notice: 'joined fleet real-fleet as member.',
      fleetSlug: 'real-fleet',
      fleetRole: 'member',
    });
    stampFleetMembershipMock.mockResolvedValue('pg down');
    const res = await callPost({ role: 'worker', agent: 'claude', harness_slug: 'papercup', feature: 'F-001', fleet: 'real-fleet' });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.status).toBe('error');
    expect(json.error).toMatch(/membership stamp failed/i);
    expect(json.error).toMatch(/WI-1893/);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('no fleet requested ⇒ no assertion fires, no membership stamp, fleetSlug/fleetRole both null', async () => {
    const res = await callPost({ role: 'worker', agent: 'claude', harness_slug: 'papercup', feature: 'F-001' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.fleetSlug).toBeNull();
    expect(json.fleetRole).toBeNull();
    expect(stampFleetMembershipMock).not.toHaveBeenCalled();
  });
});

/**
 * P-013 / D-022 — the THIRD spawn door.
 *
 * D-018 gated the two doors an operator-side launch traverses and its module
 * header asserted the surface had "exactly TWO". It does not: `psu --role <role>`
 * routes every non-su-tier role (SU_TIER_ROLES = ['planner'], so all three
 * retired roles qualify) through `roleFlow`, which POSTs to THIS route and then
 * execs the backend LOCALLY — calling neither `spawnAgentInHarness` nor /invoke.
 * Until this gate, the retired tier stayed launchable by name with the flag OFF.
 *
 * The four cases below are deliberately a FALSIFIABLE set, not four hide-checks:
 * the SHOW control fails if the gate refuses unconditionally, and the
 * CALIBRATION fails if `isRetiredTierRole` degenerates to `() => true`. Without
 * both, "refuse everything" passes the whole suite.
 */
describe('bootstrap-role — P-013/D-022 retired-tier gate (the psu --role console door)', () => {
  it('flag OFF + role=mug ⇒ 403 mug_kettle_retired (HIDE)', async () => {
    mugKettleEnabledMock.mockResolvedValue(false);
    const res = await callPost({ role: 'mug', agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe('mug_kettle_retired');
    // WI-38263: the refusal used to carry `flag: 'papercusp-mug-kettle-system'` and tell the
    // caller to "flip the flag ON in /admin/features". P-068 DELETED that flag, so the
    // prescribed remedy could not be followed — the door named a control that does not exist.
    // Asserting the old field made this test CERTIFY the drift, so the test moved, not the code.
    expect(json.retired).toBe('permanent');
    expect(json.flag).toBeUndefined();
    // A binding needle, not a shape check: the refusal must never again prescribe an
    // impossible remedy. This fails if anyone reintroduces flip-the-flag wording here.
    expect(String(json.error)).not.toMatch(/flip the flag|re-enable the tier|\/admin\/features/i);
    expect(String(json.error)).toMatch(/no longer a flag to flip/i);
    // Refused BEFORE any launch work — no spec built, no session recorded.
    expect(buildRoleLaunchSpecMock).not.toHaveBeenCalled();
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('flag OFF + role=queen (pre-rename ALIAS) ⇒ still refused — the gate canonicalizes', async () => {
    // The whole point of keying on isRetiredTierRole rather than a raw string:
    // a spelling-matched gate looks closed and is open under the old names.
    mugKettleEnabledMock.mockResolvedValue(false);
    const res = await callPost({ role: 'queen', agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mug_kettle_retired');
  });

  it('gate mocked-open + role=mug ⇒ NOT refused — falsifiability control, NOT a reversibility claim', async () => {
    // Fails if the gate refuses UNCONDITIONALLY. Without this control, an
    // `isRetiredTierRole` that degenerated to `() => true` would pass the whole suite.
    //
    // WI-38263: this branch is UNREACHABLE in production, deliberately. P-068 DELETED
    // `papercusp-mug-kettle-system` and collapsed `mugKettleSystemEnabled()` to
    // `return false`, so the tier is retired PERMANENTLY. This rationale used to read
    // "the flag is `case: 'cutover'`; reversibility is the point" — stale in the same
    // direction as the refusal text this item fixed, because it told a future reader the
    // retirement is revertible. It is not. We drive the impossible value ON only as the
    // SHOW half of the falsifiable pair; it asserts nothing about restorability.
    // (lint:no-unreachable-tier-mock scopes to the FILE-WIDE DEFAULT, which here is OFF,
    // so deliberately driving the impossible branch in one case is legitimate and unflagged.)
    // consumes:none — the suite's beforeEach defaults to feature:'required',
    // which would 400 this launch for a reason unrelated to the gate and make
    // the control pass for the wrong reason.
    mugKettleEnabledMock.mockResolvedValue(true);
    roleConsumesMock.mockReturnValue({ feature: 'none', plan: 'none' });
    const res = await callPost({ role: 'mug', agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    expect(buildRoleLaunchSpecMock).toHaveBeenCalled();
  });

  it('flag OFF + role=worker ⇒ NOT refused — a non-retired role is untouched (CALIBRATION)', async () => {
    // Fails if isRetiredTierRole degenerates to `() => true`, which would
    // otherwise satisfy every hide-assertion above.
    mugKettleEnabledMock.mockResolvedValue(false);
    const res = await callPost({ role: 'worker', agent: 'claude', harness_slug: 'papercup', feature: 'F-001' });
    expect(res.status).toBe(200);
    expect(buildRoleLaunchSpecMock).toHaveBeenCalled();
  });
});
