/**
 * Tests for WI-4245 — desktop/version.ts's pure payload builder.
 *
 * The route itself computes `buildSha`/`appVersion` once at import time via
 * `getBuildInfo()` (memoized, real fs/git access) — not worth fighting that
 * for a unit test. `buildDesktopVersionPayload()` is exported specifically so
 * the interesting behavior (does the wire shape correctly surface baked
 * provenance, and does a null sha coerce to the old "unknown" sentinel) is
 * testable as a pure function.
 */

import { describe, it, expect } from 'vitest';
import { buildDesktopVersionPayload } from './version';

describe('buildDesktopVersionPayload (WI-4245)', () => {
  it('passes through a real baked sha + version untouched', () => {
    const payload = buildDesktopVersionPayload(
      { sha: 'abc1234', version: '0.5.2' },
      { startedAtMs: 1000, nowMs: 2000, isDesktop: true },
    );

    expect(payload).toEqual({
      appVersion: '0.5.2',
      sidecarSha: 'abc1234',
      sidecarStartedAtMs: 1000,
      nowMs: 2000,
      isDesktop: true,
    });
  });

  it('coerces a null sha to the "unknown" sentinel (never null on the wire)', () => {
    const payload = buildDesktopVersionPayload(
      { sha: null, version: '0.0.0' },
      { startedAtMs: 1000, nowMs: 2000, isDesktop: false },
    );

    expect(payload.sidecarSha).toBe('unknown');
    expect(payload.appVersion).toBe('0.0.0');
  });

  it('passes isDesktop through faithfully in both directions', () => {
    const desktop = buildDesktopVersionPayload(
      { sha: 'deadbee', version: '1.0.0' },
      { startedAtMs: 0, nowMs: 0, isDesktop: true },
    );
    const notDesktop = buildDesktopVersionPayload(
      { sha: 'deadbee', version: '1.0.0' },
      { startedAtMs: 0, nowMs: 0, isDesktop: false },
    );

    expect(desktop.isDesktop).toBe(true);
    expect(notDesktop.isDesktop).toBe(false);
  });
});
