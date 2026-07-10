/**
 * set-auto-policy.test.ts — the improvements:set-auto-policy TOOL (live-configurability-audit P-011).
 *
 * Mocks the policy helper + control harness + flags + the (heavy) risk-policy module. Asserts:
 * get reads effective + flag · set is operator-gated · set requires a field · autoKinds replace ·
 * addProtectedPaths appends (tighten) · dryRun does not write.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/improvements/set-auto-policy.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../harness/improvements/policy', () => ({
  DEFAULT_RISK_TIER_POLICY: { autoKinds: ['bug'], protectedPathPatterns: ['a/**', 'b/**'], protectedKeywords: ['migration'] },
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));
vi.mock('../../auto-implement-policy', () => ({
  readAutoImplementPolicy: vi.fn(),
  readStoredAutoImplementPolicy: vi.fn(),
  writeAutoImplementPolicy: vi.fn(),
  setStoredAutoImplementPolicy: vi.fn(),
}));
vi.mock('../../gateway-control/control-harness', () => ({
  runControlMutation: vi.fn(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) return { dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    const next = await spec.apply();
    const verify = spec.verify ? await spec.verify(next) : undefined;
    return { dryRun: false, applied: true, prev, next, verify, auditId: 'aud-1' };
  }),
}));

import { readAutoImplementPolicy, readStoredAutoImplementPolicy, writeAutoImplementPolicy } from '../../auto-implement-policy';
const readEffM = vi.mocked(readAutoImplementPolicy);
const readStoredM = vi.mocked(readStoredAutoImplementPolicy);
const writeM = vi.mocked(writeAutoImplementPolicy);

const tool = (await import('./set-auto-policy')).default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  readEffM.mockResolvedValue({ riskTier: { autoKinds: ['bug'], protectedPathPatterns: ['a/**', 'b/**'], protectedKeywords: ['migration'] }, maxPerRun: undefined, maxAttempts: undefined });
  readStoredM.mockResolvedValue({});
  writeM.mockImplementation(async (patch: any) => ({ ...(patch.autoKinds ? { autoKinds: patch.autoKinds } : {}), ...(patch.addProtectedPaths ? { protectedPathAdditions: patch.addProtectedPaths } : {}), ...(patch.maxPerRun !== undefined ? { maxPerRun: patch.maxPerRun } : {}) }) as never);
});

describe('improvements:set-auto-policy', () => {
  it('get returns effective policy + flag state', async () => {
    const b = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(b).toMatchObject({ autoImplementFlagEnabled: false, autoKinds: ['bug'], bakedProtectedPathCount: 2, bakedProtectedKeywordCount: 1, protectedPathAdditions: [] });
  });

  it('is operator-authority gated', async () => {
    await expect(
      tool.handler({ op: 'set', autoKinds: ['bug', 'change'] } as never, { role: 'cup' } as never),
    ).rejects.toThrow(/operator, architect, or mug/i);
    expect(writeM).not.toHaveBeenCalled();
  });

  it('requires at least one field', async () => {
    await expect(tool.handler({ op: 'set' } as never, { role: 'operator' } as never)).rejects.toThrow(/at least one/i);
  });

  it('replaces autoKinds (the graduation dial)', async () => {
    const b = body(await tool.handler({ op: 'set', autoKinds: ['bug', 'change'] } as never, { role: 'operator' } as never));
    expect(writeM).toHaveBeenCalledWith({ autoKinds: ['bug', 'change'] });
    expect(b).toMatchObject({ ok: true, applied: true, verify: { ok: true } });
  });

  it('appends protected paths (tighten-only)', async () => {
    await tool.handler({ op: 'set', addProtectedPaths: ['danger/**'] } as never, { role: 'operator' } as never);
    expect(writeM).toHaveBeenCalledWith({ addProtectedPaths: ['danger/**'] });
  });

  it('dryRun does not write', async () => {
    const b = body(await tool.handler({ op: 'set', maxPerRun: 3, dryRun: true } as never, { role: 'operator' } as never));
    expect(writeM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});
