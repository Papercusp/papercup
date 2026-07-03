/**
 * Unit tests for POST /api/agent-mcp/console/bootstrap-su.
 *
 * Drives the route handler directly with a hand-built RouteContext and
 * mocks the heavy leaves (auth, envelope, session writer, buildLaunchSpec,
 * writeSuCodexHome). Asserts the P-020 raw-CLI result shape: a promptFile
 * (claude/omp) or codexHome (codex) + a per-session PAPERCUSP_SID (P-022),
 * NOT a `*-su` wrapper.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

// Redirect the launch-context file writes to a throwaway temp dir so the
// route's best-effort persistence doesn't touch the real ~/.papercusp.
const LC_DIR = mkdtempSync(join(tmpdir(), 'bootstrap-su-lc-'));
process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = LC_DIR;
// A real coord-extension file so coordExtPath resolves deterministically.
const COORD_EXT = join(LC_DIR, 'papercusp-coord.ts');
writeFileSync(COORD_EXT, '// coord ext');

const recordAdvSessionMock = vi.fn(async (_opts: unknown) => 42 as number | null);
const buildLaunchSpecMock = vi.fn(async (_input: any) => ({
  kind: 'su',
  role: 'su',
  runId: 'run-1',
  spawnId: 'spawn-1',
  harnessSlug: _input.harnessSlug ?? null,
  featureId: null,
  cwd: '/ignored-by-bootstrap',
  promptText: 'PLAYBOOK + CTX BODY',
  promptFile: '/prompts/papercusp-su-engineer.tools.md',
  mcpUrl: 'http://localhost:3070/api/mcp?superuser=1&workspace=default',
  mcpJsonContents: '{}',
}));
const writeSuCodexHomeMock = vi.fn((opts: any) => ({
  codexHome: `/fake/.papercusp/su-codex-homes/session-${opts.sessionKey}`,
  agentsPath: `/fake/.papercusp/su-codex-homes/session-${opts.sessionKey}/AGENTS.md`,
  configPath: `/fake/.papercusp/su-codex-homes/session-${opts.sessionKey}/config.toml`,
}));
// EI-155: the interactive-claude config-dir materializer. Mocked so the unit
// test never touches the dev box's real ~/.claude (the materializer's own
// symlink-farm behavior is covered by interactive-claude-config.test.ts).
const writeInteractiveClaudeConfigMock = vi.fn((opts: { sid: string }) => ({
  configDir: `/fake/.papercusp/session-claude/${opts.sid}`,
}));

vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => {}),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    status = 401;
    reason = 'denied';
  },
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'default',
  readRegistry: () => ({
    current: 'default',
    workspaces: [{ id: 'default', name: 'Default' }, { id: 'ws2', name: 'Second' }],
  }),
  workspaceById: (id: string) => (['default', 'ws2'].includes(id) ? { id, name: id } : undefined),
}));
vi.mock('../../console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async (o: { slug: string | null }) => ({
    cwd: o.slug ? `/proj/${o.slug}` : '/workspace',
    env: { PAPERCUSP_OPERATOR_URL: 'http://localhost:3070', ...(o.slug ? { PAPERCUSP_HARNESS_SLUG: o.slug } : {}) },
    mcpJsonContents: '',
    greetingCmd: '',
    needsSuperuserBootstrap: false,
    mode: 'shell',
  })),
}));
vi.mock('../../adv-sessions', () => ({ recordAdvSession: recordAdvSessionMock }));
// launch-wakeability: the route arms the standing inbox-wake at launch (right after
// recordAdvSession) so the session is parked/wakeable before its first turn. Mock it
// to keep the unit test hermetic (the real one pulls the await engine + PG) and to
// assert it's armed for the minted sid.
const armInboxWakeMock = vi.fn(async () => ({ awaitId: 1, eventKey: 'coord:inbox-wake:x', handleNote: 'n' }));
vi.mock('../../events/await/inbox-wake-arm', () => ({
  armInboxWake: (...a: unknown[]) => armInboxWakeMock(...(a as [any])),
}));
vi.mock('../../role-launch-spec', () => ({
  buildLaunchSpec: (...args: unknown[]) => buildLaunchSpecMock(...(args as [any])),
}));
vi.mock('../../role-codex-home', () => ({
  writeSuCodexHome: (...args: unknown[]) => writeSuCodexHomeMock(...(args as [any])),
}));
vi.mock('../../interactive-claude-config', () => ({
  writeInteractiveClaudeConfig: (...args: unknown[]) => writeInteractiveClaudeConfigMock(...(args as [any])),
}));
// The bootstrap handler fires a best-effort saved-prompts materialize side
// effect; this unit test isn't exercising it (the materialize integration test
// is), and running it for real would query the DB + write/prune the dev box's
// ~/.claude/commands. No-op it here.
vi.mock('../../saved-prompts-materialize', () => ({
  materializeWorkspacePrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeHarnessPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeCodexPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
}));
vi.mock('../../desktop-install/papercusp-files', () => ({
  resolveInstallPaths: () => ({ extensionPath: COORD_EXT }),
}));
vi.mock('../../superuser-token', () => ({
  readSuperuserToken: () => 'TESTBEARER',
}));
// D-013 brain pin: mock the old PG-backed pointer so retired paths can assert
// they do not touch it.
// EI-908: setBrainSession is workspace-scoped — (workspaceId, nativeSessionId).
const setBrainSessionMock = vi.fn(async (_ws: string, _id: string) => {});
const getBrainSessionMock = vi.fn(async (): Promise<string | null> => null);
vi.mock('../../brain-pin', () => ({
  setBrainSession: (...a: unknown[]) => setBrainSessionMock(...(a as [string, string])),
  getBrainSession: () => getBrainSessionMock(),
}));
// Account routing tests also use feature flags. importActual keeps the rest of
// flags/server real.
const getFlagMock = vi.fn(async (_key: string, _scope: string): Promise<boolean> => false);
vi.mock('@papercusp/flags/server', async (importActual) => ({
  ...(await importActual<typeof import('@papercusp/flags/server')>()),
  getFlag: (...a: unknown[]) => getFlagMock(...(a as [string, string])),
}));
// Old brain-brief dependencies remain mocked so tombstone tests can prove the
// retired launch path exits before computing a brief.
const listStartedHivesMock = vi.fn(async () => [{ workspaceId: 'default', installSlug: 'papercup' }]);
vi.mock('../../hive/started', () => ({ listStartedHives: (...a: unknown[]) => listStartedHivesMock(...(a as [])) }));
const computeQueenWakeBriefMock = vi.fn(async (): Promise<string | null> => '## QUEEN WAKE BRIEF\n- frontier: wi-1');
vi.mock('../../hive/queen-brief-launch', () => ({
  computeQueenWakeBrief: (...a: unknown[]) => computeQueenWakeBriefMock(...(a as [])),
}));
vi.mock('../../device-harnesses', () => ({
  listHarnessesFor: vi.fn(async () => [
    { slug: 'papercup', path: '/repo', harness_kind: null, has_state: true, status: 'active', iteration: 1, last_active_ts: null },
  ]),
}));
vi.mock('../../agent-tools/plans/source', () => ({
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
// psu-account-chooser P-002: resolveAccountPin reads the pool + the session-override,
// but ONLY when the gateway flag is on. Mock both so the gateway-ON branches are
// DB-free + deterministic (the gateway-OFF + no-account branches return before them).
type MockPoolAccount = { id: string; provider?: 'claude' | 'codex' };
const loadAccountPoolMock = vi.fn(async (_ws?: string): Promise<{ accounts: MockPoolAccount[] }> => ({ accounts: [{ id: 'aviynw6' }, { id: 'aviynw2' }] }));
vi.mock('../../deployment/account-pool-store', () => ({
  loadAccountPool: (...a: unknown[]) => loadAccountPoolMock(...(a as [string])),
}));
const getAccountOverrideMock = vi.fn(async (_ws: string) => ({ forcedAccounts: [] as string[], excludeAccounts: [] as string[] }));
vi.mock('../../deployment/account-session-override', () => ({
  getAccountOverride: (...a: unknown[]) => getAccountOverrideMock(...(a as [string])),
}));

// fleet-recolor-and-color-hardening P-002: mock ONLY the agent-fleets-store IO
// (createFleetIfAbsent / getFleetScheme / listFleets) so resolveFleet's color-env
// wiring is testable without PG. importActual keeps the REAL pure helpers
// (fleetSlugFromName, resolveFleetScheme) so the test exercises genuine slug +
// scheme resolution — i.e. it asserts the actual catalog hex reaches the env.
const createFleetIfAbsentMock = vi.fn();
const getFleetSchemeMock = vi.fn();
const listFleetsMock = vi.fn(async () => [] as unknown[]);
// WI-1408 (fleet-join-startup-assertion): resolveFleet's join branch now checks the
// slug is a REAL fleet via getFleet before handing back membership env. Default to a
// truthy record so every PRE-EXISTING "join an existing fleet" test (which never set
// this up) keeps its current, already-asserted behavior; the new existence-check
// tests below override it to null per-case.
const getFleetMock = vi.fn(async (_ws: string, slug: string) => ({
  workspaceId: 'default',
  fleetSlug: slug,
  title: slug,
  description: null,
  owner: 'su-1',
  leaderOwnerId: 'su-1',
  colorScheme: null,
  createdAt: 0,
  updatedAt: 0,
}));
vi.mock('../../agent-fleets-store', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    createFleetIfAbsent: createFleetIfAbsentMock,
    getFleetScheme: getFleetSchemeMock,
    listFleets: listFleetsMock,
    getFleet: getFleetMock,
  };
});

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
  const get = (await routesOf()).find((r) => r.method === 'GET' && (r as any).path?.endsWith('/options'))!;
  const req = new Request(`http://localhost:3070/api/agent-mcp/console/bootstrap-su/options${query}`, {
    method: 'GET',
  });
  return get.handler(req, CTX);
}

async function callBrainGet(): Promise<Response> {
  const get = (await routesOf()).find((r) => r.method === 'GET' && (r as any).path?.endsWith('/brain'))!;
  const req = new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-su/brain', {
    method: 'GET',
  });
  return get.handler(req, CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  recordAdvSessionMock.mockResolvedValue(42);
  // P-002 brain-brief defaults: one started hive + a brief string. Tests that
  // exercise the no-brief / no-hive branches override per-call.
  listStartedHivesMock.mockResolvedValue([{ workspaceId: 'default', installSlug: 'papercup' }]);
  computeQueenWakeBriefMock.mockResolvedValue('## QUEEN WAKE BRIEF\n- frontier: wi-1');
});

describe('bootstrap-su', () => {
  it('claude: builds the su spec, writes the playbook prompt file, mints PAPERCUSP_SID', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.sessionId).toBe(42);
    expect(json.cwd).toBe('/proj/papercup');
    expect(json.codexHome).toBeNull();

    // buildLaunchSpec drives the prompt; called with the su kind + plan context.
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'su',
        agent: 'claude',
        harnessSlug: 'papercup',
        profile: 'engineer', // P-023 default
        planSlug: 'my-plan',
        planTitle: 'My Plan',
        planNow: { state: 'do X', next: 'then Y' },
      }),
    );
    // The playbook+ctx prompt is written to a launch-context file.
    expect(json.promptFile).toMatch(/session-42\.md$/);
    expect(readFileSync(json.promptFile, 'utf8')).toBe('PLAYBOOK + CTX BODY');

    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: 'my-plan', agent: 'claude', mode: 'console' }),
    );
    expect(json.envelopeEnv.PAPERCUSP_AGENT).toBe('claude');
    expect(json.envelopeEnv.PAPERCUSP_SID).toMatch(/^su-/);
    expect(json.envelopeEnv.PAPERCUSP_ADV_SESSION_ID).toBe('42');
    expect(json.envelopeEnv.CODEX_HOME).toBeUndefined();
    // coord extension resolved for omp's -e (present in this test env).
    expect(json.coordExtPath).toBe(COORD_EXT);
  });

  it('EI-5503: returns the canonical kickoffPrompt for a plan-bound launch, null without a plan', async () => {
    const withPlan = await (await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' })).json();
    // AUTO OFF (this launch passes no auto/fleet) → a lead agent gets the ROUTING-GATE
    // kickoff (deriveLaunchPromptText(null, false)): read the plan via plans:get, then
    // present the execution options (do-it-yourself / Queen / fleet) and confirm before
    // working — instead of the "just work it" order. AUTO-ON's work-order kickoff (the
    // old default) is covered by launch.test.ts's deriveLaunchPromptText default case.
    expect(withPlan.kickoffPrompt).toContain('plans:get');
    expect(withPlan.kickoffPrompt).toContain('routing gate');
    expect(withPlan.kickoffPrompt).toContain('launch a fleet');
    expect(withPlan.kickoffPrompt).not.toContain('pick up the next actionable item');
    const noPlan = await (await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null })).json();
    expect(noPlan.kickoffPrompt).toBeNull();
  });

  it('EI-155: claude gets a per-session CLAUDE_CONFIG_DIR keyed by the minted sid', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    const sid = json.envelopeEnv.PAPERCUSP_SID;
    // The materializer is keyed by the SAME sid recorded as coord_owner_id, so
    // the wake-executor resume leg (sessionClaudeConfigDir(coordOwnerId)) lands
    // on the identical dir the launch wrote to.
    expect(writeInteractiveClaudeConfigMock).toHaveBeenCalledWith(expect.objectContaining({ sid }));
    expect(json.envelopeEnv.CLAUDE_CONFIG_DIR).toBe(`/fake/.papercusp/session-claude/${sid}`);
  });

  it('launch-wakeability: arms the standing inbox-wake at launch for the minted sid (parked before first turn)', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' })).json();
    const sid = json.envelopeEnv.PAPERCUSP_SID;
    expect(sid).toMatch(/^su-/);
    // The arm is the SAME owner id recorded as coord_owner_id, so the recorded-session
    // roster row (visible at launch) flips recorded → parked/wakeable immediately —
    // no dependence on the detached, lossy SessionStart lifecycle hook.
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ coordOwnerId: sid }));
    expect(armInboxWakeMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: sid, workspaceId: 'default' }),
    );
  });

  it('launch-wakeability: an arm failure is best-effort and never fails the launch', async () => {
    armInboxWakeMock.mockRejectedValueOnce(new Error('pg down'));
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.envelopeEnv.PAPERCUSP_SID).toMatch(/^su-/);
  });

  it('EI-155: omp/codex get NO CLAUDE_CONFIG_DIR (codex isolates via CODEX_HOME; omp by its own store)', async () => {
    const omp = await (await callPost({ agent: 'omp', harness_slug: 'papercup', plan_slug: null })).json();
    expect(omp.envelopeEnv.CLAUDE_CONFIG_DIR).toBeUndefined();

    vi.clearAllMocks();
    recordAdvSessionMock.mockResolvedValue(42);
    const codex = await (await callPost({ agent: 'codex', harness_slug: null, plan_slug: null })).json();
    expect(codex.envelopeEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(writeInteractiveClaudeConfigMock).not.toHaveBeenCalled();
  });

  it('EI-155: a materialize failure is non-fatal — the launch still succeeds without CLAUDE_CONFIG_DIR', async () => {
    writeInteractiveClaudeConfigMock.mockImplementationOnce(() => {
      throw new Error('symlink EACCES');
    });
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.envelopeEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
    // The session still has its identity + native id — only transcript isolation degraded.
    expect(json.envelopeEnv.PAPERCUSP_SID).toMatch(/^su-/);
    expect(json.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('no harness + no plan → playbook prompt still written; spec gets nulls', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: null, plan_slug: null, cwd: '/home/me' });
    const json = await res.json();
    expect(json.promptFile).toMatch(/session-42\.md$/);
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: null, planSlug: null }),
    );
  });

  it('omp: raw-CLI result (no wrapperBin), No-plan row + mode omp', async () => {
    const res = await callPost({ agent: 'omp', harness_slug: 'papercup', plan_slug: null });
    const json = await res.json();
    expect(json.planSlug).toBeNull();
    expect(json.wrapperBin).toBeUndefined();
    expect(json.codexHome).toBeNull();
    expect(json.coordExtPath).toBe(COORD_EXT);
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: null, agent: 'omp', mode: 'omp' }),
    );
  });

  it('codex → per-session CODEX_HOME (writeSuCodexHome) + CODEX_HOME env; workspace cwd', async () => {
    const res = await callPost({ agent: 'codex', harness_slug: null, plan_slug: null });
    const json = await res.json();
    expect(json.cwd).toBe('/workspace');
    expect(json.codexHome).toMatch(/su-codex-homes\/session-42$/);
    expect(json.envelopeEnv.CODEX_HOME).toBe(json.codexHome);
    expect(json.promptFile).toMatch(/AGENTS\.md$/);
    // writeSuCodexHome gets the spec's prompt + url + the minted sid.
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        promptText: 'PLAYBOOK + CTX BODY',
        mcpUrl: 'http://localhost:3070/api/mcp?superuser=1&workspace=default',
        sid: expect.stringMatching(/^su-/),
        token: 'TESTBEARER',
      }),
    );
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', mode: 'console' }),
    );
  });

  it('codex folds launch_context into AGENTS.md prompt text before writing CODEX_HOME', async () => {
    const kickoff = join(LC_DIR, 'kickoff.md');
    writeFileSync(kickoff, 'KICKOFF CONTEXT\n- continue the rollout\n');
    const res = await callPost({ agent: 'codex', harness_slug: 'papercup', plan_slug: 'my-plan', launch_context: kickoff });
    expect(res.status).toBe(200);
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        promptText: expect.stringContaining('PLAYBOOK + CTX BODY\n\n---\n## Launch Context\n\nKICKOFF CONTEXT\n- continue the rollout'),
      }),
    );
  });

  it('claude prompt-file delivery and codex AGENTS.md delivery start from the same assembled launch spec', async () => {
    const claude = await (await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' })).json();
    expect(readFileSync(claude.promptFile, 'utf8')).toBe('PLAYBOOK + CTX BODY');

    vi.clearAllMocks();
    recordAdvSessionMock.mockResolvedValue(43);
    const codex = await callPost({ agent: 'codex', harness_slug: 'papercup', plan_slug: 'my-plan' });
    expect(codex.status).toBe(200);
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ promptText: 'PLAYBOOK + CTX BODY' }),
    );
  });

  it('claude: mints + records + returns a native session id (the launcher forces it via --session-id)', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    expect(json.nativeSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // Recorded on the adv row so `psu --resume <native-uuid>` can correlate it.
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude', sessionId: json.nativeSessionId }),
    );
  });

  it('omp/codex: no forced native session id (resume via thread id / CODEX_HOME)', async () => {
    const omp = await (await callPost({ agent: 'omp', harness_slug: 'papercup', plan_slug: null })).json();
    expect(omp.nativeSessionId).toBeNull();
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'omp', sessionId: null }));

    vi.clearAllMocks();
    recordAdvSessionMock.mockResolvedValue(42);
    const codex = await (await callPost({ agent: 'codex', harness_slug: null, plan_slug: null })).json();
    expect(codex.nativeSessionId).toBeNull();
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', sessionId: null }));
  });

  it('retired brain launches are rejected before recording a session', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: null, plan_slug: null, brain: true });
    expect(res.status).toBe(410);
    expect((await res.json()).error).toMatch(/deprecated/);
    expect(setBrainSessionMock).not.toHaveBeenCalled();
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('D-013: non-brain launches never touch the pin', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null });
    expect(res.status).toBe(200);
    expect(setBrainSessionMock).not.toHaveBeenCalled();
  });

  it('retired GET /brain returns a 410 tombstone', async () => {
    const res = await callBrainGet();
    expect(res.status).toBe(410);
    expect((await res.json()).error).toMatch(/deprecated/);
    expect(getBrainSessionMock).not.toHaveBeenCalled();
  });

  it('P-002: a non-brain launch never computes a brief even with the flag ON', async () => {
    getFlagMock.mockResolvedValue(true);
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null });
    expect(res.status).toBe(200);
    expect(computeQueenWakeBriefMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown agent kind', async () => {
    const res = await callPost({ agent: 'gemini', harness_slug: 'papercup' });
    expect(res.status).toBe(400);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(buildLaunchSpecMock).not.toHaveBeenCalled();
  });

  it('P-023: threads --profile=power through to buildLaunchSpec', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', profile: 'power' });
    expect(res.status).toBe(200);
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ profile: 'power' }));
  });

  it('P-023: rejects an invalid profile (no silent fallback)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', profile: 'wizard' });
    expect(res.status).toBe(400);
    expect(buildLaunchSpecMock).not.toHaveBeenCalled();
  });

  it('P-025: accepts the generic profile (non-coding work hive) and threads it through', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', profile: 'generic' });
    expect(res.status).toBe(200);
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ profile: 'generic' }));
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
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws2' }));
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

  it('EI-202: a no-harness launch whose caller cwd is $HOME is relocated off $HOME (prompt-isolation leak)', async () => {
    // At $HOME the cwd-level CLAUDE.md / .claude/CLAUDE.md ARE the owner's personal
    // config, which Claude auto-loads as PROJECT memory — bypassing the per-session
    // CLAUDE_CONFIG_DIR skip-link (P-002). The launch must NOT run in $HOME; it
    // relocates to the internal workspace root (the mocked envelope cwd, '/workspace').
    const res = await callPost({ agent: 'claude', harness_slug: null, cwd: homedir() });
    const json = await res.json();
    expect(json.cwd).not.toBe(homedir());
    expect(json.cwd).toBe('/workspace');
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace' }));
  });
});

describe('resolveAccountPin (psu-account-chooser P-002)', () => {
  beforeEach(() => {
    getFlagMock.mockResolvedValue(false);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6' }, { id: 'aviynw2' }] });
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: [], excludeAccounts: [] });
  });
  const pin = async (requested: string | null, agent: 'claude' | 'omp' | 'codex' = 'claude') =>
    (await import('../routes/agent-mcp/bootstrap-su')).resolveAccountPin('default', requested, agent);

  it('no account → no env patch, no notice', async () => {
    expect(await pin(null)).toMatchObject({ env: {}, notice: null, accountId: null, provider: null });
    expect(await pin('   ')).toMatchObject({ env: {}, notice: null, accountId: null, provider: null });
  });

  it('gateway off → fail-soft notice, no env patch (the current live default)', async () => {
    getFlagMock.mockResolvedValue(false);
    const r = await pin('aviynw6');
    expect(r.env).toEqual({});
    expect(r.notice).toMatch(/gateway is off/i);
  });

  it('OMP account pinning routes through the gateway (D-006): the account-id signal, not the claude ANTHROPIC_BASE_URL env', async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('aviynw6', 'omp');
    // omp consumes PAPERCUSP_ACCOUNT_ID via its per-session models.yml — it must NOT
    // get the claude-CLI gatewaySpawnEnv (ANTHROPIC_BASE_URL/ANTHROPIC_CUSTOM_HEADERS).
    expect(r.env).toEqual({ PAPERCUSP_ACCOUNT_ID: 'aviynw6' });
    expect(r.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(r.accountId).toBe('aviynw6');
    expect(r.provider).toBe('claude');
    expect(r.notice).toMatch(/OMP routed through the inference gateway/i);
    expect(loadAccountPoolMock).toHaveBeenCalled();
  });

  it('unknown account (not in pool) → fail-soft notice', async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('not-a-real-acct');
    expect(r.env).toEqual({});
    expect(r.notice).toMatch(/not in the account pool/i);
  });

  it('account excluded by session-override → fail-soft notice', async () => {
    getFlagMock.mockResolvedValue(true);
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: [], excludeAccounts: ['aviynw6'] });
    const r = await pin('aviynw6');
    expect(r.env).toEqual({});
    expect(r.notice).toMatch(/exclude list/i);
  });

  it('account outside forcedAccounts allow-list → fail-soft notice', async () => {
    getFlagMock.mockResolvedValue(true);
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: ['aviynw2'], excludeAccounts: [] });
    const r = await pin('aviynw6');
    expect(r.env).toEqual({});
    expect(r.notice).toMatch(/allow-list/i);
  });

  it('valid + allowed + gateway on → gateway env pin + PAPERCUSP_ACCOUNT_ID + confirm notice', async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('aviynw6');
    expect(r.env.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
    expect(r.env.ANTHROPIC_CUSTOM_HEADERS).toContain('aviynw6');
    expect(r.env.PAPERCUSP_ACCOUNT_ID).toBe('aviynw6');
    expect(r.notice).toMatch(/pinned to account aviynw6/i);
  });

  // account-routing-3-options (owner, 2026-06-30): the ONE `account` value carries 3 explicit modes.
  it("explicit 'default'/'none'/'system' → skip the gateway entirely, even when it is ON", async () => {
    getFlagMock.mockResolvedValue(true); // gateway ON — `default` must STILL skip it (the system-account escape hatch)
    for (const kw of ['default', 'none', 'system', 'DEFAULT', ' System ']) {
      const r = await pin(kw);
      expect(r.env).toEqual({});
      expect(r.accountId).toBeNull();
      expect(r.notice).toMatch(/default system account.*inference gateway skipped/i);
    }
    // The pool is never consulted for a `default` route.
    expect(loadAccountPoolMock).not.toHaveBeenCalled();
  });

  it("'auto' (claude, gateway on) → gateway-routed with NO account pin (it auto-selects + fails over)", async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('auto');
    expect(r.env.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
    // CRUCIALLY no account pin → the gateway active()/drain-selects + fails over (vs a hard pin).
    expect(r.env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('account');
    expect(r.env.PAPERCUSP_ACCOUNT_ID).toBeUndefined();
    expect(r.accountId).toBeNull();
    expect(r.provider).toBe('claude');
    expect(r.notice).toMatch(/auto.*selects an available pool account and fails over/i);
    // No pool membership lookup — auto means "let the gateway pick", not "validate an id".
    expect(loadAccountPoolMock).not.toHaveBeenCalled();
  });

  it("'gateway' is an alias for 'auto'", async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('gateway');
    expect(r.accountId).toBeNull();
    expect(r.env.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
    expect(r.notice).toMatch(/auto/i);
  });

  it("'auto' + gateway OFF → fail-soft to the default credential", async () => {
    getFlagMock.mockResolvedValue(false);
    const r = await pin('auto');
    expect(r.env).toEqual({});
    expect(r.notice).toMatch(/--account auto ignored.*gateway is off/i);
  });

  it("'auto' is not wired for codex yet → fail-soft notice (codex needs a per-session config + explicit id)", async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('auto', 'codex');
    expect(r.env).toEqual({});
    expect(r.notice).toMatch(/auto gateway routing isn't wired for codex yet/i);
  });

  it('Codex account + codex agent → no Anthropic env, but carries account id for CODEX_HOME config', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6' }, { id: 'codex-main', provider: 'codex' }] });
    const r = await pin('codex-main', 'codex');
    expect(r.provider).toBe('codex');
    expect(r.accountId).toBe('codex-main');
    expect(r.env).toEqual({ PAPERCUSP_ACCOUNT_ID: 'codex-main' });
    expect(r.notice).toMatch(/pinned to Codex account codex-main/i);
  });

  it('Codex account + claude agent → fail-soft provider mismatch notice', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'codex-main', provider: 'codex' }] });
    const r = await pin('codex-main', 'claude');
    expect(r.env).toEqual({});
    expect(r.notice).toMatch(/codex account.*claude sessions require claude/i);
  });

  // P-006 (end-to-end through the POST handler): the launcher's `account` body field
  // flows → resolveAccountPin → the response's envelopeEnv + accountNotice.
  it('POST { account } → response carries the fail-soft notice when the gateway is off', async () => {
    getFlagMock.mockResolvedValue(false);
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup', account: 'aviynw6' })).json();
    expect(json.accountNotice).toMatch(/gateway is off/i);
    expect(json.envelopeEnv.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('POST { account } → response pins the account + sets the gateway env when on + valid', async () => {
    getFlagMock.mockResolvedValue(true);
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup', account: 'aviynw6' })).json();
    expect(json.accountNotice).toMatch(/pinned to account aviynw6/i);
    expect(json.envelopeEnv.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
    expect(json.envelopeEnv.PAPERCUSP_ACCOUNT_ID).toBe('aviynw6');
  });

  it('POST without account → no accountNotice, no gateway env (unchanged default)', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    expect(json.accountNotice).toBeNull();
    expect(json.envelopeEnv.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

describe('resolveAccountChoices (psu-account-chooser P-005)', () => {
  beforeEach(() => {
    getFlagMock.mockResolvedValue(false);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6' }, { id: 'aviynw2' }] });
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: [], excludeAccounts: [] });
  });
  const choices = async (agent: 'claude' | 'omp' | 'codex' = 'claude') => (await import('../routes/agent-mcp/bootstrap-su')).resolveAccountChoices('default', agent);

  it('gateway off → hidden (empty pool) — the current default', async () => {
    getFlagMock.mockResolvedValue(false);
    expect(await choices()).toEqual({ gatewayOn: false, pool: [], forcedAccounts: [], excludeAccounts: [], provider: 'claude' });
  });

  it('gateway on → pool ids + the active session-override', async () => {
    getFlagMock.mockResolvedValue(true);
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: ['aviynw6'], excludeAccounts: ['aviynw2'] });
    const r = await choices();
    expect(r.gatewayOn).toBe(true);
    expect(r.pool).toEqual(['aviynw6', 'aviynw2']);
    expect(r.forcedAccounts).toEqual(['aviynw6']);
    expect(r.excludeAccounts).toEqual(['aviynw2']);
  });

  it('Codex choices include only codex provider accounts', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6' }, { id: 'codex-main', provider: 'codex' }] });
    const r = await choices('codex');
    expect(r.provider).toBe('codex');
    expect(r.pool).toEqual(['codex-main']);
  });

  it('OMP choices resolve to the claude account pool (omp pins claude accounts, D-006)', async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await choices('omp');
    expect(r.gatewayOn).toBe(true);
    expect(r.provider).toBe('claude');
    expect(r.unsupportedReason).toBeUndefined();
    expect(loadAccountPoolMock).toHaveBeenCalled();
  });

  it('GET /options surfaces the accounts field (empty when gateway off)', async () => {
    getFlagMock.mockResolvedValue(false);
    const json = await (await callGet()).json();
    expect(json.accounts).toEqual({ gatewayOn: false, pool: [], forcedAccounts: [], excludeAccounts: [], provider: 'claude' });
  });
});

// fleet-recolor-and-color-hardening P-002: regression guard for the psu-picker
// fleet-color path. The reported bug — "create a new fleet in the psu menu and
// the terminal isn't recolored" — is exactly resolveFleet failing to emit
// PAPERCUSP_FLEET_BG/FG/CURSOR for a freshly-created fleet. Nothing guarded it.
// These tests assert BOTH branches (create-new + join-existing) carry the color
// env, and that the catalog's real hex reaches the env (real resolveFleetScheme).
describe('resolveFleet — terminal color env (fleet-color-schemes)', () => {
  let forest: { name: string; bg: string; fg: string; cursor: string };
  beforeEach(async () => {
    const { schemeByName } = await import('../../console-color-schemes');
    forest = schemeByName('forest')!;
  });

  async function resolveFleet(
    workspaceId: string,
    opts: { fleet?: string | null; fleetRole?: string | null; fleetName?: string | null; fleetScheme?: string | null; ownerId?: string },
  ) {
    const mod = await import('../routes/agent-mcp/bootstrap-su');
    return mod.resolveFleet(workspaceId, opts);
  }

  it('a NEW fleet (fleetName) carries the fleet color env — the regressed case', async () => {
    createFleetIfAbsentMock.mockResolvedValue({
      record: {
        workspaceId: 'default',
        fleetSlug: 'my-fleet',
        title: 'My Fleet',
        description: null,
        owner: 'su-1',
        leaderOwnerId: 'su-1',
        colorScheme: 'forest',
        createdAt: 0,
        updatedAt: 0,
      },
      created: true,
    });
    const { env, fleetRole, fleetSlug } = await resolveFleet('default', { fleetName: 'My Fleet', ownerId: 'su-1' });
    expect(fleetRole).toBe('leader');
    expect(fleetSlug).toBe('my-fleet');
    expect(env.PAPERCUSP_FLEET_SLUG).toBe('my-fleet');
    expect(env.PAPERCUSP_FLEET_ROLE).toBe('leader');
    // The actual catalog hex — not just "some value" — must reach the env.
    expect(env.PAPERCUSP_FLEET_BG).toBe(forest.bg);
    expect(env.PAPERCUSP_FLEET_FG).toBe(forest.fg);
    expect(env.PAPERCUSP_FLEET_CURSOR).toBe(forest.cursor);
  });

  it('a chosen catalog scheme (fleetScheme) is FORCED at create; unknown/absent → auto-allocate (null)', async () => {
    createFleetIfAbsentMock.mockResolvedValue({
      record: {
        workspaceId: 'default', fleetSlug: 'my-fleet', title: 'My Fleet', description: null,
        owner: 'su-1', leaderOwnerId: 'su-1', colorScheme: 'forest', createdAt: 0, updatedAt: 0,
      },
      created: true,
    });
    // A valid catalog name is passed straight through as the forced colorScheme.
    await resolveFleet('default', { fleetName: 'My Fleet', fleetScheme: 'royal-purple', ownerId: 'su-1' });
    expect(createFleetIfAbsentMock).toHaveBeenCalledWith(expect.objectContaining({ colorScheme: 'royal-purple' }));
    // An unknown name is rejected → null → the store auto-allocates the next unused.
    createFleetIfAbsentMock.mockClear();
    await resolveFleet('default', { fleetName: 'My Fleet', fleetScheme: 'not-a-real-scheme', ownerId: 'su-1' });
    expect(createFleetIfAbsentMock).toHaveBeenCalledWith(expect.objectContaining({ colorScheme: null }));
    // No scheme chosen → null (auto-allocate) — unchanged legacy behaviour.
    createFleetIfAbsentMock.mockClear();
    await resolveFleet('default', { fleetName: 'My Fleet', ownerId: 'su-1' });
    expect(createFleetIfAbsentMock).toHaveBeenCalledWith(expect.objectContaining({ colorScheme: null }));
  });

  it('an EXISTING fleet (fleet slug) carries the fleet color env', async () => {
    getFleetSchemeMock.mockResolvedValue({ name: 'forest', bg: forest.bg, fg: forest.fg, cursor: forest.cursor });
    const { env, fleetRole } = await resolveFleet('default', { fleet: 'team', ownerId: 'su-1' });
    expect(fleetRole).toBe('member');
    expect(env.PAPERCUSP_FLEET_SLUG).toBe('team');
    expect(env.PAPERCUSP_FLEET_BG).toBe(forest.bg);
    expect(env.PAPERCUSP_FLEET_FG).toBe(forest.fg);
    expect(env.PAPERCUSP_FLEET_CURSOR).toBe(forest.cursor);
  });

  it('no fleet ⇒ empty env (no color vars, byte-identical to today)', async () => {
    const { env, fleetSlug, fleetRole } = await resolveFleet('default', {});
    expect(env).toEqual({});
    expect(fleetSlug).toBeNull();
    expect(fleetRole).toBeNull();
  });

  it('an existing fleet with no resolvable scheme keeps slug/role but omits color vars', async () => {
    getFleetSchemeMock.mockResolvedValue(null);
    const { env } = await resolveFleet('default', { fleet: 'ghost' });
    expect(env.PAPERCUSP_FLEET_SLUG).toBe('ghost');
    expect(env.PAPERCUSP_FLEET_BG).toBeUndefined();
  });
});

// WI-1408 (fleet-join-startup-assertion): a --fleet=<slug> join must validate the slug
// is a REAL agent_fleets row before handing back membership env — otherwise a
// typo'd/stale slug "succeeds" silently: PAPERCUSP_FLEET_SLUG gets set to a fleet that
// never existed, a phantom membership invisible to fleet:assignments' roster of real
// rows even though the env var itself is non-null.
describe('resolveFleet — nonexistent-slug rejection (WI-1408)', () => {
  // Same dynamic-import helper as the sibling describe block above (each `describe`
  // is its own closure — the other block's local `resolveFleet` isn't in scope here).
  async function resolveFleet(
    workspaceId: string,
    opts: { fleet?: string | null; fleetRole?: string | null; fleetName?: string | null; fleetScheme?: string | null; ownerId?: string },
  ) {
    const mod = await import('../routes/agent-mcp/bootstrap-su');
    return mod.resolveFleet(workspaceId, opts);
  }

  it('joining an unknown slug ⇒ empty env, null slug/role, an explanatory notice', async () => {
    getFleetMock.mockResolvedValueOnce(null);
    const { env, fleetSlug, fleetRole, notice } = await resolveFleet('default', { fleet: 'ghost-fleet' });
    expect(env).toEqual({});
    expect(fleetSlug).toBeNull();
    expect(fleetRole).toBeNull();
    expect(notice).toMatch(/ghost-fleet.*does not exist/i);
  });

  it('POST { fleet } for an unknown slug is a hard 409 — never a silent unfleeted launch', async () => {
    getFleetMock.mockResolvedValueOnce(null);
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', fleet: 'ghost-fleet' });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.status).toBe('error');
    expect(json.error).toMatch(/fleet join failed/i);
    expect(json.error).toMatch(/ghost-fleet/i);
    // The launch must never have been recorded — the hard-fail is BEFORE session bookkeeping.
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('POST { fleet } for a real slug still returns 200 with fleetSlug/fleetRole in the result', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup', fleet: 'real-fleet' })).json();
    expect(json.status).toBe('ok');
    expect(json.fleetSlug).toBe('real-fleet');
    expect(json.fleetRole).toBe('member');
  });

  it('no fleet requested at all ⇒ still 200, fleetSlug/fleetRole both null (no assertion fires)', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    expect(json.status).toBe('ok');
    expect(json.fleetSlug).toBeNull();
    expect(json.fleetRole).toBeNull();
  });
});
