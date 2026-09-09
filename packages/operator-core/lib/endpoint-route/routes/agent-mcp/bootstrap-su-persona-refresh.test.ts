/**
 * Unit tests for POST /api/agent-mcp/console/bootstrap-su/persona-refresh
 * (stale-prompt-render-in-live-sessions-2026-08-02 P-002).
 *
 * The route re-renders a live su session's base persona so a carry-respawn can
 * boot the successor on CURRENT prompt sources instead of inheriting the
 * predecessor's already-rendered file. Two contracts are pinned here, and they
 * pull in opposite directions, which is why both need tests:
 *
 *  - it must actually REPLAY the launch's overlays (a refresh that silently
 *    dropped the AUTO directive would trade staleness for a worse bug), and
 *  - it must FAIL SOFT on absolutely everything (a refresh that 500s or throws
 *    would cost the session its respawn, which is far worse than a stale prompt).
 *
 * Mirrors bootstrap-su-session-respawned.test.ts's minimal mock set + beforeAll
 * import (EI-9784: pay bootstrap-su's heavy first import exactly once).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.setConfig({ testTimeout: 15_000 });

const readLaunchSpecMock = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
const requestSessionIdentityActivationMock = vi.hoisted(() =>
  vi.fn(async (_input: unknown) => ({ generation: 1 })),
);
const buildLaunchSpecMock = vi.hoisted(() =>
  vi.fn(async () => ({
    kind: 'su',
    role: 'su',
    runId: 'r',
    spawnId: 's',
    harnessSlug: 'papercusp',
    featureId: null,
    cwd: '/tmp',
    promptText: '# FRESHLY RENDERED PLAYBOOK\n',
    promptFile: '/prompts/papercusp-su-engineer.tools.md',
    mcpUrl: 'http://localhost:3070/api/mcp?superuser=1',
    mcpJsonContents: '{}',
    personaTier: 'full' as const,
  })),
);
const compileLaunchSpecificationArtifactMock = vi.hoisted(() =>
  vi.fn(async (input: any) => ({
    promptText: input.promptText,
    stack: input.stack ?? [],
    specificationArtifact: {},
    specificationRevision: 'a'.repeat(64),
    stateRevision: input.stateRevision ?? 'b'.repeat(64),
    compositionSource: 'compatibility' as const,
  })),
);

vi.mock('../../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => {}),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    status = 401;
    reason = 'denied';
  },
}));
vi.mock('../../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../../adv-sessions')>()),
  endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  recordAdvSession: vi.fn(async () => 1),
  recordSuLaunchSpec: vi.fn(async () => true),
  readSuLaunchSpecByOwner: readLaunchSpecMock,
  markAdvSessionEnded: vi.fn(async () => {}),
  claimAdvSessionResume: vi.fn(async () => false),
  reanchorAdvSessionNativeId: vi.fn(async () => ({ reanchored: true, owner: null })),
  reanchorAdvSessionNativeIdByOwner: vi.fn(async () => ({ reanchored: true, owner: null })),
}));
vi.mock('../../../role-launch-spec', () => ({
  buildLaunchSpec: buildLaunchSpecMock,
  compileLaunchSpecificationArtifact: compileLaunchSpecificationArtifactMock,
}));
vi.mock('../../../agent-tools/coordination/control-anchor', () => ({
  requestSessionIdentityActivation: (input: unknown) => requestSessionIdentityActivationMock(input),
}));
vi.mock('../../../agent-tools/coordination/presence', () => ({
  touchHeartbeat: vi.fn(async () => {}),
}));

let routes: { method: string; path: string; handler: (req: Request) => Promise<Response> }[];
let dir = '';
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'persona-refresh-'));
  process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = dir;
  const mod = await import('./bootstrap-su-persona-refresh');
  routes = mod.default as unknown as typeof routes;
}, 30_000);

const OWNER = 'su-0228816f-1d81-45fd-8832-71c771fecc99';

/** A stored launch spec for a plain, non-auto, harness-scoped claude session. */
function spec(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    agent: 'claude',
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    profile: 'engineer',
    contextSize: null,
    personaTier: 'full',
    model: null,
    planSlug: null,
    launchedBy: null,
    autoMode: false,
    drainMode: false,
    loopArmed: false,
    fleet: null,
    ...over,
  };
}

async function refresh(body: unknown): Promise<Response> {
  const route = routes.find((r) => r.method === 'POST')!;
  return route.handler(
    new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-su/persona-refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  readLaunchSpecMock.mockResolvedValue(null);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('POST bootstrap-su/persona-refresh — the happy path', () => {
  it('re-renders and writes a NEW file, never the inherited launch render', async () => {
    readLaunchSpecMock.mockResolvedValue(spec());
    const res = await refresh({ coordOwnerId: OWNER });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; promptFile: string; specificationRevision: string; stateRevision: string };
    expect(j.ok).toBe(true);
    // The caller's fallback is the file it already has, so the refresh must land
    // somewhere else — see suPersonaRefreshPathFor.
    expect(j.promptFile).toBe(join(dir, `session-refresh-${OWNER}.md`));
    expect(existsSync(j.promptFile)).toBe(true);
    expect(readFileSync(j.promptFile, 'utf8')).toContain('# FRESHLY RENDERED PLAYBOOK');
    expect(j.specificationRevision).toBe('a'.repeat(64));
    expect(j.stateRevision).toHaveLength(24);
    // Rendered from CURRENT sources, which is the entire point.
    expect(buildLaunchSpecMock).toHaveBeenCalledTimes(1);
    expect(requestSessionIdentityActivationMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: OWNER, source: 'restart', restart: true }),
    );
  });

  it('replays the launch overlays — an AUTO session gets its AUTO directive back', async () => {
    // The failure this guards is subtle and worse than the bug being fixed: a
    // refresh that rendered only the base playbook would silently strip a fleet
    // member's AUTO activation, and the session would quietly stop looping.
    readLaunchSpecMock.mockResolvedValue(spec({ autoMode: true, launchedBy: 'su-leader-9' }));
    const res = await refresh({ coordOwnerId: OWNER });
    const j = (await res.json()) as { ok: boolean; promptFile: string };
    const text = readFileSync(j.promptFile, 'utf8');
    expect(text).toContain('## AUTO mode');
    expect(text).toContain('## Provenance — who launched this session');
    expect(text).toContain('su-leader-9');
    expect(text).toContain('## Effective instruction precedence');
  });

  it('passes the STORED resolved inputs to buildLaunchSpec rather than re-deriving them', async () => {
    readLaunchSpecMock.mockResolvedValue(
      spec({ profile: 'power', personaTier: 'fleet', model: 'anthropic/x', harnessSlug: null }),
    );
    await refresh({ coordOwnerId: OWNER });
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'su',
        agent: 'claude',
        workspaceId: 'papercusp-workspace',
        profile: 'power',
        personaTier: 'fleet',
        model: 'anthropic/x',
        harnessSlug: null,
      }),
    );
  });

  it('rebuilds the full render with explicit stack plus live mode/fleet identity layers', async () => {
    readLaunchSpecMock.mockResolvedValue(spec({
      autoMode: true,
      stack: ['practice:citations'],
      fleet: { slug: 'alpha', role: 'leader' },
    }));
    await refresh({ coordOwnerId: OWNER });
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({
      stack: ['practice:citations'],
      fleetRole: 'leader',
      modes: ['auto'],
    }));
  });

  it('overwrites its own previous refresh instead of accumulating one file per respawn', async () => {
    // A long-lived session respawns many times; a per-respawn unique filename would
    // grow the launch-context dir without bound for the life of the box.
    readLaunchSpecMock.mockResolvedValue(spec());
    const a = (await (await refresh({ coordOwnerId: OWNER })).json()) as { promptFile: string };
    const base = await buildLaunchSpecMock();
    buildLaunchSpecMock.mockResolvedValueOnce({ ...base, promptText: '# SECOND RENDER\n' });
    const b = (await (await refresh({ coordOwnerId: OWNER })).json()) as { promptFile: string };
    expect(b.promptFile).toBe(a.promptFile);
    expect(readFileSync(b.promptFile, 'utf8')).toContain('# SECOND RENDER');
  });
});

describe('POST bootstrap-su/persona-refresh — fail-soft is the contract', () => {
  // Every case below must answer 200 { ok:false, reason } rather than an error
  // status, because the caller's correct behaviour is identical in all of them:
  // keep the inherited render and respawn anyway. A respawn that died because the
  // operator hiccuped would lose the whole session.
  it('reports no-launch-spec for a session launched before the spec was recorded', async () => {
    readLaunchSpecMock.mockResolvedValue(null);
    const res = await refresh({ coordOwnerId: OWNER });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'no-launch-spec' });
    expect(buildLaunchSpecMock).not.toHaveBeenCalled();
  });

  it('reports no-launch-spec for a record shape it does not recognise', async () => {
    readLaunchSpecMock.mockResolvedValue(spec({ v: 99 }));
    expect(await (await refresh({ coordOwnerId: OWNER })).json()).toMatchObject({
      ok: false,
      reason: 'no-launch-spec',
    });
  });

  it('refuses a non-claude backend, which has no --system-prompt-file to swap', async () => {
    for (const agent of ['codex', 'omp']) {
      readLaunchSpecMock.mockResolvedValue(spec({ agent }));
      const res = await refresh({ coordOwnerId: OWNER });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: false, reason: 'unsupported-agent', agent });
    }
    expect(buildLaunchSpecMock).not.toHaveBeenCalled();
  });

  it('answers 200 { ok:false } — NOT a 5xx — when the render itself throws', async () => {
    readLaunchSpecMock.mockResolvedValue(spec());
    buildLaunchSpecMock.mockRejectedValueOnce(new Error('harness "papercusp" is not registered'));
    const res = await refresh({ coordOwnerId: OWNER });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; reason: string; error: string };
    expect(j.ok).toBe(false);
    expect(j.reason).toBe('render-failed');
    // The reason must be diagnosable — a silent failure here is indistinguishable
    // from the staleness bug it was written to fix.
    expect(j.error).toContain('not registered');
  });

  it('answers 200 { ok:false } when the store is unreachable', async () => {
    readLaunchSpecMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await refresh({ coordOwnerId: OWNER });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'render-failed' });
  });

  it('400s only on a malformed request — the one case that is a caller bug', async () => {
    expect((await refresh({})).status).toBe(400);
    expect((await refresh({ coordOwnerId: '   ' })).status).toBe(400);
  });

  it('writes NOTHING on any failure path', async () => {
    const owner = 'su-never-written';
    readLaunchSpecMock.mockResolvedValue(null);
    await refresh({ coordOwnerId: owner });
    expect(existsSync(join(dir, `session-refresh-${owner}.md`))).toBe(false);
  });
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
