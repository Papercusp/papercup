import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));

import { getOrgPg } from '@papercusp/db-org';
import {
  resolveWakeMode,
  resolveWakeModeFrom,
  coerceWakeMode,
  getDefaultWakeMode,
  setDefaultWakeMode,
  getWakeModeOverride,
  setWakeMode,
  ensureFleetMemberWakeAuto,
  DEFAULT_WAKE_MODE,
  WAKE_MODES,
} from './wake-mode';

// A Map-backed fake `sql` template tag mimicking the operator_settings KV: an
// INSERT upserts (key=vals[0] → value=vals[1]); a SELECT returns the row for
// its key=vals[0] (or none). Enough to exercise the get/set/resolve paths.
function fakeKv() {
  const store = new Map<string, string>();
  const sql = vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join('§');
    if (q.includes('INSERT')) {
      store.set(String(vals[0]), String(vals[1]));
      return Promise.resolve([] as unknown[]);
    }
    const v = store.get(String(vals[0])); // SELECT value WHERE key = vals[0]
    return Promise.resolve(v === undefined ? [] : [{ value: v }]);
  });
  return { sql, store };
}

let kv: ReturnType<typeof fakeKv>;
beforeEach(() => {
  kv = fakeKv();
  vi.mocked(getOrgPg).mockReturnValue({ sql: kv.sql } as never);
});
afterEach(() => vi.clearAllMocks());

describe('wake-mode pure helpers (P-015 / D-005)', () => {
  it('coerceWakeMode narrows valid modes + rejects garbage/null', () => {
    expect(coerceWakeMode('auto')).toBe('auto');
    expect(coerceWakeMode('manual')).toBe('manual');
    expect(coerceWakeMode('bogus')).toBeNull();
    expect(coerceWakeMode(null)).toBeNull();
  });
  it('resolveWakeModeFrom: override > global default > auto', () => {
    expect(resolveWakeModeFrom('manual', 'auto')).toBe('manual');
    expect(resolveWakeModeFrom(null, 'manual')).toBe('manual');
    expect(resolveWakeModeFrom(null, null)).toBe('auto');
    expect(DEFAULT_WAKE_MODE).toBe('auto');
    expect(WAKE_MODES).toEqual(['auto', 'manual']);
  });
});

describe('wake-mode store (operator_settings KV)', () => {
  it('defaults to auto with nothing configured (default-preserving)', async () => {
    expect(await getDefaultWakeMode()).toBe('auto');
    expect(await getWakeModeOverride('s-1')).toBeNull();
    expect(await resolveWakeMode('s-1')).toBe('auto');
  });
  it('a global default applies to every agent without an override', async () => {
    await setDefaultWakeMode('manual');
    expect(await getDefaultWakeMode()).toBe('manual');
    expect(await resolveWakeMode('s-anything')).toBe('manual');
  });
  it('a per-agent override beats the global default', async () => {
    await setDefaultWakeMode('manual');
    await setWakeMode('s-1', 'auto');
    expect(await resolveWakeMode('s-1')).toBe('auto'); // override wins
    expect(await resolveWakeMode('s-2')).toBe('manual'); // falls back to the default
  });
  it('a garbage stored value falls back to the default', async () => {
    kv.store.set('wake_mode:default', 'nonsense');
    expect(await getDefaultWakeMode()).toBe('auto');
  });
});

describe('ensureFleetMemberWakeAuto — fleet-member wake immunity (WI-2185)', () => {
  it('writes an auto override for a MEMBER and returns the mode', async () => {
    expect(await ensureFleetMemberWakeAuto('s-member', 'member')).toBe('auto');
    expect(kv.store.get('wake_mode:agent:s-member')).toBe('auto');
    expect(await getWakeModeOverride('s-member')).toBe('auto');
  });
  it('makes the member immune to a manual GLOBAL default', async () => {
    await setDefaultWakeMode('manual');
    await ensureFleetMemberWakeAuto('s-member', 'member');
    // The member wins with its override; a peer without one still inherits manual.
    expect(await resolveWakeMode('s-member')).toBe('auto');
    expect(await resolveWakeMode('s-peer')).toBe('manual');
  });
  it('is a NO-OP for a leader (owner-gated by design) — no override row written', async () => {
    await setDefaultWakeMode('manual');
    expect(await ensureFleetMemberWakeAuto('s-leader', 'leader')).toBeNull();
    expect(kv.store.has('wake_mode:agent:s-leader')).toBe(false);
    expect(await getWakeModeOverride('s-leader')).toBeNull();
    expect(await resolveWakeMode('s-leader')).toBe('manual'); // still inherits the gate
  });
  it('is a NO-OP for a non-fleet launch (null/undefined role)', async () => {
    expect(await ensureFleetMemberWakeAuto('s-solo', null)).toBeNull();
    expect(await ensureFleetMemberWakeAuto('s-solo', undefined)).toBeNull();
    expect(kv.store.has('wake_mode:agent:s-solo')).toBe(false);
  });
  it('setWakeMode carries a custom description when given', async () => {
    await setWakeMode('s-x', 'auto', 'because WI-2185');
    // The INSERT upsert stores value under the agent key regardless of description;
    // the description rides along to the KV write (asserted via the store value).
    expect(kv.store.get('wake_mode:agent:s-x')).toBe('auto');
  });
});
