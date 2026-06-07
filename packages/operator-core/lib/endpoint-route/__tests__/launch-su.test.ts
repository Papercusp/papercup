/**
 * Unit tests for POST /api/adv/sessions/launch-su — validates the
 * psu oneliner construction + the agent/slug rejections (the
 * shell-injection-sensitive bits). spawn / fs / os are mocked so no
 * terminal is actually opened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';

const spawnMock = vi.fn(() => ({ unref: () => {}, pid: 4242 }));

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
  recordAdvSessionMock: vi.fn(async () => 99),
}));
vi.mock('../../adv-sessions', () => ({
  recordAdvSession: recordAdvSessionMock,
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
  return route.handler(req, CTX);
}

/** The bash oneliner is the last arg passed to spawn (`… bash -lc <oneliner>`). */
function lastOneliner(): string {
  const call = spawnMock.mock.calls[0] as unknown as [string, string[]];
  const args = call[1];
  return args[args.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
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
});
