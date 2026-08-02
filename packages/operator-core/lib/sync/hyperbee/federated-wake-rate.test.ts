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
  federatedWakeAllowance,
  recordFederatedWakeSpend,
  resetFederatedWakeRate,
  DEFAULT_FED_WAKE_MAX_PER_HOUR,
} from './federated-wake-rate';

const T0 = 1_700_000_000_000;

beforeEach(() => {
  resetFederatedWakeRate();
  delete process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR;
  delete process.env.PAPERCUSP_FED_WAKE_DIRECTED_RESERVE;
});
afterEach(() => {
  delete process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR;
  delete process.env.PAPERCUSP_FED_WAKE_DIRECTED_RESERVE;
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

/**
 * WI-7043 — ambient traffic (fed_event re-fires, courtesy receipts) used to share
 * ONE undifferentiated budget with directed addressee wakes AND to charge before
 * knowing whether it woke anyone. Measured on the tower↔Mac rig: 33 fed_events +
 * 7 directed wakes in one hour against a cap of 30, so both LIVE-1 parity wakes
 * were suppressed while their messages applied normally.
 */
describe('WI-7043: ambient spend must not starve directed wakes', () => {
  it('reserves headroom: ambient stops at cap-reserve while directed still reaches the cap', () => {
    process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR = '9';
    process.env.PAPERCUSP_FED_WAKE_DIRECTED_RESERVE = '3';
    // Ambient may take 6 (9 - 3) and no more…
    for (let i = 0; i < 6; i++) {
      expect(tryConsumeFederatedWake('dev-a', 1, T0, 'ambient')).toBe(true);
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(tryConsumeFederatedWake('dev-a', 1, T0, 'ambient')).toBe(false);
    } finally {
      warn.mockRestore();
    }
    // …and the 3 reserved tokens are still there for the directed fan.
    expect(federatedWakeAllowance('dev-a', 'directed', T0)).toBe(3);
    expect(tryConsumeFederatedWake('dev-a', 3, T0, 'directed')).toBe(true);
  });

  it('the shipped default keeps a third of the cap reserved for directed wakes', () => {
    // 30/hour default → ambient ceiling 20, directed 30.
    expect(federatedWakeAllowance('dev-a', 'ambient', T0)).toBe(20);
    expect(federatedWakeAllowance('dev-a', 'directed', T0)).toBe(
      DEFAULT_FED_WAKE_MAX_PER_HOUR,
    );
  });

  it('an emit that woke NOBODY costs nothing (the starvation bug)', () => {
    process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR = '4';
    process.env.PAPERCUSP_FED_WAKE_DIRECTED_RESERVE = '0';
    const before = federatedWakeAllowance('dev-a', 'ambient', T0);
    // The admission check charges nothing…
    expect(before).toBe(4);
    expect(federatedWakeAllowance('dev-a', 'ambient', T0)).toBe(4);
    // …and a re-fire that matched no local watcher bills zero.
    recordFederatedWakeSpend('dev-a', 0, 'ambient', T0);
    expect(federatedWakeAllowance('dev-a', 'ambient', T0)).toBe(4);
    // Only a re-fire that actually woke someone is billed.
    recordFederatedWakeSpend('dev-a', 2, 'ambient', T0);
    expect(federatedWakeAllowance('dev-a', 'ambient', T0)).toBe(2);
  });

  it('100 no-op fed_event re-fires leave a directed wake fully deliverable', () => {
    process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR = '30';
    for (let i = 0; i < 100; i++) {
      if (federatedWakeAllowance('dev-a', 'ambient', T0) > 0) {
        recordFederatedWakeSpend('dev-a', 0, 'ambient', T0); // woken: 0
      }
    }
    expect(federatedWakeAllowance('dev-a', 'directed', T0)).toBe(30);
    expect(tryConsumeFederatedWake('dev-a', 5, T0, 'directed')).toBe(true);
  });

  it('recordFederatedWakeSpend ignores non-positive and non-finite counts', () => {
    process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR = '5';
    recordFederatedWakeSpend('dev-a', -3, 'ambient', T0);
    recordFederatedWakeSpend('dev-a', Number.NaN, 'ambient', T0);
    expect(federatedWakeAllowance('dev-a', 'directed', T0)).toBe(5);
  });

  it('recorded spend ages out of the sliding window like consumed tokens', () => {
    process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR = '2';
    recordFederatedWakeSpend('dev-a', 2, 'ambient', T0);
    expect(federatedWakeAllowance('dev-a', 'directed', T0)).toBe(0);
    expect(federatedWakeAllowance('dev-a', 'directed', T0 + 60 * 60 * 1000 + 1)).toBe(2);
  });
});
