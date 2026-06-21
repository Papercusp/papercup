/**
 * turn:interrupt unit tests (turn-lifecycle-control Phase 4 — P-018 guardrails +
 * the headless half of P-020). Exercises the dep-injected core `performInterrupt`
 * so no DB / real processes are touched; the pty-Esc + live-SIGINT-on-a-real-pid
 * legs are covered separately (a4bf4's Phase 3 e2e + a live smoke).
 */
import { describe, it, expect } from 'vitest';
import { performInterrupt, type InterruptDeps, type InterruptInput } from './interrupt';

function baseInput(over: Partial<InterruptInput> = {}): InterruptInput {
  return { actor: 'su-actor', workspaceId: 'ws', owner: 'su-target', mode: 'cooperative', reason: 'obsolete work', ...over };
}

interface Calls {
  send: InterruptInput[];
  sigint: number[];
  audit: Array<{ action: string; subject: string }>;
}

function makeDeps(over: Partial<InterruptDeps> = {}): { d: InterruptDeps; calls: Calls } {
  const calls: Calls = { send: [], sigint: [], audit: [] };
  const d: InterruptDeps = {
    sendYield: async (i) => {
      calls.send.push(i);
      return 'msg-1';
    },
    heldLockPaths: async () => [],
    recentInterrupts: async () => 0,
    liveSessionPid: async () => 1234,
    ptyForce: async () => false,
    sigint: (pid) => {
      calls.sigint.push(pid);
      return true;
    },
    audit: async (action, subject) => {
      calls.audit.push({ action, subject });
    },
    ...over,
  };
  return { d, calls };
}

const actions = (calls: Calls) => calls.audit.map((a) => a.action);

describe('turn:interrupt — performInterrupt (P-016/P-018; headless P-020)', () => {
  it('cooperative happy path injects a yield + audits cooperative', async () => {
    const { d, calls } = makeDeps();
    const r = await performInterrupt(baseInput({ mode: 'cooperative' }), d);
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('cooperative');
    expect(r.delivered).toBe('msg-1');
    expect(calls.send).toHaveLength(1);
    expect(actions(calls)).toContain('turn.interrupt_cooperative');
  });

  it('cooperative DEFERS when the target holds file locks (critical section) — does NOT inject', async () => {
    const { d, calls } = makeDeps({ heldLockPaths: async () => ['a.ts', 'b.ts'] });
    const r = await performInterrupt(baseInput({ mode: 'cooperative' }), d);
    expect(r.ok).toBe(false);
    expect(r.deferred).toBe(true);
    expect(r.held).toEqual(['a.ts', 'b.ts']);
    expect(calls.send).toHaveLength(0);
    expect(actions(calls)).toContain('turn.interrupt_deferred');
  });

  it('force uses headless SIGINT when there is no managed-pty socket', async () => {
    const { d, calls } = makeDeps({ ptyForce: async () => false, liveSessionPid: async () => 4242 });
    const r = await performInterrupt(baseInput({ mode: 'force' }), d);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('sigint');
    expect(calls.sigint).toEqual([4242]);
    expect(actions(calls)).toContain('turn.interrupt_force');
  });

  it('force prefers managed-pty Ctrl+C over SIGINT when a pty socket is live', async () => {
    const { d, calls } = makeDeps({ ptyForce: async () => true });
    const r = await performInterrupt(baseInput({ mode: 'force' }), d);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('pty-ctrl-c');
    expect(calls.sigint).toHaveLength(0); // SIGINT not attempted when pty succeeded
  });

  it('force fails cleanly when the target has no live interruptible session', async () => {
    const { d } = makeDeps({ ptyForce: async () => false, liveSessionPid: async () => null });
    const r = await performInterrupt(baseInput({ mode: 'force' }), d);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no live interruptible session/);
  });

  it('force still proceeds on a critical section but WARNS (orphaned-edit hazard)', async () => {
    const { d } = makeDeps({ heldLockPaths: async () => ['mig.sql'], liveSessionPid: async () => 9 });
    const r = await performInterrupt(baseInput({ mode: 'force' }), d);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('sigint');
    expect(r.critical_warning).toMatch(/file lock/);
  });

  it('storm guard trips at/above the cap: refuses + audits, no yield/SIGINT', async () => {
    const { d, calls } = makeDeps({ recentInterrupts: async () => 10 });
    const r = await performInterrupt(baseInput({ mode: 'force' }), d);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('rate_limited');
    expect(calls.sigint).toHaveLength(0);
    expect(calls.send).toHaveLength(0);
    expect(actions(calls)).toContain('turn.interrupt_rate_limited');
  });

  it('refuses to interrupt your own turn', async () => {
    const { d, calls } = makeDeps();
    const r = await performInterrupt(baseInput({ owner: 'su-actor', actor: 'su-actor' }), d);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/your own turn/);
    expect(calls.send).toHaveLength(0);
  });

  it('force key:"esc" sends ESC over the managed pty (endTurn / stall-recovery path) → pty-esc channel', async () => {
    const keys: Array<'sigint' | 'esc'> = [];
    const { d } = makeDeps({ ptyForce: async (_owner, key) => { keys.push(key); return true; } });
    const r = await performInterrupt(baseInput({ mode: 'force', key: 'esc' }), d);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('pty-esc');
    expect(keys).toEqual(['esc']); // the ESC byte (\x1b), not Ctrl+C
  });

  it('force with no key defaults to Ctrl+C (turn:interrupt behaviour unchanged)', async () => {
    const keys: Array<'sigint' | 'esc'> = [];
    const { d } = makeDeps({ ptyForce: async (_owner, key) => { keys.push(key); return true; } });
    const r = await performInterrupt(baseInput({ mode: 'force' }), d); // no key
    expect(r.channel).toBe('pty-ctrl-c');
    expect(keys).toEqual(['sigint']);
  });
});
