/**
 * tiers-set.test.ts — config:tiers-set / config:tiers-get (context-trimming-tiers P-005).
 *
 * Mocks the stored agent config; validation is the REAL parseTiers (that's the
 * contract: the tool persists exactly what the store would accept). Asserts:
 * replace-wholesale · invalid rows dropped + reported · compactionLimit clamped
 * to the spec ceiling · [] clears to defaults · get annotates effective limits.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/config/tiers-set.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readMock, writeMock } = vi.hoisted(() => ({
  readMock: vi.fn(),
  writeMock: vi.fn(),
}));
vi.mock('../../agent-config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../agent-config')>();
  return { ...real, readAgentConfig: readMock, writeAgentConfig: writeMock };
});

const setTool = (await import('./tiers-set')).default;
const getTool = (await import('./tiers-get')).default;
type ToolOut = { data: Record<string, never> & { tiers: Array<Record<string, unknown>>; [k: string]: unknown } };

beforeEach(() => {
  vi.clearAllMocks();
  readMock.mockResolvedValue({ backend: 'auto', cmd: '', models: {}, tiers: [], tierCeilings: {} });
  writeMock.mockImplementation(async (cfg: { tiers: unknown[] }) => cfg);
});

describe('config:tiers-set', () => {
  it('persists a valid menu with clamped compaction limits; drops invalid rows loudly', async () => {
    const out = (await setTool.handler(
      {
        tiers: [
          // BARE sonnet really runs a 200k auto-compact window (no [1m] marker,
          // live-verified 2026-07-02) → its limit clamps to the 158k derived
          // ceiling, NOT the [1m] 500k cap.
          { name: 'lean', spec: 'sonnet', compactionLimit: 900_000 },
          { name: 'wide', spec: 'opus[1m]:high' }, // derived 400k ([1m] cap, owner directive 2026-07-03)
          { name: 'lean', spec: 'haiku' }, // duplicate name — dropped
        ],
      },
      {} as never,
    )) as ToolOut;
    expect(writeMock).toHaveBeenCalledTimes(1);
    const persisted = writeMock.mock.calls[0][0].tiers;
    expect(persisted).toEqual([
      { name: 'lean', spec: 'sonnet', compactionLimit: 158_000 },
      { name: 'wide', spec: 'opus[1m]:high' },
    ]);
    expect(out.data.droppedInvalid).toBe(1);
    expect(out.data.tiers[1].effectiveCompactionLimit).toBe(400_000);
    expect(out.data.tiers[1].modelWindow).toBe(1_000_000);
  });

  it('tiers: [] clears back to the committed defaults', async () => {
    const out = (await setTool.handler({ tiers: [] }, {} as never)) as ToolOut;
    expect(writeMock.mock.calls[0][0].tiers).toEqual([]);
    expect(out.data.stored).toBe(false);
  });
});

describe('config:tiers-get', () => {
  it('falls back to DEFAULT_MODEL_TIERS and annotates each tier with its effective limit', async () => {
    const out = (await getTool.handler({}, {} as never)) as ToolOut;
    expect(out.data.stored).toBe(false);
    const std = out.data.tiers.find((t) => t.name === 'standard')!;
    expect(std.effectiveCompactionLimit).toBe(400_000); // sonnet alias → sonnet-5 → 400k cap
    expect(std.compactionLimitSource).toBe('model-default');
  });

  it('reports an explicit per-tier limit as explicit', async () => {
    readMock.mockResolvedValue({
      backend: 'auto', cmd: '', models: {},
      tiers: [{ name: 'lean', spec: 'sonnet', compactionLimit: 90_000 }],
      tierCeilings: {},
    });
    const out = (await getTool.handler({}, {} as never)) as ToolOut;
    expect(out.data.stored).toBe(true);
    expect(out.data.tiers[0].effectiveCompactionLimit).toBe(90_000);
    expect(out.data.tiers[0].compactionLimitSource).toBe('explicit');
  });
});
