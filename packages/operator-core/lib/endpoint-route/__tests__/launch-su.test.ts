/**
 * Unit tests for POST /api/adv/sessions/launch-su — validates the
 * psu oneliner construction + the agent/slug rejections (the
 * shell-injection-sensitive bits). spawn / fs / os are mocked so no
 * terminal is actually opened.
 *
 * spawnInTerminal (terminal-spawn.ts) now does a short post-spawn liveness
 * re-check (EI-18696184925888288) — fake timers drive it deterministically
 * (advanced past its delay in `callPost`) and `process.kill` is mocked to
 * report the spawned pid as alive by default, so existing assertions in this
 * file see the same `status:'ok'`, no-`warning` shape as before. The
 * dedicated "silent launch failure" describe block below flips that mock to
 * exercise the new `warning` field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const spawnMock = vi.fn(() => ({ unref: () => {}, pid: 4242 }));
const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: spawnMock };
});
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: () => true };
});
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => '/home/x' };
});

// Deferred-launch (D-006) records via recordAdvSession instead of spawning — mock
// it (vi.hoisted so the factory can reference the spy) so the defer_spawn path
// doesn't need a real PG.
const { recordAdvSessionMock } = vi.hoisted(() => ({
  recordAdvSessionMock: vi.fn(async (_opts: unknown) => 99),
}));
vi.mock('../../adv-sessions', () => ({ endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  recordAdvSession: recordAdvSessionMock,
}));

// A deferred (workbench) record fires a `roster` sync-invalidation so the pui
// dock-driver refetches /api/adv/roster and panes the launch immediately — mock
// sync-sse (it opens a real PG LISTEN connection otherwise) to spy on the emit.
const { notifySyncInvalidateMock } = vi.hoisted(() => ({
  notifySyncInvalidateMock: vi.fn(async (_name: string) => {}),
}));
vi.mock('../../sync-sse', () => ({
  notifySyncInvalidate: notifySyncInvalidateMock,
}));

// The agent-less branch resolves the CONFIGURED backend (owner ask
// 2026-06-07) via a dynamic import of agent-config — mock it so the test
// pins the config instead of reading the dev box's real file/PG.
const { effectiveBackendMock } = vi.hoisted(() => ({
  effectiveBackendMock: vi.fn(() => 'claude-code'),
}));
vi.mock('../../agent-config', () => ({
  readAgentConfig: vi.fn(async () => ({})),
  effectiveBackend: effectiveBackendMock,
}));

// P-012 safety floor (unify-agent-spawn-chokepoint): mocked so unit tests don't
// lazy-import fleet/operator-spawn (which drags the DBOS workflow graph + PG).
// Default = headroom available; the floor tests flip it to a refusal.
const { floorMock } = vi.hoisted(() => ({
  floorMock: vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true })),
}));
vi.mock('../../interactive-safety-floor', () => ({
  checkInteractiveSafetyFloor: floorMock,
}));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

async function callPost(body: unknown): Promise<Response> {
  const mod = await import('../routes/adv/launch-su');
  const route = (mod.default as Array<{ handler: (req: Request, ctx: RouteContext) => Promise<Response> }>)[0];
  const req = new Request('http://localhost:3070/api/adv/sessions/launch-su', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const resPromise = route.handler(req, CTX);
  // Flush spawnInTerminal's post-spawn liveness-check delay (default 400ms,
  // EI-18696184925888288) if this call took the live-spawn path — a no-op for
  // paths that never spawn (validation rejections, defer_spawn).
  await vi.advanceTimersByTimeAsync(500);
  return resPromise;
}

/** The bash oneliner is the last arg passed to spawn (`… bash -lc <oneliner>`). */
function lastOneliner(): string {
  const call = spawnMock.mock.calls[0] as unknown as [string, string[]];
  const args = call[1];
  return args[args.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // Default: the spawned pid stays alive past the liveness-check beat, i.e.
  // the "normal" success path — no `warning` on the response. Individual
  // tests in the "silent launch failure" block override this.
  killSpy.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('launch-su', () => {
  it('spawns psu --no-picker for a valid agent + harness + plan', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const oneliner = lastOneliner();
    expect(oneliner).toContain('--no-picker');
    expect(oneliner).toContain('--agent=claude');
    expect(oneliner).toContain('--harness=papercup');
    expect(oneliner).toContain('--plan=my-plan');
  });

  // WI-6363. The owner ask ("clicking +new session should open the gui chat
  // with them") was unimplementable because THIS route told the caller nothing
  // it could key a chat off: the terminal path records no adv_sessions row (psu
  // self-registers one asynchronously), so the response carried only
  // {status, agent, terminal, pid}. It now PRE-PINS the coord owner id via
  // `psu --owner-id=` and returns it. Both halves are asserted because either
  // one alone is silently useless: an id returned but not passed to psu binds
  // the chat to an owner the session never runs as (the exact split-identity
  // failure WI-5002 added the flag for), and an id passed but not returned
  // leaves the caller with nothing again.
  it('pre-pins a coord owner id, passes it to psu, and returns it (terminal path)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup' });
    const json = await res.json();
    expect(json.status).toBe('ok');
    // Must satisfy bootstrap-su's validator, else it 400s the boot.
    expect(json.ownerId).toMatch(/^su-[A-Za-z0-9][A-Za-z0-9._-]{5,118}$/);
    expect(lastOneliner()).toContain(`--owner-id=${json.ownerId}`);
  });

  it('pre-pins the owner id on the deferred path too, so the pui-run session binds to it', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', defer_spawn: true });
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.ownerId).toMatch(/^su-[A-Za-z0-9][A-Za-z0-9._-]{5,118}$/);
    // No terminal spawns here — the args are persisted as launch_argv instead,
    // so assert the recorded argv (not the oneliner) carries the pin.
    const recorded = recordAdvSessionMock.mock.calls.at(-1)?.[0] as { launchArgv?: string[] };
    expect(recorded?.launchArgv).toContain(`--owner-id=${json.ownerId}`);
  });

  // A RESUME must keep the identity it already has. Pinning a fresh owner onto
  // it would either be refused by bootstrap-su (id bound to a live row) or split
  // the resumed session from its own history.
  it('does NOT pre-pin an owner id when resuming an existing session', async () => {
    const res = await callPost({
      agent: 'claude',
      harness_slug: 'papercup',
      resume_session_id: 'abcd1234-5678-90ab-cdef-1234567890ab',
    });
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.ownerId).toBeUndefined();
    expect(lastOneliner()).not.toContain('--owner-id=');
    expect(lastOneliner()).toContain('--resume-session=');
  });

  it('mints a DIFFERENT owner id per launch (a reused id is refused as already-bound)', async () => {
    const a = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    vi.clearAllMocks();
    killSpy.mockReturnValue(true);
    const b = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    expect(a.ownerId).not.toBe(b.ownerId);
  });

  it('uses --no-plan when no plan is given', async () => {
    await callPost({ agent: 'omp', harness_slug: 'papercup' });
    expect(lastOneliner()).toContain('--no-plan');
    expect(lastOneliner()).toContain('--agent=omp');
  });

  it('defer_spawn records a pending workbench launch (no spawn) and returns advSessionId', async () => {
    const res = await callPost({
      agent: 'claude',
      harness_slug: 'papercup',
      plan_slug: 'my-plan',
      defer_spawn: true,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.deferred).toBe(true);
    expect(json.advSessionId).toBe(99);
    // No terminal spawned — the pui pane is the single launcher (D-001).
    expect(spawnMock).not.toHaveBeenCalled();
    // The recorded row is a pane-worthy workbench launch carrying the psu argv.
    expect(recordAdvSessionMock).toHaveBeenCalledTimes(1);
    const opts = recordAdvSessionMock.mock.calls[0][0] as {
      display?: string;
      launchArgv?: string[];
      agent?: string;
    };
    expect(opts.display).toBe('workbench');
    expect(opts.agent).toBe('claude');
    expect(opts.launchArgv).toEqual(
      expect.arrayContaining(['--no-picker', '--agent=claude', '--harness=papercup', '--plan=my-plan']),
    );
    // …and it wakes the pui dock-driver with a roster invalidation so the pane
    // opens deterministically (not on the firehose / 60s safety-net).
    expect(notifySyncInvalidateMock).toHaveBeenCalledWith('roster');
  });

  it('the live (non-deferred) spawn path does NOT fire a roster invalidation', async () => {
    // The active roster tier is presence-primary; a live spawn refreshes it via
    // its own coord_presence invalidation, so the launch route stays quiet here.
    await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(notifySyncInvalidateMock).not.toHaveBeenCalled();
  });

  it('agent-less launch resolves the CONFIGURED backend (claude-code → claude)', async () => {
    const res = await callPost({ harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.agent).toBe('claude');
    expect(effectiveBackendMock).toHaveBeenCalled();
    expect(lastOneliner()).toContain('--agent=claude');
  });

  it('agent-less launch passes a configured omp/codex straight through', async () => {
    effectiveBackendMock.mockReturnValueOnce('codex');
    const res = await callPost({ harness_slug: 'papercup' });
    const json = await res.json();
    expect(json.agent).toBe('codex');
    expect(lastOneliner()).toContain('--agent=codex');
  });

  it('rejects an unknown agent (no spawn)', async () => {
    const res = await callPost({ agent: 'gemini', harness_slug: 'papercup' });
    expect(res.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects an unsafe harness slug (no spawn)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'a; rm -rf /' });
    expect(res.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects an unsafe plan slug (no spawn)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: '$(whoami)' });
    expect(res.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // su-context-size-variants (WI-1282): context_size is validated (full|trimmed)
  // and, when valid, threaded into the psu argv as --context-size=<v>.
  it('threads a valid context_size=trimmed into the psu oneliner', async () => {
    const res = await callPost({ agent: 'codex', harness_slug: 'papercup', context_size: 'trimmed' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
    expect(lastOneliner()).toContain('--context-size=trimmed');
  });

  it('threads a valid context_size=full into the psu oneliner', async () => {
    await callPost({ agent: 'claude', harness_slug: 'papercup', context_size: 'full' });
    expect(lastOneliner()).toContain('--context-size=full');
  });

  it('omits --context-size when context_size is absent or empty (native default)', async () => {
    await callPost({ agent: 'claude', harness_slug: 'papercup' });
    expect(lastOneliner()).not.toContain('--context-size');
    spawnMock.mockClear();
    await callPost({ agent: 'claude', harness_slug: 'papercup', context_size: '' });
    expect(lastOneliner()).not.toContain('--context-size');
  });

  it('rejects a context_size typo with 400 (no spawn)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', context_size: 'trimed' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.error).toContain('context_size');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // P-012 (unify-agent-spawn-chokepoint): the psu web launch passes the SAME
  // interactive safety floor as the native console launch — admission waived,
  // ceiling enforced.
  it('passes the safety floor before spawning (floor consulted, launch proceeds)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    expect(floorMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('REFUSES with 429 when the floor reports no headroom (no spawn, no defer)', async () => {
    floorMock.mockResolvedValueOnce({ ok: false, reason: 'interactive launch refused by the safety floor: 16 ≥ 16' });
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.status).toBe('error');
    expect(body.error).toContain('safety floor');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('floor also gates the deferred (workbench) path — no row recorded over-ceiling', async () => {
    floorMock.mockResolvedValueOnce({ ok: false, reason: 'interactive launch refused by the safety floor' });
    const res = await callPost({ agent: 'claude', defer_spawn: true });
    expect(res.status).toBe(429);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    // No row recorded → nothing to pane → no roster wake.
    expect(notifySyncInvalidateMock).not.toHaveBeenCalled();
  });

  // EI-18696184925888288: launch-su reported {status:'ok', terminal, pid} even
  // when the spawned terminal never actually materialized (a headless/offscreen
  // display) — the OS spawn call not throwing is not proof a window opened.
  describe('silent launch failure (spawned process exits almost immediately)', () => {
    it('still returns status:ok (the syscall genuinely succeeded) but adds a warning', async () => {
      killSpy.mockImplementation(() => {
        throw new Error('ESRCH');
      });
      const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('ok');
      expect(json.terminal).toBe('gnome-terminal');
      expect(json.pid).toBe(4242);
      expect(typeof json.warning).toBe('string');
      expect(json.warning).toMatch(/exited almost immediately/);
    });

    it('the happy path (pid stays alive) carries no warning field', async () => {
      const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
      const json = await res.json();
      expect(json.status).toBe('ok');
      expect(json.warning).toBeUndefined();
    });

    it('the deferred (workbench) path never spawns, so it is unaffected (no warning possible)', async () => {
      killSpy.mockImplementation(() => {
        throw new Error('ESRCH');
      });
      const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan', defer_spawn: true });
      const json = await res.json();
      expect(json.status).toBe('ok');
      expect(json.deferred).toBe(true);
      expect(json.warning).toBeUndefined();
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });
});
