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
const resolveAccountPinMock = vi.fn();
// WI-1408 (fleet-join-startup-assertion): a spy (not a fixed stub) so per-test cases
// can override the resolution outcome — the no-fleet default mirrors the prior fixed
// stub so every PRE-EXISTING test (none of which pass `fleet`/`fleet_name`) is unaffected.
const resolveFleetMock = vi.fn(async () => ({ env: {}, notice: null, fleetSlug: null, fleetRole: null }));
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
}));
vi.mock('../../adv-sessions', () => ({ recordAdvSession: recordAdvSessionMock }));
vi.mock('../../role-registry', () => ({ roleConsumes: (...a: unknown[]) => roleConsumesMock(...a) }));
vi.mock('../../role-launch-spec', () => ({ buildRoleLaunchSpec: (...a: unknown[]) => buildRoleLaunchSpecMock(...a) }));
vi.mock('../../role-codex-home', () => ({ writeRoleCodexHome: (...a: unknown[]) => writeRoleCodexHomeMock(...a) }));
// bootstrap-role also resolves named-fleet env from bootstrap-su (P-005); these
// CODEX_HOME unit cases pass no fleet, so stub the no-fleet default (empty env).
vi.mock('../routes/agent-mcp/bootstrap-su', () => ({
  resolveAccountPin: (...a: unknown[]) => resolveAccountPinMock(...a),
  resolveFleet: (...a: unknown[]) => resolveFleetMock(...a),
  // WI-1347 added reconstructPsuLaunchArgv (a PURE argv builder) + a call site in
  // bootstrap-role; this fully-mocked module must export it or the handler throws
  // at the call. The tests don't assert argv content (it flows downstream), so a
  // faithful minimal stub suffices.
  reconstructPsuLaunchArgv: (o: { agent?: string; role?: string | null }) =>
    ['psu', '--no-picker', `--agent=${o?.agent ?? ''}`, ...(o?.role ? [`--role=${o.role}`] : [])],
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
const getPlanContextBySlugMock = vi.fn(async (_slug?: string) => '## Source Plan Context\n\n**Plan:** `p1`');
vi.mock('../../plan-context-for-feature', () => ({ getPlanContextBySlug: (slug: string) => getPlanContextBySlugMock(slug) }));

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
  resolveAccountPinMock.mockResolvedValue({ env: {}, notice: null, accountId: null, provider: null });
  resolveFleetMock.mockResolvedValue({ env: {}, notice: null, fleetSlug: null, fleetRole: null });
  stampFleetMembershipMock.mockResolvedValue(null);
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
    // Launch invariants the primitive now produces (unify-launch-mechanics P-002).
    sid: 'role-abc', nativeSessionId: 'nsid-abc',
    claudeConfigDir: join(LC_DIR, 'session-claude', 'role-abc'),
    sessionMcpDir: join(LC_DIR, 'session-mcp', 'role-abc'),
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
    // Identity comes from the spec primitive now (P-002): PAPERCUSP_SID === spec.sid.
    expect(json.envelopeEnv.PAPERCUSP_SID).toBe('role-abc');
    // claude exact-resume (P-003 inv d): the forced native session id is exported
    // (the launcher turns it into `--session-id`) AND recorded on the adv row.
    expect(json.envelopeEnv.PAPERCUSP_NATIVE_SESSION_ID).toBe('nsid-abc');
    expect(buildRoleLaunchSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'worker', harnessSlug: 'papercup', featureId: 'F-001' }),
    );
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'worker', feature: 'F-001', agent: 'claude', coordOwnerId: 'role-abc', sessionId: 'nsid-abc' }),
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
    expect(json.envelopeEnv.PAPERCUSP_NATIVE_SESSION_ID).toBeUndefined();
    // The CODEX_HOME is built from the SAME signed role-scoped url as claude/omp,
    // and bakes the SAME sid the primitive minted (EI-4: url client === PAPERCUSP_SID
    // === codex-home baked client).
    expect(writeRoleCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ mcpUrl: 'http://localhost:3070/api/mcp?role=worker&sig=x', promptText: 'WORKER PROMPT', sid: 'role-abc' }),
    );
    // No .mcp.json written into the harness cwd for codex.
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'worker', feature: 'F-001', agent: 'codex' }),
    );
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.anything() }),
    );
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
    expect(resolveAccountPinMock).toHaveBeenCalledWith('default', 'codex-main', 'codex');
    expect(json.accountNotice).toMatch(/pinned to Codex account codex-main/i);
    expect(json.envelopeEnv.PAPERCUSP_ACCOUNT_ID).toBe('codex-main');
    expect(writeRoleCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ codexGatewayAccountId: 'codex-main' }),
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
