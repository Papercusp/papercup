/**
 * reset-overrides.test.ts — the config:reset-overrides TOOL (live-configurability-audit P-025).
 *
 * Mocks the control harness (separately covered) so no PG/audit; uses the real registry with
 * fake concerns. Asserts: operator/architect gate · concern|all required · unknown concern
 * throws · single-concern reset calls concern.reset() · dryRun does NOT reset · all:true resets
 * every registered concern.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/config/reset-overrides.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fake harness: exercise the spec without the real audit/PG write.
vi.mock('../../gateway-control/control-harness', () => ({
  runControlMutation: vi.fn(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) {
      return { action: spec.action, subject: spec.subject, dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    }
    const next = await spec.apply();
    const verify = spec.verify ? await spec.verify(next) : undefined;
    return { action: spec.action, subject: spec.subject, dryRun: false, applied: true, prev, next, verify, auditId: 'aud-1' };
  }),
}));

import { registerOverrideConcern, type OverrideConcern } from '../../config-overrides/registry';

const mod = await import('./reset-overrides');
const tool = mod.default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

let resetSpy: ReturnType<typeof vi.fn>;
let diffSpy: ReturnType<typeof vi.fn>;

const fakeConcern = (name: string): OverrideConcern => ({
  name,
  description: name,
  auditAction: `${name}:set`,
  diff: diffSpy as never,
  capture: vi.fn(async () => ({ snap: name })),
  reset: resetSpy as never,
  restore: vi.fn(async () => {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  resetSpy = vi.fn(async () => ({}));
  diffSpy = vi.fn(async () => []); // post-reset: no overrides remain
  registerOverrideConcern(fakeConcern('fake-concern'));
});

describe('config:reset-overrides', () => {
  it('rejects a role without operator-config write authority (e.g. bee)', async () => {
    await expect(
      tool.handler({ concern: 'fake-concern' } as never, { role: 'cup' } as never),
    ).rejects.toThrow(/operator, architect, or queen/i);
  });

  it('accepts the queen (operator-equivalent, EI-2204)', async () => {
    const b = body(await tool.handler({ concern: 'fake-concern' } as never, { role: 'mug' } as never));
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ ok: true });
  });

  it('requires concern or all', async () => {
    await expect(tool.handler({} as never, { role: 'operator' } as never)).rejects.toThrow(/concern.*or all/i);
  });

  it('throws on an unknown concern', async () => {
    await expect(
      tool.handler({ concern: 'nope' } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/unknown concern/i);
  });

  it('resets a single concern to defaults', async () => {
    const b = body(await tool.handler({ concern: 'fake-concern' } as never, { role: 'operator' } as never));
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ ok: true, reset: [{ concern: 'fake-concern', applied: true, verify: { ok: true } }] });
  });

  it('dryRun previews without resetting', async () => {
    const b = body(
      await tool.handler({ concern: 'fake-concern', dryRun: true } as never, { role: 'operator' } as never),
    );
    expect(resetSpy).not.toHaveBeenCalled();
    expect(b.reset[0]).toMatchObject({ dryRun: true, applied: false });
  });

  it('all:true resets every registered concern', async () => {
    registerOverrideConcern(fakeConcern('second-concern'));
    const b = body(await tool.handler({ all: true } as never, { role: 'operator' } as never));
    const names = b.reset.map((r: { concern: string }) => r.concern);
    expect(names).toEqual(expect.arrayContaining(['fake-concern', 'second-concern']));
    expect(resetSpy).toHaveBeenCalledTimes(names.length);
  });
});
