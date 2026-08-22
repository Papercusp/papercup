/**
 * set-compaction-limit.test.ts — the model-aware clamp (context-trimming-tiers
 * D-001: `limit × 1.2 ≤ window − margin`, spec resolved best-effort; an
 * unresolvable spec clamps to the [1m] ceiling, NOT the conservative 200k → 158k
 * (WI-3383, owner directive 2026-07-08).
 *
 * Since 2026-08-08 this verb is the DELIBERATE SELF-SET path, so its ceiling is
 * `selfSetCeilingForSpec` (825k on [1m]) rather than the SEEDED default
 * (`COMPACTION_LIMIT_DEFAULT_1M_CAP`, 400k) — the two were one constant until then,
 * so "raise it for wide-context work" (this verb's stated purpose) silently clamped
 * back to 400k on the fleet's default spec. Seeding is unchanged at 400k.
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

/**
 * The self-set ceiling on a `[1m]` window: `floor((1M − 10k) / 1.2)`. Pinned as a
 * LITERAL rather than derived from `selfSetCeilingForSpec`, so these assertions can
 * actually fail if the helper regresses (mirrors `agent-config-constants.test.ts`).
 */
const SELF_SET_1M_CEILING = 825_000;

beforeEach(() => {
  vi.clearAllMocks();
  getPresenceMock.mockImplementation(async () => ({
    compactionLimit: setLimitMock.mock.calls.at(-1)?.[1] ?? null,
  }));
});

describe('config:set-compaction-limit runtime validation', () => {
  it('an unresolvable spec rejects a request above the 825k [1m] self-set ceiling, without writing a clamp (WI-3383)', async () => {
    specMock.mockResolvedValue(null);
    const out = (await tool.handler({ limit: 900_000 }, {} as never)) as ToolOut;
    // Still the WI-3383 property: an unknown spec is an opus[1m] session, so the
    // reported ceiling must NOT fall back to the haiku-sized 158k. The runtime
    // setter rejects instead of storing a different value under ok:true.
    expect(setLimitMock).not.toHaveBeenCalled();
    expect(out.data.ok).toBe(false);
    expect(out.data.error).toBe('limit_exceeds_cap');
    expect(out.data.requested).toBe(900_000);
    expect(out.data.cap).toBe(SELF_SET_1M_CEILING);
    expect(out.data.compactionLimit).toBeUndefined();
  });

  it('a [1m] spec allows an ask ABOVE the 400k seeded default: 700k persists verbatim', async () => {
    specMock.mockResolvedValue('opus[1m]:high');
    // 700k is the regression this verb's 2026-08-08 fix targets: above the seeded
    // 400k default, inside the 825k window ceiling. Asking below 400k would pass
    // under the OLD clamp too, so it could not detect the defect at all.
    const out = (await tool.handler({ limit: 700_000 }, {} as never)) as ToolOut;
    expect(setLimitMock).toHaveBeenCalledWith('su-test', 700_000, { explicit: true });
    expect(out.data.ok).toBe(true);
    expect(out.data.clamped).toBeUndefined();
    expect(out.data.compactionLimit).toBe(700_000);
  });
});
