/**
 * POST /adv/sessions/launch-su — the HEADLESS contract (WI-6505).
 *
 * WHY THIS FILE EXISTS: the GUI's fleet-launch row (FleetLaunchRow.tsx) offers a
 * headed/headless picker, and its own tests mock `launchAgent` — so they prove the
 * UI SENDS `headless: true` and nothing more. Until this file, NOTHING verified
 * that the server ACTS on it. That gap is the exact hazard the feature's author
 * flagged: "DO NOT ship a headless control that silently launches HEADED
 * sessions." Delete the `--headless` push or the `spawnHeadless` branch and every
 * other test in the repo stays green while the row quietly opens windows.
 *
 * So the assertions here are deliberately about the FORK, not the happy path:
 * which spawn helper ran, which one did NOT, and that the two argvs differ by
 * exactly one token. A test that only checked "headless returns 200" would pass
 * against a server that ignored the flag entirely.
 *
 * Hermetic: every spawn/DB/workspace leaf is mocked (mirroring the pattern in
 * native-session-id-roundtrip.test.ts), but `shellEscape` is the REAL one so the
 * asserted command line is the one that would actually be executed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../define-route';

// Both mocks DECLARE their parameter so `.mock.calls[0][0]` is typed — that call
// argument is the whole assertion surface here (it carries the composed argv).
const spawnInTerminalMock = vi.fn(async (_opts: { oneliner: string; env: NodeJS.ProcessEnv }) => ({
  ok: true as const,
  terminal: 'xterm',
  pid: 4242 as number | undefined,
  likelyOpened: true,
}));
const spawnHeadlessMock = vi.fn(
  async (_opts: { envelope: { greetingCmd: string; cwd: string }; label: string; logDir: string }) => ({
    status: 'ok' as string,
    terminal: 'headless (log: /tmp/fleet-logs/x.log)',
    pid: 5151 as number | undefined,
    error: '' as string,
  }),
);

// `shellEscape` stays REAL (importOriginal): the oneliner we assert on is then
// byte-for-byte the command the spawn helper would have run.
vi.mock('../../../terminal-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../terminal-spawn')>();
  return {
    ...actual,
    isOnPath: () => true,
    spawnInTerminal: (o: any) => spawnInTerminalMock(o),
  };
});
vi.mock('../../../console-spawn', () => ({
  spawnHeadless: (o: any) => spawnHeadlessMock(o),
}));
vi.mock('../../../console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async () => ({
    cwd: '/workspace',
    env: {},
    mcpJsonContents: '',
    greetingCmd: '',
    needsSuperuserBootstrap: false,
    mode: 'shell',
  })),
}));
vi.mock('../../../papercusp-root', () => ({ papercuspPathForWorkspace: () => '/tmp/pc' }));
vi.mock('../../../mcp-base-url', () => ({ resolveSpawnHostOperatorBaseUrl: () => 'http://localhost:3070' }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
vi.mock('../../../interactive-safety-floor', () => ({
  checkInteractiveSafetyFloor: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock('../../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../../adv-sessions')>()),
  DISPLAY_TERMINAL_LAUNCH: 'terminal',
  recordAdvSession: vi.fn(async () => 7 as number | null),
}));
// Returns a PROMISE: the route fires it as `void notifySyncInvalidate(...).catch(...)`,
// so a bare vi.fn() (undefined) throws inside the handler.
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

type Route = { method: string; handler: (req: Request, ctx: RouteContext) => Promise<Response> };

async function launch(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const mod = await import('./launch-su');
  const post = (mod.default as unknown as Route[]).find((r) => r.method === 'POST')!;
  const req = new Request('http://localhost:3070/api/adv/sessions/launch-su', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'claude', harness_slug: null, plan_slug: null, ...body }),
  });
  const res = await post.handler(req, CTX);
  return { status: res.status, json: await res.json() };
}

/** The command line the route would actually execute, from whichever helper ran. */
function headedOneliner(): string {
  return spawnInTerminalMock.mock.calls[0]![0].oneliner;
}
function headlessOneliner(): string {
  return spawnHeadlessMock.mock.calls[0]![0].envelope.greetingCmd;
}
/** `--owner-id=su-<uuid>` is freshly minted per launch, so normalise it to diff two argvs. */
const normaliseOwner = (s: string): string => s.replace(/--owner-id=su-[0-9a-f-]+/i, '--owner-id=<pinned>');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('launch-su — headless routes to spawnHeadless, headed to spawnInTerminal (WI-6505)', () => {
  it('headless:true spawns HEADLESS and never opens a terminal', async () => {
    const { status, json } = await launch({ headless: true });
    expect(status).toBe(200);
    expect(json.status).toBe('ok');
    // The whole point: the headed path must not have run.
    expect(spawnHeadlessMock).toHaveBeenCalledTimes(1);
    expect(spawnInTerminalMock).not.toHaveBeenCalled();
    expect(headlessOneliner()).toContain('--headless');
  });

  it('headless:false spawns a TERMINAL and passes no --headless flag', async () => {
    const { status, json } = await launch({ headless: false });
    expect(status).toBe(200);
    expect(json.status).toBe('ok');
    expect(spawnInTerminalMock).toHaveBeenCalledTimes(1);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(headedOneliner()).not.toContain('--headless');
  });

  it('an OMITTED headless flag is headed — the null-safe default', async () => {
    await launch({});
    expect(spawnInTerminalMock).toHaveBeenCalledTimes(1);
    expect(spawnHeadlessMock).not.toHaveBeenCalled();
    expect(headedOneliner()).not.toContain('--headless');
  });

  /**
   * The source comments claim `--headless` is pushed LAST so the argv is
   * "otherwise byte-identical" to a headed launch. That claim is load-bearing —
   * it is what makes the headless path trustworthy as the same launch — so it is
   * asserted rather than believed.
   */
  it('the headless argv is the headed argv plus exactly one trailing token', async () => {
    await launch({ harness_slug: 'papercusp', plan_slug: 'some-plan', model: 'sonnet', headless: false });
    const headed = normaliseOwner(headedOneliner());
    vi.clearAllMocks();
    await launch({ harness_slug: 'papercusp', plan_slug: 'some-plan', model: 'sonnet', headless: true });
    const headless = normaliseOwner(headlessOneliner());

    // Every token goes through the REAL shellEscape, so the appended flag is quoted.
    expect(headless).toBe(`${headed} '--headless'`);
    expect(headless.match(/--headless/g)).toHaveLength(1);
  });

  it('a headless spawn FAILURE is reported as an error — never a silent headed fallback', async () => {
    spawnHeadlessMock.mockResolvedValueOnce({
      status: 'error',
      terminal: '',
      pid: undefined,
      error: 'boom: died at boot',
    });
    const { status, json } = await launch({ headless: true });
    expect(status).toBe(500);
    expect(json.status).toBe('error');
    expect(String(json.error)).toContain('boom: died at boot');
    // The failure must NOT be papered over by quietly opening a window instead.
    expect(spawnInTerminalMock).not.toHaveBeenCalled();
  });

  it('carries the fleet flag into a headless launch (the GUI fleet-launch row’s case)', async () => {
    // Members 2..N of a GUI fleet launch join by slug; a headless fleet member
    // must carry BOTH --fleet and --headless or the row silently splits the fleet
    // or opens windows the user asked not to see.
    await launch({ fleet: 'my-fleet', headless: true });
    const cmd = headlessOneliner();
    expect(cmd).toContain('--fleet=my-fleet');
    expect(cmd).toContain('--headless');
  });
});

describe('launch-su — the terminal child gets a RE-DERIVED operator base, never the inherited one (WI-6821 DEFECT A)', () => {
  const ORIGINAL = process.env.PAPERCUSP_OPERATOR_URL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = ORIGINAL;
  });

  /** The env the route actually handed the terminal. */
  const headedEnv = (): NodeJS.ProcessEnv => spawnInTerminalMock.mock.calls[0]![0].env;

  it('does NOT leak an /api/mcp-suffixed PAPERCUSP_OPERATOR_URL into the spawned terminal', async () => {
    // The exact shape the desktop sidecar was observed carrying. Inherited
    // verbatim it makes psu request …/api/mcp/api/… → 404 → `not_found` → exit 1
    // in ~0.4s; since the oneliner is `exec <psu …>`, that exit closes the window
    // and the launch dies silently, leaving the adv_sessions row stuck on
    // "Starting up — waiting for this session to come online…".
    process.env.PAPERCUSP_OPERATOR_URL = 'http://localhost:3070/api/mcp';
    await launch({ headless: false });

    expect(spawnInTerminalMock).toHaveBeenCalledTimes(1);
    const passed = headedEnv().PAPERCUSP_OPERATOR_URL;
    // The assertion that matters is the ABSENCE of the suffix — asserting only
    // the mocked value would still pass if the route stopped setting it at all.
    expect(passed).not.toMatch(/\/api\/mcp/);
    expect(passed).toBe('http://localhost:3070'); // from resolveSpawnHostOperatorBaseUrl
  });

  it('re-derives the base even when the operator carries NO pin of its own', async () => {
    delete process.env.PAPERCUSP_OPERATOR_URL;
    await launch({ headless: false });
    // Re-derived, not merely passed through: a child left with no pin would fall
    // back to its own resolution order and could reach a DIFFERENT operator than
    // the one that just pre-minted its coord owner and adv_sessions row.
    expect(headedEnv().PAPERCUSP_OPERATOR_URL).toBe('http://localhost:3070');
  });

  it('leaves the rest of the operator env intact — this is a targeted override, not a scrub', async () => {
    process.env.PAPERCUSP_OPERATOR_URL = 'http://localhost:3070/api/mcp';
    process.env.WI6821_CANARY = 'keep-me';
    try {
      await launch({ headless: false });
      expect(headedEnv().WI6821_CANARY).toBe('keep-me');
    } finally {
      delete process.env.WI6821_CANARY;
    }
  });
});
