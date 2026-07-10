/**
 * idempotent-register-workflow.test.ts (WI-3830) — pins the globalThis-cached guard:
 * a `register()` factory runs AT MOST ONCE per key per process; a second call with the
 * SAME key returns the cached handle without re-invoking `register()` (the exact
 * behavior that stops a double module-load from re-calling DBOS.registerWorkflow and
 * crashing on DBOSConflictingRegistrationError).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { idempotentRegisterWorkflow } from './idempotent-register-workflow';

type G = typeof globalThis & { __papercuspDbosWorkflowCache__?: Map<string, unknown> };

beforeEach(() => {
  // Isolate each test from the shared process-global cache.
  (globalThis as G).__papercuspDbosWorkflowCache__ = new Map();
});

describe('idempotentRegisterWorkflow', () => {
  it('calls register() on the first call for a key', () => {
    const register = vi.fn(() => async () => 'ok');
    const fn = idempotentRegisterWorkflow('k1', register);
    expect(register).toHaveBeenCalledTimes(1);
    expect(fn).toBeTypeOf('function');
  });

  it('does NOT call register() again on a second call with the SAME key — returns the cached handle', () => {
    const firstHandle = async () => 'first';
    const register = vi.fn(() => firstHandle);
    const a = idempotentRegisterWorkflow('k2', register);
    const secondRegister = vi.fn(() => async () => 'second-should-never-run');
    const b = idempotentRegisterWorkflow('k2', secondRegister);

    expect(register).toHaveBeenCalledTimes(1);
    expect(secondRegister).not.toHaveBeenCalled();
    expect(b).toBe(a); // identical cached reference, not just equal
    expect(b).toBe(firstHandle);
  });

  it('DIFFERENT keys each register independently (no cross-key interference)', () => {
    const regA = vi.fn(() => async () => 'a');
    const regB = vi.fn(() => async () => 'b');
    idempotentRegisterWorkflow('key-a', regA);
    idempotentRegisterWorkflow('key-b', regB);
    expect(regA).toHaveBeenCalledTimes(1);
    expect(regB).toHaveBeenCalledTimes(1);
  });

  it('the cache SURVIVES across separate calls without a manual reset (simulates a hot-reload re-import)', () => {
    const register = vi.fn(() => async () => 'stable');
    idempotentRegisterWorkflow('k3', register);
    // Simulate the module being re-evaluated (e.g. a require-cache bust) by calling
    // idempotentRegisterWorkflow again with a FRESH register() closure — as a real
    // re-import would produce a new `() => DBOS.registerWorkflow(...)` arrow each time.
    for (let i = 0; i < 3; i += 1) {
      idempotentRegisterWorkflow('k3', vi.fn(() => async () => `reload-${i}`));
    }
    expect(register).toHaveBeenCalledTimes(1);
  });
});
