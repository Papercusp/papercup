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
// D-013 brain pin: mock the PG-backed pointer so brain launches don't need a DB.
// EI-908: setBrainSession is workspace-scoped — (workspaceId, nativeSessionId).
const setBrainSessionMock = vi.fn(async (_ws: string, _id: string) => {});
const getBrainSessionMock = vi.fn(async (): Promise<string | null> => null);
vi.mock('../../brain-pin', () => ({
  setBrainSession: (...a: unknown[]) => setBrainSessionMock(...(a as [string, string])),
  getBrainSession: () => getBrainSessionMock(),
}));
// queen-interactive-brain-fresh-context P-003: GET /brain (and the POST brief
// append) consult FLAGS.QUEEN_BRAIN_FRESH BEFORE the pin — ON ⇒ report no pin so
// `psu --brain` always mints fresh. The flag defaults ENABLED, so without this
// mock GET /brain short-circuits to null and the D-013 resume-the-pin path is
// never exercised. Mock it OFF by default (resume path); the ON branch has its
// own test. importActual keeps the rest of flags/server real.
const getFlagMock = vi.fn(async (_key: string, _scope: string): Promise<boolean> => false);
vi.mock('@papercusp/flags/server', async (importActual) => ({
  ...(await importActual<typeof import('@papercusp/flags/server')>()),
  getFlag: (...a: unknown[]) => getFlagMock(...(a as [string, string])),
}));
// queen-interactive-brain-fresh-context P-002: a fresh-context brain launch
// appends the precomputed Queen wake brief to the launch-context prompt. Mock the
// started-hive resolver + the brief computer so the POST path's brief-injection
// branch runs without a live hive/DB. Defaults: one started hive, a brief string.
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
const loadAccountPoolMock = vi.fn(async (_ws?: string) => ({ accounts: [{ id: 'aviynw6' }, { id: 'aviynw2' }] }));
vi.mock('../../deployment/account-pool-store', () => ({
  loadAccountPool: (...a: unknown[]) => loadAccountPoolMock(...(a as [string])),
}));
const getAccountOverrideMock = vi.fn(async (_ws: string) => ({ forcedAccounts: [] as string[], excludeAccounts: [] as string[] }));
vi.mock('../../deployment/account-session-override', () => ({
  getAccountOverride: (...a: unknown[]) => getAccountOverrideMock(...(a as [string])),
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

  it('EI-155: claude gets a per-session CLAUDE_CONFIG_DIR keyed by the minted sid', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    const sid = json.envelopeEnv.PAPERCUSP_SID;
    // The materializer is keyed by the SAME sid recorded as coord_owner_id, so
    // the wake-executor resume leg (sessionClaudeConfigDir(coordOwnerId)) lands
    // on the identical dir the launch wrote to.
    expect(writeInteractiveClaudeConfigMock).toHaveBeenCalledWith(expect.objectContaining({ sid }));
    expect(json.envelopeEnv.CLAUDE_CONFIG_DIR).toBe(`/fake/.papercusp/session-claude/${sid}`);
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

  it('D-013: brain launch pins the minted native session id before returning', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: null, plan_slug: null, brain: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    // The pin IS the forced --session-id uuid — set server-side pre-exec.
    // EI-908: pinned under the launch's workspace-scoped key (workspace, uuid).
    expect(setBrainSessionMock).toHaveBeenCalledTimes(1);
    expect(setBrainSessionMock).toHaveBeenCalledWith(expect.any(String), json.nativeSessionId);
    expect(json.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('D-013: brain launches reject non-claude agents (no forceable session id to pin)', async () => {
    const res = await callPost({ agent: 'codex', harness_slug: null, plan_slug: null, brain: true });
    expect(res.status).toBe(400);
    expect(setBrainSessionMock).not.toHaveBeenCalled();
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('D-013: a failed pin fails the launch (no silent unpinned brain)', async () => {
    setBrainSessionMock.mockRejectedValueOnce(new Error('pg down'));
    const res = await callPost({ agent: 'claude', harness_slug: null, plan_slug: null, brain: true });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/brain pin failed/);
  });

  it('D-013: non-brain launches never touch the pin', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null });
    expect(res.status).toBe(200);
    expect(setBrainSessionMock).not.toHaveBeenCalled();
  });

  it('D-013: GET /brain returns the pin (null until one is set)', async () => {
    const empty = await (await callBrainGet()).json();
    // EI-908: the response echoes the resolved workspace (active = 'default' here).
    expect(empty).toEqual({ brainSessionId: null, workspace: 'default' });

    getBrainSessionMock.mockResolvedValueOnce('11111111-2222-3333-4444-555555555555');
    const pinned = await (await callBrainGet()).json();
    expect(pinned).toEqual({ brainSessionId: '11111111-2222-3333-4444-555555555555', workspace: 'default' });
  });

  it('D-013/P-003: GET /brain reports no pin when fresh-context is ON (psu --brain mints fresh)', async () => {
    // Even with a pin set, fresh-context ON forces null so `psu --brain` takes
    // its fresh mint-launch path — the pin is never consulted.
    getFlagMock.mockResolvedValueOnce(true);
    getBrainSessionMock.mockResolvedValueOnce('11111111-2222-3333-4444-555555555555');
    const res = await (await callBrainGet()).json();
    expect(res).toEqual({ brainSessionId: null, workspace: 'default' });
    expect(getBrainSessionMock).not.toHaveBeenCalled();
  });

  it('P-002: a fresh-context brain launch appends the computed Queen brief to the prompt file', async () => {
    getFlagMock.mockResolvedValue(true); // QUEEN_BRAIN_FRESH ON
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null, brain: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    // The brief was computed for the resolved started hive (the launch harness).
    expect(computeQueenWakeBriefMock).toHaveBeenCalledTimes(1);
    // The launch-context prompt = playbook + the appended brief.
    const prompt = readFileSync(json.promptFile, 'utf8');
    expect(prompt).toContain('PLAYBOOK + CTX BODY');
    expect(prompt).toContain('## QUEEN WAKE BRIEF');
    expect(prompt).toContain('- frontier: wi-1');
    // The brief is appended after the playbook, not spliced in.
    expect(prompt.indexOf('PLAYBOOK')).toBeLessThan(prompt.indexOf('QUEEN WAKE BRIEF'));
  });

  it('P-002: flag OFF → a brain launch does NOT compute or append a brief', async () => {
    getFlagMock.mockResolvedValue(false); // QUEEN_BRAIN_FRESH OFF (resume-the-pin world)
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null, brain: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(computeQueenWakeBriefMock).not.toHaveBeenCalled();
    expect(readFileSync(json.promptFile, 'utf8')).toBe('PLAYBOOK + CTX BODY');
  });

  it('P-002: a non-brain launch never computes a brief even with the flag ON', async () => {
    getFlagMock.mockResolvedValue(true);
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null });
    expect(res.status).toBe(200);
    expect(computeQueenWakeBriefMock).not.toHaveBeenCalled();
  });

  it('P-002: no brief computed (no hive woke / none ready) → playbook-only, fail-soft', async () => {
    getFlagMock.mockResolvedValue(true);
    computeQueenWakeBriefMock.mockResolvedValue(null); // no brief
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null, brain: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    // Still launches — just the su launch-context, no tail.
    expect(readFileSync(json.promptFile, 'utf8')).toBe('PLAYBOOK + CTX BODY');
  });

  it('P-002: no started hive → no brief (resolveBrainHiveSlug null), launch still succeeds', async () => {
    getFlagMock.mockResolvedValue(true);
    listStartedHivesMock.mockResolvedValue([]); // nothing started
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null, brain: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(computeQueenWakeBriefMock).not.toHaveBeenCalled();
    expect(readFileSync(json.promptFile, 'utf8')).toBe('PLAYBOOK + CTX BODY');
  });

  it('P-002: a brief computation that throws is fail-soft — the launch still succeeds with the playbook', async () => {
    getFlagMock.mockResolvedValue(true);
    computeQueenWakeBriefMock.mockRejectedValue(new Error('survey db down'));
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null, brain: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(readFileSync(json.promptFile, 'utf8')).toBe('PLAYBOOK + CTX BODY');
    // The pin still landed — only the brief degraded.
    expect(setBrainSessionMock).toHaveBeenCalledTimes(1);
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
  const pin = async (requested: string | null) =>
    (await import('../routes/agent-mcp/bootstrap-su')).resolveAccountPin('default', requested);

  it('no account → no env patch, no notice', async () => {
    expect(await pin(null)).toEqual({ env: {}, notice: null });
    expect(await pin('   ')).toEqual({ env: {}, notice: null });
  });

  it('gateway off → fail-soft notice, no env patch (the current live default)', async () => {
    getFlagMock.mockResolvedValue(false);
    const r = await pin('aviynw6');
    expect(r.env).toEqual({});
    expect(r.notice).toMatch(/gateway is off/i);
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
  const choices = async () => (await import('../routes/agent-mcp/bootstrap-su')).resolveAccountChoices('default');

  it('gateway off → hidden (empty pool) — the current default', async () => {
    getFlagMock.mockResolvedValue(false);
    expect(await choices()).toEqual({ gatewayOn: false, pool: [], forcedAccounts: [], excludeAccounts: [] });
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

  it('GET /options surfaces the accounts field (empty when gateway off)', async () => {
    getFlagMock.mockResolvedValue(false);
    const json = await (await callGet()).json();
    expect(json.accounts).toEqual({ gatewayOn: false, pool: [], forcedAccounts: [], excludeAccounts: [] });
  });
});
