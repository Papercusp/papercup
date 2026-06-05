import { describe, it, expect, beforeEach } from 'vitest';
import { computeNextFireAt } from './cron';
import {
  registerSystemAction,
  getSystemAction,
  listSystemActions,
  SYSTEM_TARGET_PREFIX,
  type SystemActionCtx,
} from './system-actions';

describe('computeNextFireAt', () => {
  it('computes the next fire for a 6-field (seconds) crontab', () => {
    const from = new Date('2026-06-03T00:00:00.000Z');
    const next = computeNextFireAt('*/30 * * * * *', from);
    expect(next).toBeInstanceOf(Date);
    // every 30s → next boundary is :30
    expect(next!.toISOString()).toBe('2026-06-03T00:00:30.000Z');
  });

  it('computes the next fire for a 5-field crontab', () => {
    const from = new Date('2026-06-03T09:00:01.000Z');
    const next = computeNextFireAt('*/5 * * * *', from); // every 5 minutes
    expect(next!.toISOString()).toBe('2026-06-03T09:05:00.000Z');
  });

  it('returns null for an unparseable expression instead of throwing', () => {
    expect(computeNextFireAt('not a cron', new Date())).toBeNull();
    expect(computeNextFireAt('', new Date())).toBeNull();
  });
});

describe('system-action registry', () => {
  beforeEach(() => {
    // registry is module-global; use unique names per test to avoid cross-talk
  });

  it('registers, retrieves, and lists handlers; SYSTEM_TARGET_PREFIX matches the dispatch convention', () => {
    expect(SYSTEM_TARGET_PREFIX).toBe('system:');
    const name = `unit-test-action-${Math.floor(performance.now())}`;
    expect(getSystemAction(name)).toBeUndefined();

    let calledWith: SystemActionCtx | null = null;
    const fn = async (ctx: SystemActionCtx) => { calledWith = ctx; };
    registerSystemAction(name, fn);

    expect(getSystemAction(name)).toBe(fn);
    expect(listSystemActions()).toContain(name);

    // a 'system:<name>' target_role strips to the registry key
    const target = `${SYSTEM_TARGET_PREFIX}${name}`;
    expect(target.startsWith(SYSTEM_TARGET_PREFIX)).toBe(true);
    expect(target.slice(SYSTEM_TARGET_PREFIX.length)).toBe(name);
    void calledWith;
  });

  it('last registration wins (idempotent re-register)', () => {
    const name = `unit-test-dupe-${Math.floor(performance.now())}`;
    const a = async () => {};
    const b = async () => {};
    registerSystemAction(name, a);
    registerSystemAction(name, b);
    expect(getSystemAction(name)).toBe(b);
  });
});
