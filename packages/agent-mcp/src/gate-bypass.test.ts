/**
 * Tests for the auth-tier → gate-bypass mapping.
 *
 * This 8-line function governs which gates (role / capability / quota) every
 * projected tool call skips, per tier. The subtle invariant — power-user sets
 * isSuperuser too, so it must NOT escape quota (quota = su && !pu) — had no
 * test. A regression here either lets power-users dodge workspace quotas or
 * wrongly blocks superusers.
 */

import { describe, expect, it } from 'vitest';
import { papercuspGateBypass } from './gate-bypass';

describe('papercuspGateBypass', () => {
  it('superuser bypasses role, capability, AND quota', () => {
    expect(papercuspGateBypass({ isSuperuser: true })).toEqual({
      role: true,
      capability: true,
      quota: true,
    });
  });

  it('power-user (which also sets isSuperuser) bypasses role + capability but NOT quota', () => {
    expect(papercuspGateBypass({ isSuperuser: true, isPowerUser: true })).toEqual({
      role: true,
      capability: true,
      quota: false,
    });
  });

  it('neither tier → every gate enforces', () => {
    expect(papercuspGateBypass({})).toEqual({ role: false, capability: false, quota: false });
    expect(papercuspGateBypass({ isSuperuser: false, isPowerUser: false })).toEqual({
      role: false,
      capability: false,
      quota: false,
    });
  });

  it('isPowerUser alone (no isSuperuser) grants no bypass on any gate', () => {
    // Defensive: production always pairs power-user with isSuperuser, but the
    // mapping must never grant role/capability bypass off isPowerUser alone.
    expect(papercuspGateBypass({ isPowerUser: true })).toEqual({
      role: false,
      capability: false,
      quota: false,
    });
  });
});
