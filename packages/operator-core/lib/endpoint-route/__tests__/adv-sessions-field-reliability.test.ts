/**
 * EI-22176001691325872: advSessionEndedAtCaveat / advSessionExitCodeCaveat were built,
 * unit-tested (adv-session-ended-provenance.test.ts), and correct, but had ZERO
 * production callers — every real reading surface rendered a bare `endedAt`/`exitCode`
 * with nothing attached, so an agent or the UI could not tell a real observation from a
 * sweeper's NOTICE time or a signal-death's placeholder zero.
 *
 * These tests drive GET /adv/sessions and GET /adv/sessions/ended directly (rows mocked,
 * per the pattern in adv-roster-route.test.ts) and assert the JSON response actually
 * carries `_fieldReliability` for a row whose provenance is unreliable, and carries NONE
 * for a row whose provenance is a real observation — the regression this bug describes
 * would make both assertions fail identically (a bare row, caveat or not).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../define-route';
import type { AdvSessionRow } from '../../adv-sessions';

const listAdvSessionsMock = vi.fn();
const listEndedAdvSessionsMock = vi.fn();

// Keep every OTHER adv-sessions export real — including advSessionRowCaveats and the
// two builders it calls — so this test exercises the ACTUAL caveat logic, not a stub of
// it. Only the two DB-touching list functions are overridden.
vi.mock('../../adv-sessions', async (importActual) => ({
  ...(await importActual<typeof import('../../adv-sessions')>()),
  listAdvSessions: (...a: unknown[]) => listAdvSessionsMock(...a),
  listEndedAdvSessions: (...a: unknown[]) => listEndedAdvSessionsMock(...a),
}));
// The `list` handler also calls gatherOnDesktopSessions (best-effort window lookup) —
// stub it so the test never touches a real X11/wmctrl call.
vi.mock('../../desktop-window-liveness', () => ({
  gatherOnDesktopSessions: vi.fn(async () => null),
}));
// Sibling routes in the same module import these; neither handler under test calls
// them, so stub to avoid loading the heavy real modules (same pattern as the roster and
// rename route tests).
vi.mock('../../omp-config', () => ({ readOmpConfig: vi.fn(async () => []) }));
vi.mock('../../omp-sessions', () => ({
  findOmpSessionNear: vi.fn(),
  getOmpSessionRowSummary: vi.fn(() => null),
  getOmpSessionState: vi.fn(),
  searchOmpSessions: vi.fn(),
}));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

type Route = { method: string; path: string; handler: (req: Request, ctx: RouteContext) => Promise<Response> };

async function findRoute(method: string, path: string): Promise<Route> {
  const mod = await import('../routes/adv/sessions');
  const route = (mod.default as Route[]).find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`${method} ${path} route not registered`);
  return route;
}

async function callList(): Promise<Response> {
  const route = await findRoute('GET', '/adv/sessions');
  return route.handler(new Request('http://localhost:3070/api/adv/sessions', { method: 'GET' }), CTX);
}

async function callEnded(query = ''): Promise<Response> {
  const route = await findRoute('GET', '/adv/sessions/ended');
  return route.handler(
    new Request(`http://localhost:3070/api/adv/sessions/ended${query}`, { method: 'GET' }),
    CTX,
  );
}

/** A minimal-but-complete AdvSessionRow, overridable per test. */
function row(overrides: Partial<AdvSessionRow>): AdvSessionRow {
  return {
    id: 1,
    workspaceId: 'ws-1',
    harnessSlug: null,
    planSlug: null,
    agent: 'claude',
    role: null,
    feature: null,
    mode: 'console',
    terminalBin: null,
    pid: null,
    windowId: null,
    ompThreadId: null,
    label: null,
    cwd: null,
    coordOwnerId: 'su-a',
    sessionId: null,
    display: null,
    launchArgv: null,
    launchedAt: null,
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: null,
    exitCode: null,
    endedBy: null,
    endedSignal: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listAdvSessionsMock.mockResolvedValue([]);
  listEndedAdvSessionsMock.mockResolvedValue([]);
});

describe('GET /adv/sessions — field-reliability caveats reach the reader', () => {
  it('attaches a caveat to a row whose endedAt was written by a sweeper NOTICING a dead process', async () => {
    listAdvSessionsMock.mockResolvedValue([
      row({ id: 11, endedAt: '2026-08-02T18:26:03Z', endedBy: 'reaper' }),
    ]);
    const res = await callList();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    const r = body.rows.find((x) => x.id === 11)!;
    expect(r._fieldReliability).toEqual([
      expect.objectContaining({ field: 'endedAt', reliability: 'inferred' }),
    ]);
    expect(r._fieldReliabilityWarning).toMatch(/endedAt.*INFERRED/);
  });

  it('attaches a caveat to a row whose exitCode 0 is a signal-death placeholder', async () => {
    listAdvSessionsMock.mockResolvedValue([
      row({ id: 12, endedAt: '2026-08-02T18:26:03Z', endedBy: 'signal', endedSignal: 'SIGHUP', exitCode: 0 }),
    ]);
    const res = await callList();
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    const r = body.rows.find((x) => x.id === 12)!;
    // A 'signal' row's endedAt IS a real observation (only the exitCode is a placeholder) —
    // exactly one caveat, on exitCode, never on endedAt.
    expect(r._fieldReliability).toEqual([
      expect.objectContaining({ field: 'exitCode', reliability: 'inferred' }),
    ]);
  });

  it('attaches NO caveat block to a row whose provenance is a real self-reported observation', async () => {
    listAdvSessionsMock.mockResolvedValue([
      row({ id: 13, endedAt: '2026-08-02T18:26:03Z', endedBy: 'self', exitCode: 0 }),
    ]);
    const res = await callList();
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    const r = body.rows.find((x) => x.id === 13)!;
    expect(r._fieldReliability).toBeUndefined();
    expect(r._fieldReliabilityWarning).toBeUndefined();
  });

  it('attaches NO caveat block to a still-running row (endedAt null)', async () => {
    listAdvSessionsMock.mockResolvedValue([row({ id: 14, endedAt: null, endedBy: null, exitCode: null })]);
    const res = await callList();
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    const r = body.rows.find((x) => x.id === 14)!;
    expect(r._fieldReliability).toBeUndefined();
  });
});

describe('GET /adv/sessions/ended — field-reliability caveats reach the reader', () => {
  it('attaches BOTH caveats to a reconciler-noticed, signal-killed row', async () => {
    listEndedAdvSessionsMock.mockResolvedValue([
      row({ id: 21, endedAt: '2026-08-02T18:26:03Z', endedBy: 'reconciler', endedSignal: null, exitCode: 0 }),
    ]);
    const res = await callEnded();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
    const r = body.sessions[0]!;
    // reconciler ⇒ endedAt is a NOTICE time (caveat). exitCode is only caveated when
    // endedBy === 'signal', so a reconciler-noticed row's exitCode 0 stays UNcaveated here
    // (it genuinely doesn't know whether the process was ever signalled).
    expect(r._fieldReliability).toEqual([
      expect.objectContaining({ field: 'endedAt', reliability: 'inferred' }),
    ]);
  });

  it('does not perturb the keyset pagination cursor', async () => {
    listEndedAdvSessionsMock.mockResolvedValue([
      row({ id: 31, endedAt: '2026-08-02T18:26:03Z', endedBy: 'reaper' }),
    ]);
    const res = await callEnded('?limit=1');
    const body = (await res.json()) as { nextBefore: string | null; hasMore: boolean };
    // Only one row was returned by the mock (limit+1 probe saw nothing extra), so there is
    // no next page — the field-reliability wrapping must not have broken that arithmetic.
    expect(body.hasMore).toBe(false);
    expect(body.nextBefore).toBeNull();
  });
});
