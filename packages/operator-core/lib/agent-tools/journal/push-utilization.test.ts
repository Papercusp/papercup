/**
 * journal:push-utilization tool — PG-free unit. The io module and store have
 * their own suites; this pins the TOOL: identity resolved, the hour/minute arg
 * units converted to the io module's ms/Date shapes, the defaults (7-day
 * window, 60-min grace left to the io default), and the JSON envelope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pushUtilizationTool from './push-utilization';
import { runUtilizationReport } from '../../push-utilization-io';
import { resolveAgentIdentity } from '../coordination/identity';

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../push-utilization-io', () => ({ runUtilizationReport: vi.fn() }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn() }));

const mockRun = vi.mocked(runUtilizationReport);
const mockIdentity = vi.mocked(resolveAgentIdentity);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    pushUtilizationTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

const RESULT = {
  report: { matchers: [], recommendations: [], totals: {}, advisoryOnly: true },
  counts: { rows: 0, ledgerEntries: 0, queued: 0, pendingObservation: 0 },
  window: { targetOwnerId: null, since: null, limit: 500, observationGraceMs: 3_600_000 },
} as unknown as Awaited<ReturnType<typeof runUtilizationReport>>;

describe('journal:push-utilization tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
    mockIdentity.mockReturnValue({ ownerId: 'su-test' } as ReturnType<typeof resolveAgentIdentity>);
    mockRun.mockResolvedValue(RESULT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults: 7-day enqueue window, io-default grace, whole-fleet cut', async () => {
    const res = await callTool({});
    expect(mockIdentity).toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalledWith({
      targetOwnerId: undefined,
      since: new Date(Date.now() - 168 * 60 * 60 * 1000),
      limit: undefined,
      observationGraceMs: undefined,
    });
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ report: { advisoryOnly: true } });
  });

  it('converts sinceHours/graceMinutes to the io shapes and forwards the cut', async () => {
    await callTool({ ownerId: 'su-recv', sinceHours: 24, limit: 100, graceMinutes: 30 });
    expect(mockRun).toHaveBeenCalledWith({
      targetOwnerId: 'su-recv',
      since: new Date(Date.now() - 24 * 60 * 60 * 1000),
      limit: 100,
      observationGraceMs: 30 * 60 * 1000,
    });
  });
});
