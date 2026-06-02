import { describe, it, expect } from 'vitest';
import { TELEMETRY_KINDS, isTelemetryKind } from './telemetry-kinds';

describe('telemetry-kinds', () => {
  it('exposes every kind via TELEMETRY_KINDS', () => {
    expect(Object.keys(TELEMETRY_KINDS).length).toBeGreaterThanOrEqual(8);
    expect(TELEMETRY_KINDS.crash).toBe('crash');
    expect(TELEMETRY_KINDS.startup_failed).toBe('startup_failed');
    expect(TELEMETRY_KINDS.setup_step).toBe('setup_step');
  });

  it('isTelemetryKind narrows to known values', () => {
    expect(isTelemetryKind('crash')).toBe(true);
    expect(isTelemetryKind('migration_failed')).toBe(true);
    expect(isTelemetryKind('unknown_kind')).toBe(false);
    expect(isTelemetryKind('')).toBe(false);
  });

  it('values match their keys (one-to-one)', () => {
    for (const [k, v] of Object.entries(TELEMETRY_KINDS)) {
      expect(v).toBe(k);
    }
  });

  it('includes the substrate admission-rejection kind (P-004)', () => {
    expect(TELEMETRY_KINDS.substrate_admission_rejected).toBe('substrate_admission_rejected');
    expect(isTelemetryKind('substrate_admission_rejected')).toBe(true);
  });
});
