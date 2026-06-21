/**
 * telemetry-buffer-config — live-configurability-audit-2026-06-20 P-020.
 *
 * Covers the D-010 flag-gated SYNC cache: kill-switch OFF (or empty override) ⇒ telemetryBufferConfig()
 * returns the baked defaults (byte-identical); ON ⇒ a per-field override merges over the defaults.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ flagOn: true, store: new Map<string, unknown>() }));

vi.mock('@papercusp/flags/server', () => ({
  getFlag: async () => h.flagOn,
  onFlagChange: () => {},
}));
vi.mock('./flag-distinct-id', () => ({ systemDistinctId: () => 'system' }));
vi.mock('./operator-state-pg', () => ({
  readOperatorState: async (key: string) => h.store.get(key),
  writeOperatorState: async (key: string, value: unknown) => {
    h.store.set(key, value);
  },
}));

import {
  TELEMETRY_BUFFER_DEFAULTS,
  telemetryBufferConfig,
  refreshTelemetryBufferConfig,
  setTelemetryBufferOverride,
  readTelemetryBufferOverride,
  resetTelemetryBufferOverride,
} from './telemetry-buffer-config';

beforeEach(async () => {
  h.store.clear();
  h.flagOn = true;
  await refreshTelemetryBufferConfig();
});

describe('telemetry-buffer-config — D-010 flag-gated sync cache', () => {
  it('empty override ⇒ baked defaults (byte-identical)', () => {
    expect(telemetryBufferConfig()).toEqual(TELEMETRY_BUFFER_DEFAULTS);
  });

  it('kill-switch OFF ⇒ defaults even after a write (but the store still persists)', async () => {
    h.flagOn = false;
    await refreshTelemetryBufferConfig();
    await setTelemetryBufferOverride({ maxPending: 99999 });
    expect(telemetryBufferConfig()).toEqual(TELEMETRY_BUFFER_DEFAULTS);
    expect((await readTelemetryBufferOverride()).maxPending).toBe(99999);
  });

  it('ON ⇒ a per-field override merges over the defaults; other fields stay default', async () => {
    await setTelemetryBufferOverride({ maxPending: 20000 });
    expect(telemetryBufferConfig()).toEqual({
      maxPending: 20000,
      debounceMs: TELEMETRY_BUFFER_DEFAULTS.debounceMs,
      maxBatch: TELEMETRY_BUFFER_DEFAULTS.maxBatch,
    });
  });

  it('a second partial set merges, not replaces', async () => {
    await setTelemetryBufferOverride({ maxPending: 20000 });
    await setTelemetryBufferOverride({ debounceMs: 50 });
    expect(telemetryBufferConfig()).toEqual({
      maxPending: 20000,
      debounceMs: 50,
      maxBatch: TELEMETRY_BUFFER_DEFAULTS.maxBatch,
    });
  });

  it('reset clears the override back to defaults', async () => {
    await setTelemetryBufferOverride({ maxPending: 20000, maxBatch: 7 });
    await resetTelemetryBufferOverride();
    expect(telemetryBufferConfig()).toEqual(TELEMETRY_BUFFER_DEFAULTS);
    expect(await readTelemetryBufferOverride()).toEqual({});
  });
});
