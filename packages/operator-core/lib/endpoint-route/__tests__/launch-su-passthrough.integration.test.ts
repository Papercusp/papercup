/**
 * POST /api/adv/sessions/launch-su — kickoff + model + resume PASSTHROUGH
 * (P-032 omp-parity). The sibling `launch-su.test.ts` covers only the
 * agent/slug validation + `--no-plan`; this file covers the passthrough arm
 * the retired `buildEngineerOmpLaunchCommand` used to own:
 *
 *   - `kickoff: { kind: 'new-plan' }` → buildKickoffPromptFile → the generated
 *     file path is appended as `--launch-context=<file>`.
 *   - `model` → `--model=<model>` (fuzzy-validated MODEL_RE).
 *   - `resume_session_id` → `--resume-session=<id>` (SESSION_ID_RE).
 *   - kickoff GENERATION failure is best-effort: the launch still happens,
 *     just without the `--launch-context` flag (it must NOT 500/abort).
 *
 * spawn / fs / os are mocked (no terminal opens); buildKickoffPromptFile is
 * mocked so no /dev/shm file is written and we can force the failure path.
 */
import { EventEmitter } from 'node:events';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

// spawnInTerminal watches the returned ChildProcess for an early exit. Keep the
// fake EventEmitter-shaped so the shared watcher exercises the same contract as
// a real child; the old `{ unref, pid }` stub made every successful route return
// a `child.once is not a function` 500 once the watcher was introduced.
const spawnMock = vi.fn(() => Object.assign(new EventEmitter(), { unref: () => {}, pid: 4242 }));
// The kickoff prompt-file factory — mocked so generation is deterministic and
// its failure path is forceable.
const buildKickoffPromptFileMock = vi.fn(
  async (_ctx: any): Promise<string | null> => '/dev/shm/papercusp-kickoff-xyz/new-plan.md',
);

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
vi.mock('../../agent-kickoff/prompt-file', () => ({
  buildKickoffPromptFile: (...args: unknown[]) => buildKickoffPromptFileMock(...(args as [any])),
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
  // Real timers here (this is an integration suite touching real infra via
  // the unmocked interactive-safety-floor check — fake timers stalled it
  // indefinitely against that real async path, EI-18696184925888288). This
  // file's own concern (kickoff/model/resume passthrough) is orthogonal to
  // spawnInTerminal's liveness-check delay, which is covered directly by
  // terminal-spawn.test.ts + the sibling unit test files — just pay the real
  // (short, default) delay here rather than fighting the clock.
  return route.handler(req, CTX);
}

/** The bash oneliner is the last arg passed to spawn (`… bash -lc <oneliner>`). */
function lastOneliner(): string {
  const call = spawnMock.mock.calls[0] as unknown as [string, string[]];
  const args = call[1];
  return args[args.length - 1];
}

// Warm the heavy route module ONCE, outside any timed test body. The first
// `await import('../routes/adv/launch-su')` pulls in a large transform graph
// (~6s cold); paying it here under the 60s hook budget keeps every `it` body
// trivial. Without this the cost lands inside the FIRST test, and a load-induced
// slowdown on the loaded gate can push it past the 60s test timeout — which then
// also poisons the NEXT test: the killed-but-still-running handler invokes the
// shared `buildKickoffPromptFileMock` after the next test's `clearAllMocks`,
// making a "factory not called" assertion see a stale call. Warming removes both.
beforeAll(async () => {
  await import('../routes/adv/launch-su');
});

beforeEach(() => {
  vi.clearAllMocks();
  buildKickoffPromptFileMock.mockResolvedValue('/dev/shm/papercusp-kickoff-xyz/new-plan.md');
  // Spawned pid genuinely stays alive across the (real, ~400ms) liveness-check
  // delay in this environment — process.kill(pid,0) on our own PID is a
  // reliable, side-effect-free "yes" for that probe (see terminal-spawn.ts /
  // EI-18696184925888288). Every callPost here uses pid 4242 from spawnMock,
  // which is NOT a real process — kill(4242,0) would normally throw ESRCH, so
  // stub it to keep this file's existing (pre-liveness-check) assertions
  // intact; the liveness check itself is covered by terminal-spawn.test.ts.
  vi.spyOn(process, 'kill').mockReturnValue(true);
});

describe('launch-su kickoff passthrough', () => {
  it('kickoff:new-plan → buildKickoffPromptFile → --launch-context=<generated file>', async () => {
    const res = await callPost({
      agent: 'claude',
      harness_slug: 'papercup',
      kickoff: { kind: 'new-plan' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');

    // The factory is invoked with the new-plan kind + the active harness slug.
    expect(buildKickoffPromptFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'new-plan', harnessSlug: 'papercup' }),
    );
    const oneliner = lastOneliner();
    expect(oneliner).toContain('--launch-context=/dev/shm/papercusp-kickoff-xyz/new-plan.md');
  });

  it('no kickoff → factory not called, no --launch-context arg', async () => {
    await callPost({ agent: 'claude', harness_slug: 'papercup' });
    expect(buildKickoffPromptFileMock).not.toHaveBeenCalled();
    expect(lastOneliner()).not.toContain('--launch-context');
  });

  it('kickoff:new-plan launches the PLANNER role (hive-agent-tabs P-006); plain launches carry no role', async () => {
    await callPost({ agent: 'claude', harness_slug: 'papercup', kickoff: { kind: 'new-plan' } });
    // `=` form — psu drops the space-separated `--role planner`.
    expect(lastOneliner()).toContain('--role=planner');
    spawnMock.mockClear();
    await callPost({ agent: 'claude', harness_slug: 'papercup' });
    expect(lastOneliner()).not.toContain('--role=');
  });

  it('an unknown kickoff kind is rejected (400, no spawn, no generation)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', kickoff: { kind: 'wizard' } });
    expect(res.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(buildKickoffPromptFileMock).not.toHaveBeenCalled();
  });

  it('best-effort: a kickoff GENERATION failure still launches (no --launch-context, no 500)', async () => {
    buildKickoffPromptFileMock.mockRejectedValueOnce(new Error('brief render blew up'));
    const res = await callPost({
      agent: 'omp',
      harness_slug: 'papercup',
      kickoff: { kind: 'new-plan' },
    });
    // The launch must NOT fail just because the brief couldn't be assembled.
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(lastOneliner()).not.toContain('--launch-context');
  });

  it('best-effort: a null brief (un-assemblable kickoff) still launches without the flag', async () => {
    buildKickoffPromptFileMock.mockResolvedValueOnce(null);
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', kickoff: { kind: 'new-plan' } });
    expect(res.status).toBe(200);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(lastOneliner()).not.toContain('--launch-context');
  });
});

describe('launch-su model + resume passthrough', () => {
  it('model → --model=<model> in the oneliner', async () => {
    await callPost({ agent: 'claude', harness_slug: 'papercup', model: 'anthropic/claude-opus-4-7' });
    expect(lastOneliner()).toContain('--model=anthropic/claude-opus-4-7');
  });

  it('resume_session_id → --resume-session=<id> in the oneliner', async () => {
    await callPost({ agent: 'omp', harness_slug: 'papercup', resume_session_id: 's-7.thread_1' });
    expect(lastOneliner()).toContain('--resume-session=s-7.thread_1');
  });

  it('model + resume + kickoff compose into one oneliner', async () => {
    await callPost({
      agent: 'claude',
      harness_slug: 'papercup',
      plan_slug: 'my-plan',
      model: 'gpt-5.5',
      resume_session_id: 'sess-42',
      kickoff: { kind: 'new-plan' },
    });
    const oneliner = lastOneliner();
    expect(oneliner).toContain('--agent=claude');
    expect(oneliner).toContain('--harness=papercup');
    expect(oneliner).toContain('--plan=my-plan');
    expect(oneliner).toContain('--model=gpt-5.5');
    expect(oneliner).toContain('--resume-session=sess-42');
    expect(oneliner).toContain('--launch-context=/dev/shm/papercusp-kickoff-xyz/new-plan.md');
  });

  it('rejects an unsafe model (shell metacharacters) — no spawn', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', model: 'opus; rm -rf /' });
    expect(res.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects an unsafe resume session id — no spawn', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', resume_session_id: '$(whoami)' });
    expect(res.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('omitting model + resume emits neither flag', async () => {
    await callPost({ agent: 'claude', harness_slug: 'papercup' });
    const oneliner = lastOneliner();
    expect(oneliner).not.toContain('--model=');
    expect(oneliner).not.toContain('--resume-session=');
  });
});
