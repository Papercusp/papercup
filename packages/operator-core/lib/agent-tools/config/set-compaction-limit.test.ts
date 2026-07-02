/**
 * set-compaction-limit.test.ts — the model-aware clamp (context-trimming-tiers
 * D-001: `limit × 1.2 ≤ window − margin`, spec resolved best-effort; an
 * unresolvable spec clamps against the conservative 200k window).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/config/set-compaction-limit.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { setLimitMock, getPresenceMock, specMock } = vi.hoisted(() => ({
  // Args typed so `.mock.calls.at(-1)?.[1]` (the echo in beforeEach) typechecks.
  setLimitMock: vi.fn(async (_owner: string, _limit: number) => {}),
  getPresenceMock: vi.fn(),
  specMock: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test' }),
}));
vi.mock('../coordination/presence', () => ({
  setCompactionLimit: setLimitMock,
  getPresence: getPresenceMock,
}));
vi.mock('../../compaction-usage', () => ({
  resolveModelSpecForOwner: specMock,
}));

const tool = (await import('./set-compaction-limit')).default;
type ToolOut = { data: Record<string, unknown> };

beforeEach(() => {
  vi.clearAllMocks();
  getPresenceMock.mockImplementation(async () => ({
    compactionLimit: setLimitMock.mock.calls.at(-1)?.[1] ?? null,
  }));
});

describe('config:set-compaction-limit clamp', () => {
  it('an unresolvable spec clamps against the 200k window: 900k → 158k, flagged', async () => {
    specMock.mockResolvedValue(null);
    const out = (await tool.handler({ limit: 900_000 }, {} as never)) as ToolOut;
    expect(setLimitMock).toHaveBeenCalledWith('su-test', 158_000);
    expect(out.data.clamped).toBe(true);
    expect(out.data.requested).toBe(900_000);
    expect(out.data.cap).toBe(158_000);
    expect(out.data.compactionLimit).toBe(158_000);
  });

  it('a [1m] spec allows up to 825k; an in-range ask persists verbatim', async () => {
    specMock.mockResolvedValue('opus[1m]:high');
    const out = (await tool.handler({ limit: 300_000 }, {} as never)) as ToolOut;
    expect(setLimitMock).toHaveBeenCalledWith('su-test', 300_000);
    expect(out.data.clamped).toBeUndefined();
    expect(out.data.compactionLimit).toBe(300_000);
  });
});
