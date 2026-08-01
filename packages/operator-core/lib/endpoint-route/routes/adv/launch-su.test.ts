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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../define-route';

const spawnInTerminalMock = vi.fn(async () => ({
  ok: true as const,
  terminal: 'xterm',
  pid: 4242 as number | undefined,
  likelyOpened: true,
}));
const spawnHeadlessMock = vi.fn(async () => ({
  status: 'ok' as string,
  terminal: 'headless (log: /tmp/fleet-logs/x.log)',
  pid: 5151 as number | undefined,
  error: '' as string,
}));

// `shellEscape` stays REAL (importOriginal): the oneliner we assert on is then
// byte-for-byte the command the spawn helper would have run.
vi.mock('../../../terminal-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../terminal-spawn')>();
  return {
    ...actual,
    isOnPath: () => true,
    spawnInTerminal: (...a: unknown[]) => spawnInTerminalMock(...(a as [])),
  };
});
vi.mock('../../../console-spawn', () => ({
  spawnHeadless: (...a: unknown[]) => spawnHeadlessMock(...(a as [])),
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
vi.mock('../../../adv-sessions', () => ({
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
  return (spawnInTerminalMock.mock.calls[0]![0] as any).oneliner as string;
}
function headlessOneliner(): string {
  return (spawnHeadlessMock.mock.calls[0]![0] as any).envelope.greetingCmd as string;
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
