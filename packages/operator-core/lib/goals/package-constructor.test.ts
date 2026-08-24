/**
 * package-constructor.test.ts — the P-022 constructor runtime's contract
 * (work-on-everything-goal-2026-08-23 P-022).
 *
 * Deliberately runs the REAL @papercusp/tooldef worker sandbox (same idiom as
 * the lib's own run-script.test.ts): the purity/timeout/determinism claims are
 * properties of the sandbox composition, and a mocked runner would test our
 * mock. The start-door WIRING is tested separately (start-from-package.test.ts)
 * with this runtime mocked — the two files split exactly on that seam.
 */
import { describe, expect, it } from 'vitest';
import {
  CONSTRUCT_OUTPUT_MAX_CHARS,
  runPackageConstructor,
  stableConstructJson,
  validateConstructSpec,
} from './package-constructor';

describe('validateConstructSpec — strict output shape', () => {
  it('accepts a partial spec of constructible keys', () => {
    const v = validateConstructSpec({ title: 'T', budgetCents: 100, launchSettings: { a: 1 } });
    expect(v).toMatchObject({ ok: true });
  });

  it('refuses a non-object return', () => {
    expect(validateConstructSpec(42)).toMatchObject({ ok: false });
    expect(validateConstructSpec([{ title: 'T' }])).toMatchObject({ ok: false });
    expect(validateConstructSpec(null)).toMatchObject({ ok: false });
  });

  it("refuses 'inputSchema' with the goalpost rule spelled out", () => {
    const v = validateConstructSpec({ title: 'T', inputSchema: {} });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.issues.join(' ')).toContain('cannot move its own goalposts');
  });

  it('refuses unknown keys and bad field types', () => {
    expect(validateConstructSpec({ status: 'active' })).toMatchObject({ ok: false });
    expect(validateConstructSpec({ title: '' })).toMatchObject({ ok: false });
    expect(validateConstructSpec({ standing: 'yes' })).toMatchObject({ ok: false });
    expect(validateConstructSpec({ budgetCents: 12.5 })).toMatchObject({ ok: false });
    expect(validateConstructSpec({ budgetCents: -1 })).toMatchObject({ ok: false });
    expect(validateConstructSpec({ budgetWindowSec: 0 })).toMatchObject({ ok: false });
    expect(validateConstructSpec({ launchSettings: [1] })).toMatchObject({ ok: false });
  });

  it("refuses a tripwire carrying live state ('current') or missing its shape", () => {
    const bad = validateConstructSpec({
      tripwires: [{ metric: 'm', label: 'l', threshold: 1, current: 5 }],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues.join(' ')).toContain('live state');
    expect(
      validateConstructSpec({ tripwires: [{ metric: 'm', threshold: 1 }] }),
    ).toMatchObject({ ok: false });
    expect(
      validateConstructSpec({ tripwires: [{ metric: 'm', label: 'l', threshold: 1, unit: 'ms' }] }),
    ).toMatchObject({ ok: true });
  });
});

describe('stableConstructJson — the determinism comparator', () => {
  it('is key-order independent, recursively', () => {
    expect(stableConstructJson({ b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }] })).toBe(
      stableConstructJson({ a: [{ y: 2, z: 1 }], b: { c: 2, d: 1 } }),
    );
  });
});

describe('runPackageConstructor — the sandboxed double-run', () => {
  it('builds a spec from the frozen typed inputs', async () => {
    const res = await runPackageConstructor(
      `return { title: 'Drain ' + inputs.queue, budgetCents: inputs.n * 100 };`,
      { queue: 'alpha', n: 5 },
    );
    expect(res).toEqual({
      ok: true,
      spec: { title: 'Drain alpha', budgetCents: 500 },
      overriddenKeys: ['budgetCents', 'title'],
    });
  });

  it('runs with NO inputs at all (a static-input constructor)', async () => {
    const res = await runPackageConstructor(`return { standing: true };`, null);
    expect(res).toMatchObject({ ok: true, overriddenKeys: ['standing'] });
  });

  it('refuses an empty construct.js as a typed error, not a silent static fallback', async () => {
    const res = await runPackageConstructor('   \n', { a: 1 });
    expect(res).toMatchObject({ ok: false, reason: 'construct-error' });
  });

  it('a thrown script is construct-error with the message surfaced', async () => {
    const res = await runPackageConstructor(`throw new Error('boom');`, null);
    expect(res).toMatchObject({ ok: false, reason: 'construct-error' });
    if (res.ok) return;
    expect(res.detail).toContain('boom');
  });

  it('PURITY: any tools.* access throws — the facade is empty', async () => {
    const res = await runPackageConstructor(
      `const g = await tools.goals.list({}); return { title: 'x' };`,
      null,
    );
    expect(res).toMatchObject({ ok: false, reason: 'construct-error' });
  });

  it('an invalid returned shape is construct-invalid-output', async () => {
    const res = await runPackageConstructor(`return { title: 'x', status: 'active' };`, null);
    expect(res).toMatchObject({ ok: false, reason: 'construct-invalid-output' });
  });

  it('an oversized spec is construct-output-too-large', async () => {
    const res = await runPackageConstructor(
      `return { body: 'x'.repeat(${CONSTRUCT_OUTPUT_MAX_CHARS + 100}) };`,
      null,
    );
    expect(res).toMatchObject({ ok: false, reason: 'construct-output-too-large' });
  });

  it('DETERMINISM: a random spec is refused by the double-run compare', async () => {
    const res = await runPackageConstructor(
      `return { title: 'x' + Math.random() };`,
      null,
    );
    expect(res).toMatchObject({ ok: false, reason: 'construct-nondeterministic' });
    if (res.ok) return;
    expect(res.detail).toContain('pure function');
  });

  it('TIMEOUT: a sync spin is hard-killed at the wall clock', async () => {
    const res = await runPackageConstructor(`while (true) {}`, null, { timeoutMs: 1500 });
    expect(res).toMatchObject({ ok: false, reason: 'construct-timeout' });
  }, 15_000);
});
