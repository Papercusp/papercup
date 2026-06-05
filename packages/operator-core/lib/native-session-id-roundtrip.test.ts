/**
 * Cross-CLI resume-correlation ROUND-TRIP: the claude `--session-id` contract
 * spans three stages that are each unit-tested in isolation but never JOINED:
 *
 *   1. bootstrap-su  — mints `nativeSessionId` (a UUID for claude), records it
 *                       on the adv_sessions row, and returns it.
 *   2. suLaunchArgs   — forces `claude --session-id <that uuid>` on fresh launch
 *                       so the OS process IS that session.
 *   3. resumeArgsFor  — later resumes `claude --resume <that uuid>` so
 *                       `psu --resume <uuid>` correlates back to the same row.
 *
 * The identity that matters is `minted === recorded === forced === resumed`
 * (claude), and that omp/codex stay `null` at every stage (they don't take a
 * forced id). Each half has a unit test; this file proves the WHOLE chain with
 * ONE minted uuid threaded through the REAL helpers (no re-implementation).
 *
 * Hermetic: bootstrap-su's heavy leaves are mocked exactly as the sibling
 * bootstrap-su test mocks them; suLaunchArgs/resumeArgsFor are imported live
 * from the actual psu-launcher.mjs.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from './endpoint-route/define-route';
// The REAL launcher helpers (the forcing + resuming halves of the contract).
import { suLaunchArgs, resumeArgsFor } from '../../../apps/operator/scripts/psu-launcher.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LC_DIR = mkdtempSync(join(tmpdir(), 'native-sid-rt-lc-'));
process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = LC_DIR;
const COORD_EXT = join(LC_DIR, 'papercusp-coord.ts');
writeFileSync(COORD_EXT, '// coord ext');

// Capture what bootstrap-su RECORDS on the adv row (the `sessionId` field =
// the native session id) so we can assert recorded === minted === forced.
let recordedSessionId: string | null | undefined;
const recordAdvSessionMock = vi.fn(async (opts: any) => {
  recordedSessionId = opts.sessionId;
  return 42 as number | null;
});
const buildLaunchSpecMock = vi.fn(async (_input: any) => ({
  kind: 'su',
  role: 'su',
  runId: 'run-1',
  spawnId: 'spawn-1',
  harnessSlug: _input.harnessSlug ?? null,
  featureId: null,
  cwd: '/ignored',
  promptText: 'PLAYBOOK + CTX BODY',
  promptFile: '/prompts/papercusp-su-engineer.tools.md',
  mcpUrl: 'http://localhost:3070/api/mcp?superuser=1',
  mcpJsonContents: '{}',
}));
const writeSuCodexHomeMock = vi.fn((opts: any) => ({
  codexHome: `/fake/su-codex-homes/session-${opts.sessionKey}`,
  agentsPath: `/fake/su-codex-homes/session-${opts.sessionKey}/AGENTS.md`,
  configPath: `/fake/su-codex-homes/session-${opts.sessionKey}/config.toml`,
}));

vi.mock('./auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => {}),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    status = 401;
    reason = 'denied';
  },
}));
vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => 'default',
  readRegistry: () => ({ current: 'default', workspaces: [{ id: 'default', name: 'Default' }] }),
  workspaceById: (id: string) => (id === 'default' ? { id, name: id } : undefined),
}));
vi.mock('./console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async (o: { slug: string | null }) => ({
    cwd: o.slug ? `/proj/${o.slug}` : '/workspace',
    env: { PAPERCUSP_OPERATOR_URL: 'http://localhost:3070' },
    mcpJsonContents: '',
    greetingCmd: '',
    needsSuperuserBootstrap: false,
    mode: 'shell',
  })),
}));
vi.mock('./adv-sessions', () => ({ recordAdvSession: recordAdvSessionMock }));
vi.mock('./role-launch-spec', () => ({
  buildLaunchSpec: (...args: unknown[]) => buildLaunchSpecMock(...(args as [any])),
}));
vi.mock('./role-codex-home', () => ({
  writeSuCodexHome: (...args: unknown[]) => writeSuCodexHomeMock(...(args as [any])),
}));
vi.mock('./saved-prompts-materialize', () => ({
  materializeWorkspacePrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeHarnessPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeCodexPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
}));
vi.mock('./desktop-install/papercusp-files', () => ({
  resolveInstallPaths: () => ({ extensionPath: COORD_EXT }),
}));
vi.mock('./superuser-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./superuser-token')>();
  return { ...actual, readSuperuserToken: () => 'TESTBEARER' };
});
vi.mock('./device-harnesses', () => ({ listHarnessesFor: vi.fn(async () => []) }));
vi.mock('./agent-tools/plans/source', () => ({
  resolveHarnessPlansDir: vi.fn(async () => ({ harnessSlug: 'papercup', plans: '/p', archive: '/p/a' })),
  listPlanFiles: vi.fn(async () => []),
  readPlanBySlug: vi.fn(async () => null),
}));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

type Route = { method: string; handler: (req: Request, ctx: RouteContext) => Promise<Response> };

async function bootstrap(agent: string): Promise<any> {
  const mod = await import('./endpoint-route/routes/agent-mcp/bootstrap-su');
  const post = (mod.default as Route[]).find((r) => r.method === 'POST')!;
  const req = new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-su', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent, harness_slug: null, plan_slug: null, cwd: '/home/me/work' }),
  });
  const res = await post.handler(req, CTX);
  return res.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  recordedSessionId = undefined;
  recordAdvSessionMock.mockImplementation(async (opts: any) => {
    recordedSessionId = opts.sessionId;
    return 42;
  });
});

describe('native session id round-trip (bootstrap-su → suLaunchArgs → resumeArgsFor)', () => {
  it('claude: one minted uuid is recorded, forced on launch, and resumed by id — all equal', async () => {
    const json = await bootstrap('claude');

    // Stage 1: minted + returned + recorded on the adv row (all the same uuid).
    const minted: string = json.nativeSessionId;
    expect(minted).toMatch(UUID_RE);
    expect(recordedSessionId).toBe(minted);

    // Stage 2: the launcher forces EXACTLY that uuid on the fresh claude launch.
    const launch = suLaunchArgs('claude', { promptFile: json.promptFile, nativeSessionId: minted });
    expect(launch.bin).toBe('claude');
    const sidIdx = launch.args.indexOf('--session-id');
    expect(sidIdx).toBeGreaterThanOrEqual(0);
    expect(launch.args[sidIdx + 1]).toBe(minted);

    // Stage 3: a later resume targets the SAME uuid (the correlation handle).
    const resume = resumeArgsFor({ agent: 'claude', sessionId: minted, cwd: json.cwd });
    expect(resume.bin).toBe('claude');
    const rIdx = resume.args.indexOf('--resume');
    expect(rIdx).toBeGreaterThanOrEqual(0);
    expect(resume.args[rIdx + 1]).toBe(minted);

    // The whole identity holds: minted === recorded === forced === resumed.
    expect(launch.args[sidIdx + 1]).toBe(resume.args[rIdx + 1]);
    expect(resume.args[rIdx + 1]).toBe(minted);
  });

  it('omp: native id is null end-to-end — never minted, never forced, resume falls back to -c', async () => {
    const json = await bootstrap('omp');

    expect(json.nativeSessionId).toBeNull();
    expect(recordedSessionId).toBeNull();

    // No --session-id is forced on the omp launch (it has no such flag).
    const launch = suLaunchArgs('omp', { promptFile: json.promptFile });
    expect(launch.args).not.toContain('--session-id');

    // Resume with a null native id → omp continues most-recent-in-cwd (-c), not by id.
    const resume = resumeArgsFor({ agent: 'omp', ompThreadId: null, cwd: json.cwd });
    expect(resume.args).toContain('-c');
    expect(resume.args).not.toContain('--session-id');
  });

  it('codex: native id is null end-to-end — never minted, never forced (resume via CODEX_HOME)', async () => {
    const json = await bootstrap('codex');

    expect(json.nativeSessionId).toBeNull();
    expect(recordedSessionId).toBeNull();

    const launch = suLaunchArgs('codex', { promptFile: json.promptFile });
    expect(launch.args).not.toContain('--session-id');

    // codex resume with no native id → `resume --last` from its per-session home.
    const resume = resumeArgsFor({ agent: 'codex', cwd: json.cwd });
    expect(resume.args).toContain('resume');
    expect(resume.args).toContain('--last');
  });

  it('claude: forcing the bootstrapped uuid is what makes resume-by-uuid match (would-be false-negative guard)', async () => {
    // Two independent claude bootstraps mint DISTINCT uuids — proving the id is
    // per-session, so resuming one never collides with the other.
    const a = await bootstrap('claude');
    const b = await bootstrap('claude');
    expect(a.nativeSessionId).not.toBe(b.nativeSessionId);

    const launchA = suLaunchArgs('claude', { promptFile: a.promptFile, nativeSessionId: a.nativeSessionId });
    const resumeA = resumeArgsFor({ agent: 'claude', sessionId: a.nativeSessionId });
    // A's forced id resumes A, and is NOT B's id.
    expect(launchA.args[launchA.args.indexOf('--session-id') + 1]).toBe(
      resumeA.args[resumeA.args.indexOf('--resume') + 1],
    );
    expect(resumeA.args).not.toContain(b.nativeSessionId);
  });
});
