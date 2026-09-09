import { describe, expect, it, vi } from 'vitest';
import { createBlenderAdmission, sumBlenderTicks } from '../../../../scratchpad/dream-study-2026-09-09/blender-guard.mts';
import { requireStudyRoom, STUDY_BLOCKS } from '../../../../scratchpad/dream-study-2026-09-09/accounting.mts';

const model = 'gpt-5.6-luna:medium';
const opts = { model, messages: [{ role: 'user' as const, content: 'test' }], maxTokens: 1024 };
const usage = { text: 'ok', costUsd: 0.0001, inputTokens: 10, outputTokens: 10, raw: null };

describe('ordinary Blender admission into the finite Dream study', () => {
  it.each([0, -1, NaN, Infinity])('refuses invalid cycle cap %s', cap => {
    expect(() => createBlenderAdmission(cap, [model], async () => {})).toThrow(/Invalid/);
  });
  it('reserves before concurrent provider calls, with no oversubscription', async () => {
    const probe = createBlenderAdmission(10, [model], async () => {});
    await probe.admit(opts, async () => usage);
    const cap = probe.calls[0]!.reservedUsd * 1.5;
    let release!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    const invoke = vi.fn(async () => { await pending; return usage; });
    const guard = createBlenderAdmission(cap, [model], async () => {});
    const first = guard.admit(opts, invoke);
    await expect(guard.admit(opts, invoke)).rejects.toThrow(/cost admission/);
    release(); await first;
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(guard.accounted()).toBe(usage.costUsd);
  });
  it('does not call the provider if durable reservation recording fails', async () => {
    const invoke = vi.fn();
    const guard = createBlenderAdmission(10, [model], async () => { throw new Error('disk unavailable'); });
    await expect(guard.admit(opts, invoke)).rejects.toThrow('disk unavailable');
    expect(invoke).not.toHaveBeenCalled();
    expect(() => guard.assertSettled()).toThrow();
  });
  it('retains unknown usage and refuses further generation', async () => {
    const guard = createBlenderAdmission(10, [model], async () => {});
    await expect(guard.admit(opts, async () => { throw new Error('transport lost'); })).rejects.toThrow();
    const invoke = vi.fn();
    await expect(guard.admit(opts, invoke)).rejects.toThrow('transport lost');
    expect(invoke).not.toHaveBeenCalled();
    expect(guard.accounted()).toBeGreaterThan(0);
  });
  it('rejects unpinned models, missing output bounds and bogus free usage', async () => {
    const guard = createBlenderAdmission(10, [model], async () => {});
    const invoke = vi.fn(async () => usage);
    await expect(guard.admit({ ...opts, model: 'gpt-5.6-sol:xhigh' }, invoke)).rejects.toThrow(/model/);
    await expect(guard.admit({ ...opts, maxTokens: undefined }, invoke)).rejects.toThrow(/bounded/);
    expect(invoke).not.toHaveBeenCalled();
    await expect(guard.admit(opts, async () => ({ ...usage, costUsd: 0 }))).rejects.toThrow(/usage/);
    expect(() => guard.assertSettled()).toThrow();
  });
  it('counts a lost cycle once at its whole cap, then settles only an exact matching receipt', () => {
    const reserved = { cycleId: 'real-scout-1', pin: STUDY_BLOCKS.luna.pin, reservedUsd: 10, settled: false, costUsd: null };
    expect(sumBlenderTicks([reserved])).toEqual([{ pin: reserved.pin, arm: 'blender', attempts: 1, cost: 10 }]);
    expect(sumBlenderTicks([reserved, { ...reserved, settled: true, costUsd: 0.2 }])[0]).toMatchObject({ attempts: 1, cost: 0.2 });
    expect(() => sumBlenderTicks([reserved, { ...reserved, reservedUsd: 1 }])).toThrow(/Conflicting/);
  });
  it('charges Blender reservations against admission for Dream arms', () => {
    const blender = sumBlenderTicks([{ cycleId: 'lost', pin: STUDY_BLOCKS.luna.pin, reservedUsd: 10, settled: false, costUsd: null }]);
    const limits = { attempts: 200, attemptsPerArm: 50, discoveryUsd: 20, discoveryUsdPerArm: 50, cycleUsd: 10 } as any;
    expect(() => requireStudyRoom([...blender, { pin: STUDY_BLOCKS.luna.pin, arm: 'structured-pair', attempts: 1, cost: 0.1 }], 'structured-pair', limits)).toThrow(/cap reached/);
  });
});
