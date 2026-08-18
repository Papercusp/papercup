import { describe, expect, test } from 'vitest';

import { describeAdmissionCeiling } from './admission-ceiling';

/**
 * The regression these tests pin is a READING failure, not a crash: `gateway:status` reported
 * `maxConcurrent: 4` beside `aimd.effective: 24` with no field connecting them, and the natural
 * reading ("AIMD is stuck at its floor") was wrong. The binding term was the serviceable-account
 * clamp. Each test below asserts the surface now NAMES the binding term instead of leaving it to
 * be inferred.
 */
describe('describeAdmissionCeiling', () => {
  test('THE LIVE 2026-08-18 READING: names the serviceable clamp, not AIMD, as the binding term', () => {
    const r = describeAdmissionCeiling({
      applied: 4,
      aimdEffective: 24,
      configuredCap: 24,
      clamp: { mode: 'auto', recommendation: 4, applied: 4, overridden: false, serviceableAccounts: 1 },
    });
    expect(r.boundBy).toBe('serviceable-clamp');
    expect(r.slotsWithheld).toBe(20);
    expect(r.serviceableAccounts).toBe(1);
    expect(r.serviceableRecommendation).toBe(4);
    // The whole point: the explanation must contradict the tempting-but-wrong AIMD reading.
    expect(r.why).toContain('SERVICEABLE-ACCOUNT CLAMP');
    expect(r.why).toContain('not AIMD');
    // And it must hand over the lever, since the reader otherwise has no way to know one exists.
    expect(r.lever).toContain('/admin/readmit');
    expect(r.lever).toContain('/admin/clamp-mode');
  });

  test('a MISSING clamp reads as UNKNOWN — never as "not clamped"', () => {
    const r = describeAdmissionCeiling({ applied: 4, aimdEffective: 24, configuredCap: 24 });
    expect(r.boundBy).toBe('unknown');
    expect(r.clampMode).toBe('unknown');
    expect(r.serviceableRecommendation).toBeNull();
    expect(r.why).toContain('UNKNOWN');
    expect(r.why).toContain('Do NOT read this as "not clamped"');
    // It still reports the size of the unexplained gap rather than hiding it.
    expect(r.slotsWithheld).toBe(20);
  });

  test('an explicit null clamp is treated identically to an absent one', () => {
    const absent = describeAdmissionCeiling({ applied: 4, aimdEffective: 24, configuredCap: 24 });
    const explicitNull = describeAdmissionCeiling({ applied: 4, aimdEffective: 24, configuredCap: 24, clamp: null });
    expect(explicitNull).toEqual(absent);
  });

  test('mode:"off" — the recommendation is REPORTED but is not the binding term', () => {
    const r = describeAdmissionCeiling({
      applied: 24,
      aimdEffective: 24,
      configuredCap: 24,
      clamp: { mode: 'off', recommendation: 4, applied: 24, overridden: true, serviceableAccounts: 1 },
    });
    expect(r.boundBy).toBe('configured-cap');
    // Overridden ≠ forgotten: the recommendation still rides along so the override stays visible.
    expect(r.serviceableRecommendation).toBe(4);
    expect(r.slotsWithheld).toBe(0);
    expect(r.lever).toBeNull();
  });

  test('AIMD shedding is attributed to AIMD, and offers no lever — recovery is automatic', () => {
    const r = describeAdmissionCeiling({
      applied: 8,
      aimdEffective: 8,
      configuredCap: 24,
      clamp: { mode: 'auto', recommendation: 20, applied: 8, overridden: false, serviceableAccounts: 5 },
    });
    expect(r.boundBy).toBe('aimd');
    expect(r.why).toContain('shed 16 slot(s)');
    expect(r.lever).toBeNull();
  });

  test('nothing withheld: admission at the configured cap reports real demand, not a defect', () => {
    const r = describeAdmissionCeiling({
      applied: 24,
      aimdEffective: 24,
      configuredCap: 24,
      clamp: { mode: 'auto', recommendation: 40, applied: 24, overridden: false, serviceableAccounts: 10 },
    });
    expect(r.boundBy).toBe('configured-cap');
    expect(r.slotsWithheld).toBe(0);
    expect(r.why).toContain('real demand exceeding real capacity');
  });

  test('a clamp that cannot report its account count still binds, and says so without inventing a number', () => {
    const r = describeAdmissionCeiling({
      applied: 2,
      aimdEffective: 24,
      configuredCap: 24,
      clamp: { mode: 'auto', recommendation: 2, applied: 2, overridden: false },
    });
    expect(r.boundBy).toBe('serviceable-clamp');
    expect(r.serviceableAccounts).toBeNull();
    expect(r.why).toContain('the serviceable-account count');
    // The ambiguity that motivated publishing the raw count: recommendation 2 is BOTH "0 serviceable"
    // and "the MIN floor", so the report must not claim a specific account count here.
    expect(r.why).not.toMatch(/\b0 serviceable account/);
  });

  test('an equal recommendation does not bind — only a strictly tighter one does', () => {
    const r = describeAdmissionCeiling({
      applied: 24,
      aimdEffective: 24,
      configuredCap: 24,
      clamp: { mode: 'auto', recommendation: 24, applied: 24, overridden: false, serviceableAccounts: 6 },
    });
    expect(r.boundBy).toBe('configured-cap');
  });

  test('is total — a non-finite recommendation degrades to null instead of leaking Infinity', () => {
    const r = describeAdmissionCeiling({
      applied: 24,
      aimdEffective: 24,
      configuredCap: 24,
      clamp: { mode: 'auto', recommendation: Number.POSITIVE_INFINITY as unknown as number, applied: 24, overridden: false },
    });
    expect(r.serviceableRecommendation).toBeNull();
    expect(r.boundBy).toBe('configured-cap');
    expect(Number.isFinite(r.slotsWithheld)).toBe(true);
  });
});
