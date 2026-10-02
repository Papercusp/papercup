/**
 * Handler regressions for EI-21526112676676081.
 *
 * `fleet:assignments` is a supervisory read. A wedged roster query must return
 * an explicitly degraded response before the MCP deadline, and independent
 * enrichment reads must start together rather than serially consuming that
 * deadline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAssignments: vi.fn(),
  coverage: vi.fn(),
  wakeability: vi.fn(),
  recordedLive: vi.fn(),
  selfWake: vi.fn(),
  recordedEnded: vi.fn(),
  parkedOn: vi.fn(),
  contextPressure: vi.fn(),
  unanswered: vi.fn(),
  loopStatuses: vi.fn(),
  lastToolCalls: vi.fn(),
  wakeModeOverrides: vi.fn(),
  defaultWakeMode: vi.fn(),
}));

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (definition: unknown) => definition,
  readJsonResult: () => undefined,
}));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({
    ownerId: 'su-test',
    ownerLabel: 'test',
    source: 'static-client',
    workspaceId: 'papercusp-workspace',
    userId: null,
  }),
}));
vi.mock('../coordination/self-marker', () => ({
  resolveSelfRef: () => null,
  markSelfRows: (rows: unknown[]) => rows,
}));
vi.mock('../coordination/presence-wakeability', () => ({
  fetchWakeability: mocks.wakeability,
}));
vi.mock('../coordination/presence-selfwake', () => ({
  fetchSelfWake: mocks.selfWake,
  isStrandedMember: vi.fn(() => false),
}));
vi.mock('../../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../adv-sessions')>()),
  recordedLiveOwnerIds: mocks.recordedLive,
  endedRecordedOwnerIds: mocks.recordedEnded,
}));
vi.mock('../coordination/wake-mode', () => ({
  getWakeModeOverridesFor: mocks.wakeModeOverrides,
  getDefaultWakeMode: mocks.defaultWakeMode,
  resolveWakeModeFrom: vi.fn(() => 'auto'),
}));
vi.mock('../../plan-item-coverage', () => ({
  getAllPlanItemCoverage: mocks.coverage,
  compactCoverage: vi.fn((coverage: unknown) => coverage),
  coverageCollisions: vi.fn(() => []),
  duplicateCoverage: vi.fn(() => []),
}));
vi.mock('../../events/await/store', () => ({
  listParkedAwaitsForSubscribers: mocks.parkedOn,
}));
vi.mock('../coordination/context-pressure', () => ({
  fetchContextPressureReadings: mocks.contextPressure,
}));
vi.mock('../coordination/unanswered-directed', () => ({
  fetchUnansweredDirected: mocks.unanswered,
}));
vi.mock('../coordination/inbox-read-freshness', () => ({
  classifyCoordDeafness: vi.fn(() => null),
  coordDeafBudgetMs: vi.fn(() => 900_000),
  lastInboxReadAtBatch: vi.fn(async () => new Map()),
}));
vi.mock('../../harness/routines/loop', () => ({
  getLoopStatuses: mocks.loopStatuses,
}));
vi.mock('../plans/source', () => ({
  getPlanRow: vi.fn(async () => null),
  planItemsForRow: vi.fn(() => []),
  planSlugsForHarness: vi.fn(async () => new Set<string>()),
}));
vi.mock('../../fleet/assignments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fleet/assignments')>()),
  listFleetAssignments: mocks.listAssignments,
  lastToolCallAtByOwner: mocks.lastToolCalls,
  lastProductiveToolCallAtByOwner: vi.fn(async () => new Map()),
  resolveTerminalPlanItemResidue: vi.fn(async () => new Map()),
}));

import fleetAssignmentsTool, { FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS } from './assignments';

const ctx = { workspaceId: 'papercusp-workspace' } as unknown as Parameters<
  typeof fleetAssignmentsTool.handler
>[1];

function liveRow() {
  const now = new Date().toISOString();
  return {
    source: 'work_item_claim',
    workspaceId: 'papercusp-workspace',
    agentId: 'su-worker',
    agentLabel: null,
    agentName: null,
    harnessSlug: 'papercusp',
    planSlug: null,
    itemId: null,
    workItemId: 'WI-1',
    itemKind: 'bug',
    detail: 'bounded read fixture',
    status: 'wip',
    claimAcquiredTs: now,
    claimExpiresTs: null,
    claimActive: true,
    livenessMode: null,
    lastActivityTs: now,
    holderPresent: true,
    holderAlive: true,
    holderHeartbeatAt: now,
    holderIntent: null,
    holderPlanSlug: null,
    orphaned: false,
    declaredPlanMatches: null,
    assigneeRank: null,
    rankWriter: null,
    fleetSlug: 'test-fleet',
    fleetRole: 'member',
    stalled: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAssignments.mockResolvedValue([]);
  mocks.coverage.mockResolvedValue(new Map());
  mocks.wakeability.mockResolvedValue(new Map());
  mocks.recordedLive.mockResolvedValue(new Set());
  mocks.selfWake.mockResolvedValue(new Map());
  mocks.recordedEnded.mockResolvedValue(new Set());
  mocks.parkedOn.mockResolvedValue([]);
  mocks.contextPressure.mockResolvedValue(new Map());
  mocks.unanswered.mockResolvedValue(new Map());
  mocks.loopStatuses.mockResolvedValue(new Map());
  mocks.lastToolCalls.mockResolvedValue(new Map());
  mocks.wakeModeOverrides.mockResolvedValue(new Map());
  mocks.defaultWakeMode.mockResolvedValue('auto');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fleet:assignments bounded handler reads', () => {
  it('returns an explicitly degraded fallback when the assignment query never settles', async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(' '));
    });
    mocks.listAssignments.mockImplementation(() => new Promise<never>(() => {}));

    const pending = fleetAssignmentsTool.handler({} as never, ctx) as Promise<{
      data: {
        degraded?: boolean;
        degradedLegs?: string[];
        summary: { agents: number };
      };
    }>;

    // Coverage starts before the hung assignment leg reaches its deadline.
    await Promise.resolve();
    expect(mocks.coverage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS);
    const result = await pending;

    expect(result.data).toMatchObject({
      degraded: true,
      degradedLegs: ['assignments'],
      summary: { agents: 0 },
    });
    expect(warnings.join('\n')).toContain(
      `fleet:assignments:assignments exceeded ${FLEET_ASSIGNMENTS_SUBREAD_TIMEOUT_MS}ms`,
    );
  });

  it('starts independent row enrichments together before any one of them settles', async () => {
    mocks.listAssignments.mockResolvedValue([liveRow()]);
    const wakeability = deferred<Map<string, never>>();
    const parkedOn = deferred<Array<{ subscriberId: string; eventKey: string }>>();
    const contextPressure = deferred<Map<string, never>>();
    const unanswered = deferred<Map<string, never>>();
    mocks.wakeability.mockReturnValue(wakeability.promise);
    mocks.parkedOn.mockReturnValue(parkedOn.promise);
    mocks.contextPressure.mockReturnValue(contextPressure.promise);
    mocks.unanswered.mockReturnValue(unanswered.promise);

    const pending = fleetAssignmentsTool.handler({ harness: 'papercusp' } as never, ctx);
    await vi.waitFor(() => {
      expect(mocks.wakeability).toHaveBeenCalledTimes(1);
      expect(mocks.parkedOn).toHaveBeenCalledTimes(1);
      expect(mocks.contextPressure).toHaveBeenCalledTimes(1);
      expect(mocks.unanswered).toHaveBeenCalledTimes(1);
    });

    wakeability.resolve(new Map<string, never>());
    parkedOn.resolve([]);
    contextPressure.resolve(new Map<string, never>());
    unanswered.resolve(new Map<string, never>());

    const result = (await pending) as { data: { degraded?: boolean; summary: { agents: number } } };
    expect(result.data.summary.agents).toBe(1);
    expect(result.data.degraded).toBeUndefined();
  });
});
