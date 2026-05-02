import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'op-budget-'));
vi.mock('./papercusp-root', () => ({
  papercuspPath: (...parts: string[]) => join(tmpRoot, ...parts),
}));

import { loadBudget, setBudget, checkBudget, recordSpend, TIER_CAPS } from './operator-budget';

const PATH = join(tmpRoot, 'system', 'operator', 'budget.json');

beforeEach(() => {
  if (existsSync(PATH)) rmSync(PATH);
});
afterEach(() => {
  if (existsSync(PATH)) rmSync(PATH);
});

describe('loadBudget', () => {
  it('returns null until the user picks a sizing', () => {
    expect(loadBudget()).toBeNull();
  });

  it('returns the configured cap once set', () => {
    setBudget(TIER_CAPS.active);
    expect(loadBudget()?.dailyCapUsd).toBe(20);
  });
});

describe('setBudget validation', () => {
  it('rejects non-positive caps', () => {
    expect(() => setBudget(0)).toThrow();
    expect(() => setBudget(-1)).toThrow();
    expect(() => setBudget(NaN)).toThrow();
  });
});

describe('checkBudget + recordSpend', () => {
  it('starts under the cap', () => {
    setBudget(5);
    const c = checkBudget();
    expect(c.exceeded).toBe(false);
    expect(c.todaySpendUsd).toBe(0);
  });

  it('accumulates today and trips on overrun', () => {
    setBudget(5);
    recordSpend(2);
    recordSpend(2);
    expect(checkBudget().exceeded).toBe(false);
    recordSpend(2);
    expect(checkBudget().exceeded).toBe(true);
  });

  it('recordSpend is a no-op when no budget configured', () => {
    recordSpend(99);
    expect(loadBudget()).toBeNull();
  });
});
