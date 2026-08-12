/**
 * CLIENT PARITY: no injection adapter may deliver through a channel that can
 * pre-empt, cancel, or drop in-flight work.
 *
 * Plan: omp-context-injection-and-behavior-2026-08-12, P-002 (the audit) and
 * P-012 (this guard).
 *
 * WHAT THIS IS FOR. Injection adapters decide WHAT to say. Until now none of
 * them declared HOW it gets said — that lived only in each client-native
 * artifact, in prose, in three separate files, in three different vocabularies.
 * So when OMP's artifact delivered through a queue instead of a return value,
 * there was nothing to compare it against and nothing failed. It was found by
 * reading a rollout transcript weeks later.
 *
 * MEASURED COST of that gap, one Gemini session (2026-08-11): 13 tool calls
 * discarded mid-flight and replaced with a synthesised "Skipped due to pending
 * system advisory"; 13 of 13 immediately followed one of our injections, with no
 * other cause present. The model then explained the loss to itself and got it
 * wrong — it concluded its tool-calling convention was being rejected and
 * switched conventions for its remaining ~220 calls. A synthetic result we cause
 * is never neutral: the model WILL explain it, and it will explain it wrong.
 *
 * THE INVARIANT: an injection may only ADD to something the client is already
 * assembling. It may never enqueue an event that the agent loop has to drain,
 * because draining is the act that cancels pending work.
 *
 * "New client, new seam, no test" is how this shipped, so the guard is written
 * against the adapter REGISTRY rather than a hardcoded list — a fourth client
 * is covered the moment it is registered, without anyone remembering to come
 * back here.
 */

import { describe, it, expect } from 'vitest';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DELIVERY_MECHANISMS,
  validateDeliverySeam,
// @ts-ignore -- runtime .mjs module; covered by this parity test.
} from '../ports.mjs';

const ADAPTER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters');

/** Every adapter that exists on disk — not a hardcoded list, so a new client
 *  cannot opt out of this guard by simply not being mentioned here. */
async function loadAllAdapters(): Promise<Array<{ file: string; mod: any }>> {
  const files = (await readdir(ADAPTER_DIR)).filter((f) => f.endsWith('.mjs')).sort();
  const out: Array<{ file: string; mod: any }> = [];
  for (const file of files) {
    out.push({ file, mod: await import(join(ADAPTER_DIR, file)) });
  }
  return out;
}

describe('every injection adapter declares a non-pre-empting delivery seam', () => {
  it('finds the adapters (guard against an empty sweep passing vacuously)', async () => {
    const adapters = await loadAllAdapters();
    // If the directory moved, every per-adapter assertion below would vacuously
    // pass over an empty list. Pin the population first.
    expect(adapters.length).toBeGreaterThanOrEqual(3);
    expect(adapters.map((a) => a.file)).toEqual(
      expect.arrayContaining(['claude.mjs', 'codex.mjs', 'omp.mjs']),
    );
  });

  it('each adapter declares a seam that cannot pre-empt in-flight work', async () => {
    const adapters = await loadAllAdapters();
    const offenders: string[] = [];
    for (const { file, mod } of adapters) {
      const result = validateDeliverySeam(mod.deliverySeam);
      if (!result.ok) offenders.push(`${file}: ${result.errors.join('; ')}`);
    }
    expect(
      offenders,
      'an adapter may only ADD to content the client is already assembling; it may ' +
        'never enqueue an event the agent loop has to drain',
    ).toEqual([]);
  });

  it('the seam is also on the default export, which is what the dispatcher loads', async () => {
    // index.mjs resolves adapters via their DEFAULT export. A seam declared only
    // as a named export would satisfy the sweep above while being invisible to
    // the code path that actually runs — the same "tested one projection, shipped
    // the other" divergence that caused P-003.
    const adapters = await loadAllAdapters();
    for (const { file, mod } of adapters) {
      expect(mod.default?.deliverySeam, `${file} default export must carry the seam`).toEqual(
        mod.deliverySeam,
      );
    }
  });
});

describe('the seam validator actually rejects the dangerous shapes', () => {
  // Calibration. Without these, the suite above passes just as happily against
  // a validator that returns ok for everything.

  it('CONTROL: rejects a queued-message seam — the exact shape that shipped', () => {
    const result = validateDeliverySeam({
      mechanism: 'queued-message',
      artifact: 'some-artifact.ts',
      evidence: 'looks fine to me',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('pre-empt');
  });

  it('CONTROL: rejects a steer-interrupt seam', () => {
    const result = validateDeliverySeam({
      mechanism: 'steer-interrupt',
      artifact: 'some-artifact.ts',
      evidence: 'e',
    });
    expect(result.ok).toBe(false);
  });

  it('CONTROL: rejects an undeclared seam, and an unknown mechanism', () => {
    expect(validateDeliverySeam(undefined).ok).toBe(false);
    const unknown = validateDeliverySeam({
      mechanism: 'sounds-safe-enough',
      artifact: 'a.ts',
      evidence: 'e',
    });
    expect(unknown.ok).toBe(false);
    // A new mechanism must be classified with a measured verdict rather than
    // waved through because its name reads reassuringly.
    expect(unknown.errors.join(' ')).toContain('DELIVERY_MECHANISMS');
  });

  it('CONTROL: rejects a safe mechanism with no artifact or no evidence', () => {
    // The classification has to stay falsifiable: a reviewer must be able to
    // open the named file and check the claim.
    expect(validateDeliverySeam({ mechanism: 'hook-return-value', evidence: 'e' }).ok).toBe(false);
    expect(validateDeliverySeam({ mechanism: 'hook-return-value', artifact: 'a.ts' }).ok).toBe(
      false,
    );
  });

  it('accepts the two additive mechanisms (so the rejections above mean something)', () => {
    for (const mechanism of ['hook-return-value', 'tool-result-merge'] as const) {
      expect(
        validateDeliverySeam({ mechanism, artifact: 'a.ts', evidence: 'measured' }).ok,
      ).toBe(true);
    }
  });

  it('every catalogued mechanism carries a stated reason', () => {
    // The pre-empting entries are kept deliberately: a new adapter author
    // reaches for exactly those, and a named mechanism carrying its own verdict
    // teaches better than an absence they would have to infer.
    for (const [name, spec] of Object.entries(DELIVERY_MECHANISMS)) {
      expect(typeof spec.canPreempt, `${name}.canPreempt`).toBe('boolean');
      expect(spec.why.length, `${name}.why must explain the verdict`).toBeGreaterThan(40);
    }
  });
});
