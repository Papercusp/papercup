import { describe, it, expect } from 'vitest';
import { paletteInvokeGuard } from './invoke';
import type { Capability } from './types';

const base: Capability = {
  id: 't:x', title: 'X', description: 'x', runsIn: 'server', requiresArgs: false, tier: 'low', gating: {},
};

describe('paletteInvokeGuard', () => {
  it('allows a plain low-risk server capability', () => {
    expect(paletteInvokeGuard(base, false)).toEqual({ allow: true, cap: base });
  });

  it('refuses excluded capabilities (streaming/interactive/required-arg) — server-side, regardless of confirm', () => {
    for (const bad of [
      { ...base, requiresArgs: true },
      { ...base, streaming: true },
      { ...base, interactive: true },
    ]) {
      const g = paletteInvokeGuard(bad, true /* even with confirm */);
      expect(g.allow).toBe(false);
      if (!g.allow) {
        expect(g.status).toBe(403);
        expect(g.code).toBe('not_palette_eligible');
      }
    }
  });

  it('requires confirmation for destructive / high-risk', () => {
    const dest = { ...base, destructive: true };
    const g = paletteInvokeGuard(dest, false);
    expect(g.allow).toBe(false);
    if (!g.allow) {
      expect(g.status).toBe(409);
      expect(g.code).toBe('confirmation_required');
    }
    // …but proceeds once confirmed.
    expect(paletteInvokeGuard(dest, true).allow).toBe(true);
    expect(paletteInvokeGuard({ ...base, tier: 'high' }, true).allow).toBe(true);
  });

  it('a browser capability without a palette annotation is excluded', () => {
    expect(paletteInvokeGuard({ ...base, runsIn: 'browser' }, true).allow).toBe(false);
  });
});
