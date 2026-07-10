/**
 * migrate-policy.test.ts — the db:migrate-policy TOOL (live-configurability-audit P-003).
 *
 * Mocks the policy helper (thin PG) + the control harness (separately covered), so no PG.
 * Asserts: get returns the policy · set is operator/architect-gated · set requires a field ·
 * set applies the patch via writeMigratePolicy + verifies · dryRun does not write.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/db/migrate-policy.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../migrate-policy', () => ({
  readMigratePolicy: vi.fn(),
  writeMigratePolicy: vi.fn(),
  MIGRATE_POLICY_DEFAULTS: { lockTimeoutMs: 15000, statementTimeoutMs: null },
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

import { readMigratePolicy, writeMigratePolicy } from '../../migrate-policy';
const readM = vi.mocked(readMigratePolicy);
const writeM = vi.mocked(writeMigratePolicy);

const mod = await import('./migrate-policy');
const tool = mod.default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  readM.mockResolvedValue({ lockTimeoutMs: 15000, statementTimeoutMs: null } as never);
  writeM.mockResolvedValue({ lockTimeoutMs: 30000, statementTimeoutMs: null } as never);
});

describe('db:migrate-policy', () => {
  it('get returns the effective policy', async () => {
    const b = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(b).toEqual({ policy: { lockTimeoutMs: 15000, statementTimeoutMs: null } });
  });

  it('set rejects a role without operator-config write authority (e.g. bee)', async () => {
    await expect(
      tool.handler({ op: 'set', lockTimeoutMs: 30000 } as never, { role: 'cup' } as never),
    ).rejects.toThrow(/operator, architect, or mug/i);
    expect(writeM).not.toHaveBeenCalled();
  });

  it('set accepts the queen (operator-equivalent, EI-2204)', async () => {
    const b = body(await tool.handler({ op: 'set', lockTimeoutMs: 30000 } as never, { role: 'mug' } as never));
    expect(writeM).toHaveBeenCalledWith({ lockTimeoutMs: 30000 });
    expect(b).toMatchObject({ ok: true, applied: true });
  });

  it('set requires at least one field', async () => {
    await expect(
      tool.handler({ op: 'set' } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/requires lockTimeoutMs/i);
  });

  it('set applies the patch and verifies', async () => {
    const b = body(await tool.handler({ op: 'set', lockTimeoutMs: 30000 } as never, { role: 'operator' } as never));
    expect(writeM).toHaveBeenCalledWith({ lockTimeoutMs: 30000 });
    expect(b).toMatchObject({ ok: true, applied: true, verify: { ok: true }, next: { lockTimeoutMs: 30000 } });
  });

  it('dryRun does not write', async () => {
    const b = body(
      await tool.handler({ op: 'set', lockTimeoutMs: 30000, dryRun: true } as never, { role: 'operator' } as never),
    );
    expect(writeM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});
