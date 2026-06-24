/**
 * capability-tier-overrides.test.ts — live-configurability-audit-2026-06-20 P-010.
 *
 * The DARK runtime capability→tier override: flag-OFF ⇒ byte-identical (getter null, baked table
 * governs), flag-ON ⇒ the override is consulted; the installed papercuspTierFor seam; malformed-row
 * sanitation; set/clear round-trip — all PG-free via mocked operator-state + flag IO.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLAGS } from '@papercusp/flags';

const h = vi.hoisted(() => ({
  storedRow: {} as Record<string, unknown>,
  flagState: {} as Record<string, boolean>,
  capturedSeam: undefined as ((cap: string) => string | null | undefined) | undefined,
}));

vi.mock('@papercusp/flags/server', () => ({
  getFlag: vi.fn(async (key: string) => h.flagState[key] ?? false),
  onFlagChange: () => {},
}));
vi.mock('./operator-state-pg', () => ({
  readOperatorState: vi.fn(async () => h.storedRow),
  writeOperatorState: vi.fn(async (_t: string, p: Record<string, unknown>) => {
    h.storedRow = p;
  }),
}));
vi.mock('@papercusp/agent-mcp', () => ({
  setCapabilityTierOverride: (fn: typeof h.capturedSeam) => {
    h.capturedSeam = fn;
  },
}));
vi.mock('./flag-distinct-id', () => ({ systemDistinctId: () => 'sys' }));

import {
  refreshCapabilityTierOverrides,
  capabilityTierOverrideFor,
  setCapabilityTier,
  readCapabilityTierOverrides,
} from './capability-tier-overrides';

async function boot(opts: { enabled?: boolean; row?: Record<string, unknown> } = {}) {
  h.flagState[FLAGS.AUTH_CONFIG_OVERRIDES] = opts.enabled ?? false;
  h.storedRow = opts.row ?? {};
  await refreshCapabilityTierOverrides();
}

beforeEach(async () => {
  await boot();
});

describe('flag OFF (default) ⇒ byte-identical', () => {
  it('the getter returns null even with a stored row (the baked table governs)', async () => {
    await boot({ enabled: false, row: { tiers: { 'activity:recent': 'low' } } });
    expect(capabilityTierOverrideFor('activity:recent')).toBeNull();
    expect(h.capturedSeam?.('activity:recent')).toBeNull();
  });
});

describe('flag ON ⇒ the override is consulted before the baked table', () => {
  it('returns the override tier for an overridden capability, null otherwise', async () => {
    await boot({ enabled: true, row: { tiers: { 'activity:recent': 'low', 'storage:write': 'medium' } } });
    expect(capabilityTierOverrideFor('activity:recent')).toBe('low');
    expect(capabilityTierOverrideFor('storage:write')).toBe('medium');
    expect(capabilityTierOverrideFor('capability:bash')).toBeNull(); // not overridden ⇒ baked
    // the installed papercuspTierFor seam delegates to the same getter
    expect(h.capturedSeam?.('activity:recent')).toBe('low');
  });

  it('drops a malformed (non-tier) stored value on refresh', async () => {
    await boot({ enabled: true, row: { tiers: { 'a:b': 'bogus', 'c:d': 'high' } } });
    expect(capabilityTierOverrideFor('a:b')).toBeNull();
    expect(capabilityTierOverrideFor('c:d')).toBe('high');
  });
});

describe('set / clear round-trip (persist → refresh)', () => {
  it('setCapabilityTier is reflected by the getter once the flag is on', async () => {
    await boot({ enabled: true });
    await setCapabilityTier('search:read', 'low');
    expect(capabilityTierOverrideFor('search:read')).toBe('low');
    expect((await readCapabilityTierOverrides()).tiers?.['search:read']).toBe('low');
    await setCapabilityTier('search:read', null); // clear
    expect(capabilityTierOverrideFor('search:read')).toBeNull();
  });

  it('rejects an invalid tier value', async () => {
    await boot({ enabled: true });
    // @ts-expect-error — exercising the runtime guard
    await expect(setCapabilityTier('x:y', 'critical')).rejects.toThrow(/low \| medium \| high/);
  });
});
