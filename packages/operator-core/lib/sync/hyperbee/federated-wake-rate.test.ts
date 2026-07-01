/**
 * federated-wake-rate.test.ts — the per-author-device federated wake budget
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-003). Pins:
 *   • n tokens per fan (one per would-be-woken agent), atomic over-budget refusal;
 *   • sliding window: tokens age out after an hour;
 *   • per-author isolation; env-tunable cap read at call time;
 *   • warn once per window, not per suppressed wake.
 *
 * Run: cd packages/operator-core && npx vitest run lib/sync/hyperbee/federated-wake-rate.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  tryConsumeFederatedWake,
  resetFederatedWakeRate,
  DEFAULT_FED_WAKE_MAX_PER_HOUR,
} from './federated-wake-rate';

const T0 = 1_700_000_000_000;

beforeEach(() => {
  resetFederatedWakeRate();
  delete process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR;
});
afterEach(() => {
  delete process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR;
});

describe('tryConsumeFederatedWake', () => {
  it('allows up to the cap, then refuses', () => {
    process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR = '3';
    expect(tryConsumeFederatedWake('dev-a', 1, T0)).toBe(true);
    expect(tryConsumeFederatedWake('dev-a', 1, T0)).toBe(true);
    expect(tryConsumeFederatedWake('dev-a', 1, T0)).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(tryConsumeFederatedWake('dev-a', 1, T0)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('an over-budget multi-token spend is refused ATOMICALLY (nothing partially consumed)', () => {
    process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR = '5';
    expect(tryConsumeFederatedWake('dev-a', 4, T0)).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 4 spent; a 2-token fan would exceed 5 → refused whole…
      expect(tryConsumeFederatedWake('dev-a', 2, T0)).toBe(false);
    } finally {
      warn.mockRestore();
    }
    // …so a 1-token fan still fits (the refusal recorded nothing).
    expect(tryConsumeFederatedWake('dev-a', 1, T0)).toBe(true);
  });

  it('tokens age out of the sliding hour', () => {
    process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR = '2';
    expect(tryConsumeFederatedWake('dev-a', 2, T0)).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(tryConsumeFederatedWake('dev-a', 1, T0 + 1000)).toBe(false);
    } finally {
      warn.mockRestore();
    }
    expect(tryConsumeFederatedWake('dev-a', 1, T0 + 60 * 60 * 1000 + 1)).toBe(true);
  });

  it('budgets are per author device — one device at cap never starves another', () => {
    process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR = '1';
    expect(tryConsumeFederatedWake('dev-a', 1, T0)).toBe(true);
    expect(tryConsumeFederatedWake('dev-b', 1, T0)).toBe(true);
  });

  it('warns ONCE per author per window, not per suppressed wake', () => {
    process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR = '1';
    expect(tryConsumeFederatedWake('dev-a', 1, T0)).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(tryConsumeFederatedWake('dev-a', 1, T0 + 1)).toBe(false);
      expect(tryConsumeFederatedWake('dev-a', 1, T0 + 2)).toBe(false);
      expect(tryConsumeFederatedWake('dev-a', 1, T0 + 3)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('an empty author keys under "unknown"; a garbage env cap falls back to the default', () => {
    process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR = 'not-a-number';
    for (let i = 0; i < DEFAULT_FED_WAKE_MAX_PER_HOUR; i++) {
      expect(tryConsumeFederatedWake('', 1, T0)).toBe(true);
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(tryConsumeFederatedWake('', 1, T0)).toBe(false);
      expect(tryConsumeFederatedWake('unknown', 1, T0)).toBe(false); // same bucket
    } finally {
      warn.mockRestore();
    }
  });
});
