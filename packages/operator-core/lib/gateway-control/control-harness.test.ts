import { describe, it, expect, vi } from 'vitest';
import { runControlMutation, type ControlMutationSpec, type ControlHarnessDeps } from './control-harness';

/** A fake mutable "store" + a spec over it, so the harness orchestration is testable with no DB. */
function mkSpec(over: Partial<ControlMutationSpec<{ v: number }>> = {}) {
  const store = { v: 1 };
  const spec: ControlMutationSpec<{ v: number }> = {
    action: 'gateway:set-aimd',
    subject: 'pool',
    capturePrev: vi.fn(async () => ({ v: store.v })),
    apply: vi.fn(async () => {
      store.v = 2;
      return { v: store.v };
    }),
    revertTo: vi.fn(async (prev: { v: number }) => {
      store.v = prev.v;
    }),
    describe: vi.fn((prev: { v: number }) => ({ from: prev.v, to: 2 })),
    ...over,
  };
  return { spec, store };
}

const noAudit: ControlHarnessDeps = { writeAudit: vi.fn(async () => 'audit-1') };

describe('runControlMutation (B-X-1 harness)', () => {
  it('dryRun previews (capture + describe) WITHOUT applying or auditing', async () => {
    const { spec, store } = mkSpec();
    const writeAudit = vi.fn(async () => 'a');
    const out = await runControlMutation(spec, { dryRun: true }, { writeAudit });

    expect(out).toMatchObject({ action: 'gateway:set-aimd', subject: 'pool', dryRun: true, applied: false, prev: { v: 1 } });
    expect(out.preview).toEqual({ from: 1, to: 2 });
    expect(spec.apply).not.toHaveBeenCalled();
    expect(spec.revertTo).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
    expect(out.revert).toBeUndefined();
    expect(store.v).toBe(1); // untouched
  });

  it('apply: captures prev → applies → verifies → audits (prev+next) → exposes revert', async () => {
    const { spec, store } = mkSpec({ verify: vi.fn(async () => ({ ok: true, detail: 'reflected' })) });
    const writeAudit = vi.fn(async () => 'audit-42');
    const out = await runControlMutation(spec, {}, { writeAudit });

    expect(out).toMatchObject({ dryRun: false, applied: true, prev: { v: 1 }, next: { v: 2 }, auditId: 'audit-42' });
    expect(out.verify).toEqual({ ok: true, detail: 'reflected' });
    expect(store.v).toBe(2);
    // Audit carries who/what/prev/next.
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'gateway:set-aimd', subject: 'pool', prev: { v: 1 }, next: { v: 2 } }),
    );
    expect(typeof out.revert).toBe('function');
  });

  it('one-call revert: replays prev + writes a `<action>:revert` audit referencing the original', async () => {
    const { spec, store } = mkSpec();
    const writeAudit = vi.fn(async () => 'audit-orig');
    const out = await runControlMutation(spec, {}, { writeAudit });
    expect(store.v).toBe(2);

    writeAudit.mockResolvedValueOnce('audit-revert');
    const rev = await out.revert!();

    expect(store.v).toBe(1); // reverted to prev
    expect(spec.revertTo).toHaveBeenCalledWith({ v: 1 });
    expect(rev).toMatchObject({ action: 'gateway:set-aimd:revert', applied: true, prev: { v: 2 }, next: { v: 1 } });
    // The revert audit references the original mutation's id.
    expect(writeAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'gateway:set-aimd:revert', revertOf: 'audit-orig', prev: { v: 2 }, next: { v: 1 } }),
    );
  });

  it('failed verify + verifyMustPass (default) → auto-reverts, applied:false, no revert handle', async () => {
    const { spec, store } = mkSpec({ verify: vi.fn(async () => ({ ok: false, detail: 'not reflected' })) });
    const out = await runControlMutation(spec, {}, noAudit);

    expect(spec.revertTo).toHaveBeenCalledWith({ v: 1 }); // auto-reverted
    expect(store.v).toBe(1);
    expect(out).toMatchObject({ applied: false, reverted: true });
    expect(out.revert).toBeUndefined(); // nothing in effect to revert
    expect(noAudit.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ reverted: true }));
  });

  it('failed verify + verifyMustPass:false → keeps the change (no auto-revert)', async () => {
    const { spec, store } = mkSpec({ verify: vi.fn(async () => ({ ok: false })) });
    const out = await runControlMutation(spec, { verifyMustPass: false }, noAudit);

    expect(spec.revertTo).not.toHaveBeenCalled();
    expect(store.v).toBe(2);
    expect(out).toMatchObject({ applied: true, reverted: undefined });
    expect(typeof out.revert).toBe('function'); // still revertible by hand
  });

  it('an apply throw propagates (the consumer owns apply atomicity) — no audit, no revert', async () => {
    const { spec } = mkSpec({ apply: vi.fn(async () => { throw new Error('DB write failed'); }) });
    const writeAudit = vi.fn(async () => 'x');
    await expect(runControlMutation(spec, {}, { writeAudit })).rejects.toThrow('DB write failed');
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('no-verify spec applies + audits cleanly (verify omitted)', async () => {
    const { spec, store } = mkSpec(); // no verify
    const out = await runControlMutation(spec, {}, noAudit);
    expect(out).toMatchObject({ applied: true, next: { v: 2 } });
    expect(out.verify).toBeUndefined();
    expect(store.v).toBe(2);
  });
});
