/**
 * fleet/operator-spawn — unit coverage for the operator→agent nursery spawn
 * engine (Brief 4, agent-briefs-2026-06-05): harness/role/cap validation,
 * durable record/finish bookkeeping, the single-harness default, and the
 * failed-attempt rows that replace the old silent-drop dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));
vi.mock('@papercusp/agent-mcp', () => ({
  // 'overwatch' included so the B-10 flag-gate (which runs AFTER the known-role
  // check) is reachable in the gate tests below.
  AGENT_ROLES: ['scoper', 'worker', 'validator', 'reviewer', 'operator', 'bee', 'overwatch'],
}));
// @papercusp/flags itself stays REAL (FLAG_DEFAULTS / FLAGS); only the server-side
// getFlag is mocked so the overwatch gate's flag read is controllable. The default
// impl (set in beforeEach) returns each flag's real default, so the other getFlag
// callers in operator-spawn (WEDGE_AUTO_REAP / SPAWN_HANDOFF_HYDRATION) behave exactly
// as they did under the real getFlag's no-PostHog fallback — behavior-preserving.
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../harness-core', () => ({ resolveProject: vi.fn() }));
vi.mock('../harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));
vi.mock('../dbos/orchestrator-runner', () => ({ spawnInvokeOnce: vi.fn() }));
vi.mock('./spawn-tree', () => ({ recordSpawn: vi.fn(), finishSpawn: vi.fn() }));
vi.mock('../rate-limit-config', () => ({
  getCachedRateLimitConfig: () => ({ maxSimultaneousAgents: 16, concurrencyFloor: 1 }),
}));
vi.mock('./spawn-reclaim', () => ({
  heartbeatSpawns: vi.fn(async () => {}),
  reclaimOrphanedSpawns: vi.fn(async () => ({ reclaimed: 0, spawnIds: [], workspaces: [] })),
  SPAWN_HEARTBEAT_INTERVAL_MS: 60_000,
}));
// Lazy-imported by the slot-freed announce (D-004) — vi.mock intercepts the
// dynamic import too, so the spy sees every emit.
vi.mock('../events/await/engine', () => ({
  emitAwaitedEvent: vi.fn(async () => ({ ok: true, key: '', woken: 0, notified: [], msgId: null })),
}));

import { getOrgPg } from '@papercusp/db-org';
import { FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveProject } from '../harness-core';
import { loadHarnessRegistry } from '../harness-registry';
import { spawnInvokeOnce } from '../dbos/orchestrator-runner';
import { emitAwaitedEvent } from '../events/await/engine';
import { recordSpawn, finishSpawn } from './spawn-tree';
import { reclaimOrphanedSpawns } from './spawn-reclaim';
import {
  spawnAgentInHarness,
  abortLocalSpawn,
  spawnConcurrencyCeiling,
  spawnSlotEventKey,
  findBriefPlaceholder,
  selectWedgeReapCandidates,
  WEDGE_REAP_SILENT_MS,
} from './operator-spawn';

// `/tmp` exists on disk, so the project-dir existence check passes without fixtures.
const PROJECT = { slug: 'demo', path: '/tmp', hasState: true, hasSpec: false };

let runningCount = 0;
let dupRows: Array<{ spawn_id: string }> = [];
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  runningCount = 0;
  dupRows = [];
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // One template-tag fn answers every query by shape; `begin` (the atomic
  // admission tx, P-017/P-039) hands the same tag back as the tx.
  const tag = vi.fn(async (strings: TemplateStringsArray | string) => {
    const q = Array.isArray(strings) ? strings.join('') : String(strings);
    if (q.includes('SELECT spawn_id')) return dupRows; // idempotency dedupe probe
    if (q.includes('count(*)')) return [{ n: String(runningCount) }];
    return [];
  });
  const sql = Object.assign(tag, {
    begin: async (cb: (tx: unknown) => Promise<unknown>) => cb(tag),
  });
  vi.mocked(getOrgPg).mockReturnValue({ sql } as never);
  vi.mocked(resolveProject).mockResolvedValue(PROJECT as never);
  vi.mocked(loadHarnessRegistry).mockResolvedValue({ projects: [PROJECT] } as never);
  vi.mocked(spawnInvokeOnce).mockResolvedValue({ output: 'done!', exitCode: 0, stderr: '' });
  vi.mocked(recordSpawn).mockResolvedValue(undefined);
  vi.mocked(finishSpawn).mockResolvedValue(undefined);
  // Default getFlag → each flag's real default (no PostHog), matching the prior
  // real-getFlag fallback. Overwatch defaults OFF, so the gate rejects it unless a
  // test overrides this. Other callers (WEDGE_AUTO_REAP/SPAWN_HANDOFF_HYDRATION) keep
  // their default-true behavior.
  vi.mocked(getFlag).mockImplementation(
    async (key: string) => FLAG_DEFAULTS[key as keyof typeof FLAG_DEFAULTS] ?? false,
  );
});
afterEach(() => {
  errorSpy.mockRestore();
  vi.clearAllMocks();
});

/** Let the fire-and-forget completion chain settle. */
const flush = () => new Promise<void>((r) => setImmediate(r));

describe('spawnAgentInHarness — happy path', () => {
  it('resolves the harness, records the nursery row, launches, and finishes done', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1',
      harness: 'demo',
      role: 'validator',
      featureId: 'F-1',
      parentSpawnId: 'op-turn-1',
    });
    expect(res.ok).toBe(true);
    expect(res.spawnId).toMatch(/^s-\d+-/);
    expect(res.harness).toBe('demo');
    expect(res.projectDir).toBe('/tmp');

    // Durable record BEFORE the child launches, with lineage + ownership.
    expect(recordSpawn).toHaveBeenCalledTimes(1);
    const rec = vi.mocked(recordSpawn).mock.calls[0][1];
    expect(rec).toMatchObject({
      workspaceId: 'ws-1',
      harnessSlug: 'demo',
      childRole: 'validator',
      parentSpawnId: 'op-turn-1',
      parentRole: 'operator',
      featureId: 'F-1',
      status: 'running',
    });
    expect(rec.sessionOwner).toBe(rec.spawnId);

    // The child launches in the harness's REAL project dir with the registry
    // slug pinned in env (schema resolution) + the feature extra.
    expect(spawnInvokeOnce).toHaveBeenCalledTimes(1);
    const [dir, role, extras, env] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(dir).toBe('/tmp');
    expect(role).toBe('validator');
    expect(extras).toContain('FEATURE_ID=F-1');
    expect(env.HARNESS_SLUG).toBe('demo');
    expect(env.PAPERCUSP_WORKSPACE_ID).toBe('ws-1');

    await flush();
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: 'done',
      exitCode: 0,
      outputTail: 'done!',
    }));
  });

  it('a non-zero child exit finishes the row failed with the stderr tail', async () => {
    vi.mocked(spawnInvokeOnce).mockResolvedValue({ output: '', exitCode: 1, stderr: 'boom' });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'validator' });
    expect(res.ok).toBe(true);
    await flush();
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: 'failed',
      exitCode: 1,
      errorMessage: 'boom',
    }));
  });

  it('an exit-0 child with non-empty stderr persists stderr as errorMessage (WI-111 — session-limit diagnostic)', async () => {
    // Root cause of the 3.5-day archaeology: the session-limit message ("You've hit
    // your session limit") reaches the parent as stderr on an exit-0 process. The old
    // path dropped it (`exitCode === 0 ? null`), leaving error_message blank and the
    // cause invisible in fleet:tree / the Brew tab.
    const sessionMsg = "You've hit your session limit · resets 7:30pm (America/New_York)";
    vi.mocked(spawnInvokeOnce).mockResolvedValue({ output: '', exitCode: 0, stderr: sessionMsg });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    expect(res.ok).toBe(true);
    await flush();
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: 'done',
      exitCode: 0,
      errorMessage: sessionMsg,
    }));
  });
});

describe('spawnAgentInHarness — overwatch flag gate (overwatch-role-2026-06-15 B-10 / D-009)', () => {
  it('rejects role="overwatch" when papercusp-overwatch is OFF (the default) — registered but not activatable', async () => {
    // getFlag default impl returns FLAG_DEFAULTS[OVERWATCH] = false → gated.
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'overwatch' });
    expect(res.ok).toBe(false);
    // the flag-gate rejection, not the unknown-role rejection (overwatch IS registered)
    expect(res.error).toContain('papercusp-overwatch');
    expect(res.error).not.toContain('unknown role');
    // gated BEFORE any child process launches
    expect(spawnInvokeOnce).not.toHaveBeenCalled();
  });

  it('lets role="overwatch" past the gate when the flag is ON', async () => {
    vi.mocked(getFlag).mockImplementation(async (key: string) =>
      key === FLAGS.OVERWATCH ? true : (FLAG_DEFAULTS[key as keyof typeof FLAG_DEFAULTS] ?? false),
    );
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'overwatch' });
    await flush();
    // the gate passed → the spawn proceeds (happy-path mocks launch + finish it)
    expect(res.ok).toBe(true);
    expect(res.error).toBeFalsy(); // no rejection (success returns error: null)
    expect(spawnInvokeOnce).toHaveBeenCalled();
  });
});

describe('spawnAgentInHarness — forced session id for claude bees (P-016 / D-007)', () => {
  const findUpdate = () => {
    const sqlMock = vi.mocked(getOrgPg)().sql as unknown as ReturnType<typeof vi.fn>;
    return sqlMock.mock.calls.find(
      (c) => Array.isArray(c[0]) && (c[0] as string[]).join('').includes('UPDATE harness_shared.spawned_agents'),
    );
  };

  it('mints + records a session_id and threads forceSessionId for a claude backend', async () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    try {
      const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'validator' });
      expect(res.ok).toBe(true);

      // forceSessionId (a uuid) is threaded to the launcher so buildInvokeOnce bakes --session-id.
      const opts = vi.mocked(spawnInvokeOnce).mock.calls[0][4] as { forceSessionId?: string } | undefined;
      expect(opts?.forceSessionId).toMatch(/[0-9a-f-]{36}/);

      // ...and recorded on the nursery row via the best-effort UPDATE — same id.
      const updateCall = findUpdate();
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toBe(opts?.forceSessionId);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('mints NO session id for the omp backend (omp resumes by thread id)', async () => {
    // Force the omp backend explicitly — resolveSpawnBackendModel reads the AMBIENT
    // AGENT_CMD, which on any real agent box is `claude …` (the box runs claude bees),
    // so relying on the unset-env default would mint a uuid and fail in the gate.
    vi.stubEnv('AGENT_CMD', 'omp -p');
    try {
      const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'validator' });
      expect(res.ok).toBe(true);
      const opts = vi.mocked(spawnInvokeOnce).mock.calls[0][4] as { forceSessionId?: string } | undefined;
      expect(opts?.forceSessionId).toBeUndefined();
      expect(findUpdate()).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('abortLocalSpawn — fleet:cancel actually stops the child (EI-40)', () => {
  it('passes an AbortSignal to spawnInvokeOnce and abortLocalSpawn fires it', async () => {
    // Hold the child open so the spawn stays "live" (registered in the abort map)
    // until we abort it. Capture the signal handed to spawnInvokeOnce.
    let captured: AbortSignal | undefined;
    let resolveChild: (v: { output: string; exitCode: number; stderr: string }) => void;
    vi.mocked(spawnInvokeOnce).mockImplementation(((
      _d: string, _r: string, _e: string[], _env: Record<string, string>, opts?: { signal?: AbortSignal },
    ) => {
      captured = opts?.signal;
      return new Promise((res) => { resolveChild = res; });
    }) as never);

    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    expect(res.ok).toBe(true);
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);

    // The live spawn is locally tracked → abortLocalSpawn finds + signals it.
    expect(abortLocalSpawn(res.spawnId!)).toBe(true);
    expect(captured!.aborted).toBe(true);

    // Let the (now-aborted) child settle so the finally-cleanup runs.
    resolveChild!({ output: '', exitCode: 1, stderr: 'aborted (fleet:cancel)' });
    await flush();

    // The completion records 'cancelled' (abort was the cause), and the handle is
    // removed from the registry → a second abort is a no-op.
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId, status: 'cancelled',
    }));
    expect(abortLocalSpawn(res.spawnId!)).toBe(false);
  });

  it('abortLocalSpawn returns false for an unknown / already-finished spawn', async () => {
    expect(abortLocalSpawn('s-nonexistent')).toBe(false);
    // A spawn that finished normally is de-registered → not abortable.
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    await flush();
    expect(abortLocalSpawn(res.spawnId!)).toBe(false);
  });
});

describe('spawnAgentInHarness — harness resolution', () => {
  it('defaults to the single registered harness when none is named', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', role: 'scoper' });
    expect(res.ok).toBe(true);
    expect(res.harness).toBe('demo');
  });

  it('rejects when no harness is named and several are registered', async () => {
    vi.mocked(loadHarnessRegistry).mockResolvedValue({
      projects: [PROJECT, { ...PROJECT, slug: 'other' }],
    } as never);
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', role: 'scoper' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('2 are registered');
    expect(res.error).toContain('demo');
    expect(spawnInvokeOnce).not.toHaveBeenCalled();
  });

  it('rejects an unregistered harness, naming the registered ones, and records the failed attempt', async () => {
    vi.mocked(resolveProject).mockResolvedValue(null as never);
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'nope', role: 'scoper' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('"nope" is not a registered project');
    expect(res.error).toContain('demo');
    // The rejection is DURABLE — a failed nursery row, not a dropped warn.
    expect(recordSpawn).toHaveBeenCalledTimes(1);
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: 'failed',
      errorMessage: expect.stringContaining('nope'),
    }));
    expect(spawnInvokeOnce).not.toHaveBeenCalled();
  });
});

describe('spawnAgentInHarness — SU MCP slug remap (EI-429)', () => {
  // The Queen sometimes passes its SU MCP server slug ("<project>-su", or the
  // legacy "papercusp-su") as a spawn target instead of the registered project,
  // so every such spawn was rejected — burning Queen turns (a whole turn fired 5
  // bad-slug spawns). The central chokepoint deterministically remaps a KNOWN -su
  // MCP slug to its project (strip the "-su" suffix; alias the legacy
  // "papercusp-su" → the dogfood project "papercup") — never a silent normalize of
  // an arbitrary wrong slug — so the spawn proceeds against the real project.
  const PAPERCUP = { slug: 'papercup', path: '/tmp', hasState: true, hasSpec: false };
  // null for the -su MCP slug, the real project for the stripped base.
  const onlyResolves = (base: string) =>
    vi.mocked(resolveProject).mockImplementation(
      (async (s: string) => (s === base ? PAPERCUP : null)) as never,
    );

  it('remaps the "<project>-su" MCP slug to its project and spawns against it', async () => {
    onlyResolves('papercup');
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'papercup-su', role: 'scoper' });
    expect(res.ok).toBe(true);
    // the nursery row + child env carry the REMAPPED project slug, not the -su MCP slug
    expect(res.harness).toBe('papercup');
    expect(vi.mocked(recordSpawn).mock.calls[0][1]).toMatchObject({ harnessSlug: 'papercup' });
    const [dir, , , env] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(dir).toBe('/tmp');
    expect(env.HARNESS_SLUG).toBe('papercup');
  });

  it('aliases the legacy "papercusp-su" slug to the dogfood project "papercup"', async () => {
    onlyResolves('papercup');
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'papercusp-su', role: 'scoper' });
    expect(res.ok).toBe(true);
    expect(res.harness).toBe('papercup');
  });

  it('does NOT silently normalize an arbitrary wrong slug — a non -su typo still rejects', async () => {
    vi.mocked(resolveProject).mockResolvedValue(null as never);
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'paprcup', role: 'scoper' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('"paprcup" is not a registered project');
    expect(spawnInvokeOnce).not.toHaveBeenCalled();
  });

  it('rejects a "<base>-su" slug whose stripped base is also unregistered (remap only when the project exists)', async () => {
    // foo-su strips to foo, which is not a project → no remap, normal rejection.
    vi.mocked(resolveProject).mockResolvedValue(null as never);
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'foo-su', role: 'scoper' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('"foo-su" is not a registered project');
    expect(spawnInvokeOnce).not.toHaveBeenCalled();
  });
});

describe('spawnAgentInHarness — role + cap validation', () => {
  it('rejects an unknown role before touching the registry', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'wizard' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unknown role "wizard"');
    expect(spawnInvokeOnce).not.toHaveBeenCalled();
  });

  it('accepts a plugin-namespaced role (contains a colon)', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'myplugin:gardener' });
    expect(res.ok).toBe(true);
  });

  it('rejects worker without a chunk', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'worker' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('requires a chunk');
  });

  it('accepts worker with a chunk and passes CHUNK_ID through', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'worker', chunkId: 'F-1.c2',
    });
    expect(res.ok).toBe(true);
    const [, , extras] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(extras).toContain('CHUNK_ID=F-1.c2');
  });

  it('accepts the generic `bee` role WITHOUT a chunk (no pipeline guard — local-hive P-011)', async () => {
    // The flip-to-real-path criterion: fleet:spawn { role:'bee' } must pass
    // admission with no chunkId (unlike `worker`, which is chunk-coupled).
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'bee' });
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
    const [, role] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(role).toBe('bee');
  });

  it('threads the Queen brief into the child env as QUEEN_BRIEF (P-060 — the real delivery channel, not `extras`)', async () => {
    // P-060: the brief reaches the bee via extraEnv.QUEEN_BRIEF (which buildInvokeOnce
    // sets on the child env, and invoke-once's buildPrompt renders as `## Queen brief`),
    // NOT as a generic `extras` positional. Assert the real channel.
    const brief = 'watch for the migration race; this connects to bee-2; priority: unblock CI';
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'bee', brief,
    });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(env.QUEEN_BRIEF).toBe(brief);
  });

  it('threads the operator `s-…` spawnId into the child env as PAPERCUSP_SPAWN_ID (THE UMBILICAL — bee coord identity)', async () => {
    // The voice-gap fix: the durable s-… spawnId is the child's stable coord owner.
    // It rides extraEnv.PAPERCUSP_SPAWN_ID so invoke()/spawn-mcp bakes it as the signed
    // MCP URL's client= param → resolveAgentIdentity attributes the bee's coord writes
    // to it instead of throwing "no attributable identity".
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'bee' });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(env.PAPERCUSP_SPAWN_ID).toBe(res.spawnId);
    expect(env.PAPERCUSP_SPAWN_ID).toMatch(/^s-\d+-/);
  });

  it('rejects when the workspace is at the running-spawn ceiling', async () => {
    const ceiling = spawnConcurrencyCeiling();
    runningCount = ceiling;
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain(`ceiling ${ceiling}`);
    expect(spawnInvokeOnce).not.toHaveBeenCalled();
  });
});

/**
 * BENCH-SCOPED, FAIL-CLOSED OPUS PIN (P-033 Fix 2). Only a bench bee (the bench flag
 * PAPERCUSP_XBENCH_BEE_DIRECTIVE set) gets pinned to opus PER-SPAWN via
 * extraEnv.PAPERCUSP_SPAWN_MODEL — so the opus requirement is bench-scoped (a normal
 * hive bee keeps its committed haiku floor; no GLOBAL AGENT_MODELS opus needed). The
 * pin is the highest-precedence model channel buildInvokeOnce reads, so a paused opus
 * bucket WAITS (fail-closed) and the floor-clamp never downgrades below it.
 */
describe('spawnAgentInHarness — bench-scoped opus pin (P-033 Fix 2)', () => {
  const KEY = 'PAPERCUSP_XBENCH_BEE_DIRECTIVE';
  const MODEL = 'PAPERCUSP_XBENCH_MODEL';
  let savedKey: string | undefined;
  let savedModel: string | undefined;
  beforeEach(() => {
    savedKey = process.env[KEY];
    savedModel = process.env[MODEL];
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env[KEY]; else process.env[KEY] = savedKey;
    if (savedModel === undefined) delete process.env[MODEL]; else process.env[MODEL] = savedModel;
  });

  it('pins a BENCH bee to opus:xhigh via PAPERCUSP_SPAWN_MODEL when the bench flag is set', async () => {
    process.env[KEY] = 'claim + implement your lone bench feature';
    delete process.env[MODEL]; // default → opus:xhigh
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'bee' });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(env.PAPERCUSP_SPAWN_MODEL).toBe('opus:xhigh');
  });

  it('honors the PAPERCUSP_XBENCH_MODEL knob', async () => {
    process.env[KEY] = 'claim + implement your lone bench feature';
    process.env[MODEL] = 'opus:high';
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'bee' });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(env.PAPERCUSP_SPAWN_MODEL).toBe('opus:high');
  });

  it('does NOT pin a bee to opus when the bench flag is unset (normal hive keeps its floor)', async () => {
    delete process.env[KEY];
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'bee' });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(env.PAPERCUSP_SPAWN_MODEL).toBeUndefined();
  });

  it('does NOT pin a non-bee role even under the bench flag (only bench bees are pinned)', async () => {
    process.env[KEY] = 'claim + implement your lone bench feature';
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(env.PAPERCUSP_SPAWN_MODEL).toBeUndefined();
  });
});

describe('un-substituted brief placeholder guard (EI-249 — dispatch-pack stampede)', () => {
  describe('findBriefPlaceholder (pure)', () => {
    it('flags the repo `{item}` template token and the historical `brief-NN` placeholder', () => {
      expect(findBriefPlaceholder('Universal schema {item}: single handler')).toBe('{item}');
      expect(findBriefPlaceholder('You are brief-NN — read brief-NN-*.md and execute it')).toBe('brief-NN');
      expect(findBriefPlaceholder('You are Brief-NN')).toBe('Brief-NN'); // case-insensitive
    });

    it('passes a fully-substituted brief, an empty/absent brief, and incidental text', () => {
      expect(findBriefPlaceholder('Universal schema reviews: single handler')).toBeNull();
      expect(findBriefPlaceholder('watch for the migration race; priority: unblock CI')).toBeNull();
      expect(findBriefPlaceholder('')).toBeNull();
      expect(findBriefPlaceholder(null)).toBeNull();
      expect(findBriefPlaceholder(undefined)).toBeNull();
      // tight by design — no false positive on words merely containing the marker letters
      expect(findBriefPlaceholder('debrief the inn-keeper about ANN')).toBeNull();
    });
  });

  it('REFUSES to spawn when the brief still holds a placeholder — durable, no child launched', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'bee',
      brief: 'You are brief-NN — read brief-NN-*.md and execute it',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('un-substituted placeholder "brief-NN"');
    expect(res.error).toContain('EI-249');
    // refused BEFORE any child process launches — no claim-race stampede
    expect(spawnInvokeOnce).not.toHaveBeenCalled();
    // the rejection is DURABLE (a failed nursery row), not a silent drop
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: 'failed',
      errorMessage: expect.stringContaining('un-substituted placeholder'),
    }));
  });

  it('also refuses the `{item}` template token (a caller that bypassed buildWaveFeatures)', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'bee', brief: 'Implement the {item} handler',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('un-substituted placeholder "{item}"');
    expect(spawnInvokeOnce).not.toHaveBeenCalled();
  });

  it('a fully-substituted brief spawns normally — the guard never false-positives', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'bee', brief: 'Implement the reviews handler',
    });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnce).mock.calls[0];
    expect(env.QUEEN_BRIEF).toBe('Implement the reviews handler');
  });
});

describe('spawnAgentInHarness — idempotency dedupe (P-017 / EI-73)', () => {
  it('a retry with a matched idempotencyKey returns the ORIGINAL spawn, launching nothing', async () => {
    dupRows = [{ spawn_id: 's-original-123' }];
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'scoper', idempotencyKey: 'retry-key-1',
    });
    expect(res.ok).toBe(true);
    expect(res.spawnId).toBe('s-original-123');
    expect(res.deduped).toBe(true);
    expect(recordSpawn).not.toHaveBeenCalled();
    expect(spawnInvokeOnce).not.toHaveBeenCalled();
  });

  it('an unmatched idempotencyKey spawns normally and stamps the key on the row', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'scoper', idempotencyKey: 'fresh-key',
    });
    expect(res.ok).toBe(true);
    expect(res.deduped).toBeUndefined();
    expect(recordSpawn).toHaveBeenCalledTimes(1);
    const sqlMock = vi.mocked(getOrgPg)().sql as unknown as ReturnType<typeof vi.fn>;
    const stamp = sqlMock.mock.calls.find(
      (c) => Array.isArray(c[0]) && (c[0] as string[]).join('').includes('SET idempotency_key'),
    );
    expect(stamp).toBeDefined();
    expect(stamp![1]).toBe('fresh-key');
  });

  it('a spawn without a key never touches the dedupe probe', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    expect(res.ok).toBe(true);
    const sqlMock = vi.mocked(getOrgPg)().sql as unknown as ReturnType<typeof vi.fn>;
    const probe = sqlMock.mock.calls.find(
      (c) => Array.isArray(c[0]) && (c[0] as string[]).join('').includes('SELECT spawn_id'),
    );
    expect(probe).toBeUndefined();
  });
});

describe('over-ceiling slot-wait — queue + await, never a silent drop (D-004)', () => {
  it('an over-ceiling rejection carries the wake key + the events:await instruction', async () => {
    runningCount = spawnConcurrencyCeiling();
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    expect(res.ok).toBe(false);
    // The caller sleeps on this exact key and retries on wake — no drop, no busy-wait.
    expect(res.awaitEvent).toBe(spawnSlotEventKey('ws-1'));
    expect(res.error).toContain(`events:await { event: "${spawnSlotEventKey('ws-1')}" }`);
  });

  it('a finished spawn announces the freed slot on the workspace slot key', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    expect(res.ok).toBe(true);
    await flush();
    await flush(); // the announce is a void-chained promise off the finally
    expect(emitAwaitedEvent).toHaveBeenCalledWith(expect.objectContaining({
      key: spawnSlotEventKey('ws-1'),
      workspaceId: 'ws-1',
    }));
  });

  it('a reclaim that freed slots announces per freed workspace before the cap check', async () => {
    vi.mocked(reclaimOrphanedSpawns).mockResolvedValue({
      reclaimed: 2, spawnIds: ['s-a', 's-b'], workspaces: ['ws-1', 'ws-2'],
    });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    expect(res.ok).toBe(true);
    await flush();
    const keys = vi.mocked(emitAwaitedEvent).mock.calls.map((c) => c[0].key);
    expect(keys).toContain(spawnSlotEventKey('ws-1'));
    expect(keys).toContain(spawnSlotEventKey('ws-2'));
  });

  it('a successful under-ceiling spawn result carries NO awaitEvent', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    expect(res.ok).toBe(true);
    expect(res.awaitEvent ?? null).toBeNull();
  });
});

/**
 * Gap 13 — selectWedgeReapCandidates (operator-spawn.ts:190-202): the PURE candidate
 * filter for the wedge reaper. A local spawn is a candidate iff it is TRACKED (this
 * host holds its abort handle), NOT already mid-reap (inFlight), has OBSERVED output
 * (at > 0 — absence of signal is never a wedge), and has been stream-silent past the
 * threshold (now - at > silentMs). The four exclusion arms each get a row.
 */
describe('selectWedgeReapCandidates — pure wedge-reaper filter (Gap 13 / P-010)', () => {
  const NOW = 10_000_000_000; // fixed clock
  const silentMs = 30 * 60_000; // 30 min
  const tracked = (...ids: string[]) => new Set(ids);

  it('returns ONLY the silent-old tracked spawn, excluding in-flight / never-output / recent', () => {
    const output = new Map<string, { at: number }>([
      ['silent-old', { at: NOW - silentMs - 1 }],   // tracked, silent past threshold → REAPED
      ['silent-in-flight', { at: NOW - silentMs - 1 }], // silent-old BUT already mid-reap → excluded
      ['never-output', { at: 0 }],                   // at:0 (no observed output) → excluded
      ['recent', { at: NOW - 60_000 }],              // moved 1 min ago, not silent → excluded
    ]);
    const out = selectWedgeReapCandidates(
      output,
      tracked('silent-old', 'silent-in-flight', 'never-output', 'recent'),
      new Set(['silent-in-flight']), // inFlight
      NOW,
      silentMs,
    );
    expect(out).toEqual(['silent-old']);
  });

  it('excludes a spawn this host does NOT track even when its stream is silent-old', () => {
    const output = new Map<string, { at: number }>([['foreign', { at: NOW - silentMs - 1 }]]);
    // tracked set is empty → the host holds no abort handle → not its verdict to make.
    expect(selectWedgeReapCandidates(output, new Set(), new Set(), NOW, silentMs)).toEqual([]);
  });

  it('boundary: exactly-at-threshold is NOT silent enough (strict >), one ms past IS', () => {
    const atThreshold = new Map<string, { at: number }>([['x', { at: NOW - silentMs }]]);
    expect(selectWedgeReapCandidates(atThreshold, tracked('x'), new Set(), NOW, silentMs)).toEqual([]);
    const pastThreshold = new Map<string, { at: number }>([['x', { at: NOW - silentMs - 1 }]]);
    expect(selectWedgeReapCandidates(pastThreshold, tracked('x'), new Set(), NOW, silentMs)).toEqual(['x']);
  });

  it('defaults silentMs to WEDGE_REAP_SILENT_MS when omitted', () => {
    const output = new Map<string, { at: number }>([
      ['old', { at: NOW - WEDGE_REAP_SILENT_MS - 1 }],
      ['fresh', { at: NOW - WEDGE_REAP_SILENT_MS + 60_000 }],
    ]);
    expect(selectWedgeReapCandidates(output, tracked('old', 'fresh'), new Set(), NOW)).toEqual(['old']);
  });
});
