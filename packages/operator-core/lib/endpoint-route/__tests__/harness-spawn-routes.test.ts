/**
 * P-031 (production-readiness-test-coverage) — `routes/harness/spawn.ts`
 * (/launch, /invoke, /resume). Carved out of P-013 because the cluster shells
 * out via `node:child_process.spawn` to the orchestrator — exercising it
 * unmocked risks real spawns. Here `spawn` is replaced with a controllable fake
 * child, and every side-effecting collaborator (launchRun, buildInvokeOnce,
 * org-PG, plugin hooks, fs) is mocked, so the tests assert:
 *   - public reachability + the loopback gate (403 from a non-loopback host),
 *   - payload / param validation (unknown project → 404, bad role → 400),
 *   - that /launch + /resume dispatch `launchRun`, and
 *   - that a valid /invoke dispatches `spawn()` with the exact argv from
 *     buildInvokeOnce — WITHOUT a real child process.
 *
 * Harness mirrors destructive-public-routes.test.ts: registerRoute → throwaway
 * Hono app → app.request(). The loopback guard is left REAL (it's under test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ── side-effecting collaborators (all mocked) ──
const launchRun = vi.fn();
vi.mock('../../harness-launch', () => ({ launchRun: (...a: unknown[]) => launchRun(...(a as [])) }));

const resolveProject = vi.fn();
const resolvePhasedProject = vi.fn();
vi.mock('../../harness-core', () => ({
  resolveProject: (...a: unknown[]) => resolveProject(...(a as [])),
  resolvePhasedProject: (...a: unknown[]) => resolvePhasedProject(...(a as [])),
  harnessDir: vi.fn(() => '/proj/.papercusp'),
}));
vi.mock('../../harness-phases', () => ({ phasePhaseLabel: vi.fn((x: unknown) => x) }));
vi.mock('../../harness-paths', () => ({ harnessPackageDir: vi.fn(() => '/harness-pkg') }));

const buildInvokeOnce = vi.fn((..._args: unknown[]) => ({
  command: 'node',
  args: ['invoke-once.js', '--role', 'worker'],
  env: { PAPERCUSP_TEST: '1' },
}));
const resolveSpawnBackendModel = vi.fn(() => ({ backend: 'omp', model: '' }));
vi.mock('../../harness-invoke-once', () => ({
  buildInvokeOnce: (...a: unknown[]) => buildInvokeOnce(...a),
  // The invoke route's spawn path (orchestrator-runner) also imports
  // resolveSpawnBackendModel from this module; the mock must mirror the full
  // named-export surface or Vitest 4's evaluator fails the link under
  // full-suite load (the route then 500s). See orchestrator-runner-spawn.test.
  resolveSpawnBackendModel: (...a: unknown[]) => resolveSpawnBackendModel(...a),
}));
const recordAdvSession = vi.fn(async () => 77);
const markAdvSessionEnded = vi.fn(async () => {});
vi.mock('../../adv-sessions', () => ({
  recordAdvSession: (...a: unknown[]) => recordAdvSession(...a),
  markAdvSessionEnded: (...a: unknown[]) => markAdvSessionEnded(...a),
}));

vi.mock('../../superuser-token', () => ({ SUPERUSER_TOKEN_PATH: '/fake/su-token' }));
vi.mock('../../plugin-host-runtime', () => ({
  firePluginLifecycle: vi.fn(),
}));
vi.mock('../../events/pipeline-events', () => ({
  emitPipelineEvent: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: vi.fn(() => ({ sql: {} })),
    listUnconsumedEvents: vi.fn(async () => []),
    consumeEvents: vi.fn(async () => {}),
  };
});
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

// fs: existsSync→false so the actions-dispatch path short-circuits; readFileSync
// throws so the SU-bearer read falls back to undefined; writes are no-ops.
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => {
      throw new Error('no file (mocked)');
    }),
    statSync: vi.fn(() => ({ mtimeMs: 0 })),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return { ...actual, unlink: vi.fn(async () => {}) };
});

// ── controllable fake child process ──
// The /invoke handler attaches stdout/stderr/close listeners synchronously after
// spawn() returns, then resolves its Promise on 'close'. We emit a line of stdout
// and close(0) on the next microtask — after the listeners are wired.
const spawnMock = vi.fn(() => makeFakeChild(0));
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...(a as [])) }));

function makeFakeChild(exitCode: number) {
  const stdoutCbs: Array<(d: unknown) => void> = [];
  const closeCbs: Array<(code: number) => void> = [];
  const child = {
    stdout: { on: (ev: string, cb: (d: unknown) => void) => ev === 'data' && stdoutCbs.push(cb) },
    stderr: { on: (_ev: string, _cb: unknown) => {} },
    on: (ev: string, cb: (code: number) => void) => {
      if (ev === 'close') closeCbs.push(cb);
    },
    kill: vi.fn(),
  };
  queueMicrotask(() => {
    stdoutCbs.forEach((cb) => cb(Buffer.from('decision line\n')));
    closeCbs.forEach((cb) => cb(exitCode));
  });
  return child;
}

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import spawnRoutes, { __test as spawnTest } from '../routes/harness/spawn';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;
const [launch, invoke, resume] = spawnRoutes as unknown as AnyRoute[];

function appWith(def: AnyRoute): Hono {
  const app = new Hono();
  registerRoute(app, def);
  return app;
}
const post = (b: unknown = {}) => ({
  method: 'POST',
  body: JSON.stringify(b),
  headers: { 'content-type': 'application/json' } as Record<string, string>,
});
const PROJECT = { slug: 'papercup', path: '/proj' };

beforeEach(() => {
  resolveProject.mockResolvedValue(PROJECT);
  resolvePhasedProject.mockResolvedValue(PROJECT);
  launchRun.mockResolvedValue({ ok: true, logPath: '/log/run.out' });
  resolveSpawnBackendModel.mockReturnValue({ backend: 'omp', model: '' });
  spawnMock.mockImplementation(() => makeFakeChild(0));
});
afterEach(() => vi.clearAllMocks());

describe('POST /harness/:slug/launch (P-031)', () => {
  it('is reachable with no auth header + dispatches launchRun on valid input', async () => {
    const res = await appWith(launch).request('/harness/papercup/launch', post({ extra: 'go' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, logPath: '/log/run.out' });
    expect(launchRun).toHaveBeenCalledWith(PROJECT, 'go');
  });

  it('returns 404 for an unknown project (no launchRun)', async () => {
    resolvePhasedProject.mockResolvedValue(null);
    const res = await appWith(launch).request('/harness/nope/launch', post());
    expect(res.status).toBe(404);
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('maps a launchRun failure to 500', async () => {
    launchRun.mockResolvedValue({ ok: false, error: 'boom' });
    const res = await appWith(launch).request('/harness/papercup/launch', post());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'boom' });
  });

  it('ignores a non-string extra (defaults to empty)', async () => {
    await appWith(launch).request('/harness/papercup/launch', post({ extra: { not: 'a string' } }));
    expect(launchRun).toHaveBeenCalledWith(PROJECT, '');
  });

  it('rejects a non-loopback host with 403 before any launch (D-009)', async () => {
    const res = await appWith(launch).request('http://192.168.1.50:3070/harness/papercup/launch', post());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'loopback_only' });
    expect(launchRun).not.toHaveBeenCalled();
  });
});

describe('POST /harness/:slug/invoke (P-031)', () => {
  it('routes through the spawnInvokeOnce chokepoint → spawn() with buildInvokeOnce argv + returns the captured output', async () => {
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=worker', post({}));
    expect(res.status).toBe(200);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The route now funnels through spawnInvokeOnce → runChild (unify-agent-spawn-chokepoint
    // P-008), which spawns the buildInvokeOnce argv `detached: true` (its own process group,
    // so the timeout/abort can group-kill the whole tree).
    expect(spawnMock).toHaveBeenCalledWith(
      'node',
      ['invoke-once.js', '--role', 'worker'],
      { cwd: '/proj', env: { PAPERCUSP_TEST: '1' }, detached: true },
    );
    expect(await res.json()).toMatchObject({
      ok: true,
      slug: 'papercup',
      role: 'worker',
      decisionLine: 'decision line',
      exitCode: 0,
      timedOut: false,
    });
  });

  it('reports ok:false when the child exits non-zero', async () => {
    // The chokepoint emits a one-line diagnostic to stderr on a non-zero exit with empty
    // stderr (orchestrator-runner.ts) — expected, so assert it explicitly rather than let
    // vitest-fail-on-console trip on it.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    spawnMock.mockImplementation(() => makeFakeChild(1));
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=worker', post({}));
    expect(res.status).toBe(200); // the route succeeds; the *run* failed
    expect(await res.json()).toMatchObject({ ok: false, exitCode: 1 });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[dbos-invoke] role=worker exited 1'));
    errSpy.mockRestore();
  });

  it('returns 404 for an unknown project (no spawn)', async () => {
    resolveProject.mockResolvedValue(null);
    const res = await appWith(invoke).request('/harness/nope/invoke?role=worker', post());
    expect(res.status).toBe(404);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid role name with 400 (no spawn)', async () => {
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=bad%20role', post());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid role name' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects a non-loopback host with 403 before any spawn (D-009)', async () => {
    const res = await appWith(invoke).request('http://192.168.1.50:3070/harness/papercup/invoke?role=worker', post());
    expect(res.status).toBe(403);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // P-071 smoke regression (local-hive-orchestration, 2026-06-10): the route
  // silently dropped fireLaunchBlueprint's `kickoff`, so the Queen woke with no
  // idea why. It now threads to the child as QUEEN_BRIEF (the same channel
  // fleet:spawn uses for the Queen brief → buildPrompt's situational overlay).
  it('threads body.kickoff to the child as extraEnv.QUEEN_BRIEF', async () => {
    const res = await appWith(invoke).request(
      '/harness/papercup/invoke?role=worker',
      post({ kickoff: 'Wake (manual): run the placement smoke.' }),
    );
    expect(res.status).toBe(200);
    expect(buildInvokeOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        extraEnv: expect.objectContaining({ QUEEN_BRIEF: 'Wake (manual): run the placement smoke.' }),
      }),
    );
  });

  it('omits QUEEN_BRIEF when no kickoff is sent', async () => {
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=worker', post({}));
    expect(res.status).toBe(200);
    const arg = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(arg?.extraEnv ?? {}).not.toHaveProperty('QUEEN_BRIEF');
  });

  // EI-506: QUEEN_BRIEF is the Queen→BEE situational overlay. For the QUEEN's own
  // wake the kickoff is a terse wake-reason that would render as a misleading
  // self-addressed overlay — and her wake reason is already in the wake brief's
  // "Woke by:" line. So when she HAS a wake brief, QUEEN_BRIEF is suppressed.
  it('EI-506: suppresses QUEEN_BRIEF for a queen wake that carries a wake brief', async () => {
    const res = await appWith(invoke).request(
      '/harness/papercup/invoke?role=queen',
      post({ kickoff: 'timer', queenBrief: '## Your wake brief\n**Woke by:** timer\n### Frontier — ready' }),
    );
    expect(res.status).toBe(200);
    const arg = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(arg?.extraEnv ?? {}).not.toHaveProperty('QUEEN_BRIEF');
    expect(arg?.extraEnv).toMatchObject({ QUEEN_WAKE_BRIEF: expect.stringContaining('Woke by') });
  });

  // EI-506 fallback: if the wake brief is absent (best-effort compute failed), the
  // kickoff is still threaded as QUEEN_BRIEF so the queen isn't left with no idea
  // why she woke (preserves the P-071 "why you woke" signal).
  it('EI-506: keeps QUEEN_BRIEF for a queen wake with NO wake brief (degraded fallback)', async () => {
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=queen', post({ kickoff: 'timer' }));
    expect(res.status).toBe(200);
    const arg = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(arg?.extraEnv).toMatchObject({ QUEEN_BRIEF: 'timer' });
  });

  it('fails closed when a tracked hive launch resolves to a backend without forced native session ids', async () => {
    resolveSpawnBackendModel.mockReturnValue({ backend: 'codex', model: 'gpt-5' });
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=queen&bpkind=hive', post({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false });
    expect(body.error).toMatch(/forced-native-session-id|codex/i);
    expect(recordAdvSession).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(buildInvokeOnce).not.toHaveBeenCalled();
  });

  it('tracks hive launches when the resolved backend supports forced native session ids', async () => {
    resolveSpawnBackendModel.mockReturnValue({ backend: 'claude-code', model: '' });
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=queen&bpkind=hive', post({}));
    expect(res.status).toBe(200);
    expect(recordAdvSession).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'claude',
      role: 'queen',
      cwd: '/proj',
      label: 'hive · papercup/queen',
      sessionId: expect.stringMatching(/[0-9a-f-]{36}/),
      coordOwnerId: expect.stringMatching(/^s-\d+-[0-9a-f]+$/),
    }));
    const arg = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(arg?.extraEnv).toMatchObject({
      PAPERCUSP_NATIVE_SESSION_ID: expect.stringMatching(/[0-9a-f-]{36}/),
      PAPERCUSP_SPAWN_ID: expect.stringMatching(/^s-\d+-[0-9a-f]+$/),
    });
    expect(markAdvSessionEnded).toHaveBeenCalledWith(77, 0);
  });
});

// P-071 smoke regression: both hive wakes were SIGTERM'd at ~91s because the
// route's 90s default applied to a full Queen duty cycle. Hive launches now
// default to the route ceiling; explicit timeoutMs still wins for both kinds.
describe('invoke helpers (__test)', () => {
  it('resolveInvokeTimeoutMs: 90s default for plain launches, ceiling default for hive', () => {
    expect(spawnTest.resolveInvokeTimeoutMs(undefined, false)).toBe(90_000);
    expect(spawnTest.resolveInvokeTimeoutMs(undefined, true)).toBe(2_700_000);
  });
  it('resolveInvokeTimeoutMs: explicit timeoutMs wins, clamped to [5s, 2700s]', () => {
    expect(spawnTest.resolveInvokeTimeoutMs(300_000, true)).toBe(300_000);
    expect(spawnTest.resolveInvokeTimeoutMs(1, false)).toBe(5_000);
    expect(spawnTest.resolveInvokeTimeoutMs(99_999_999, false)).toBe(2_700_000);
  });
  it('extractKickoff: trims, caps at 4000 chars, empty for non-strings', () => {
    expect(spawnTest.extractKickoff('  why  ')).toBe('why');
    expect(spawnTest.extractKickoff('x'.repeat(5_000)).length).toBe(4_000);
    expect(spawnTest.extractKickoff(42)).toBe('');
    expect(spawnTest.extractKickoff(undefined)).toBe('');
  });
});

describe('POST /harness/:slug/resume (P-031)', () => {
  it('dispatches launchRun on valid input', async () => {
    const res = await appWith(resume).request('/harness/papercup/resume', post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, logPath: '/log/run.out' });
    expect(launchRun).toHaveBeenCalledWith(PROJECT);
  });

  it('returns 404 for an unknown project', async () => {
    resolvePhasedProject.mockResolvedValue(null);
    const res = await appWith(resume).request('/harness/nope/resume', post());
    expect(res.status).toBe(404);
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('rejects a non-loopback host with 403 (D-009)', async () => {
    const res = await appWith(resume).request('http://192.168.1.50:3070/harness/papercup/resume', post());
    expect(res.status).toBe(403);
    expect(launchRun).not.toHaveBeenCalled();
  });
});
