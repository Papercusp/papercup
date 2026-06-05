import { describe, it, expect } from 'vitest';
import {
  paletteEligibility,
  isPaletteVisible,
  requiresPaletteConfirm,
  type PaletteEligibility,
} from './safety-filter';
import type { Capability } from './types';

/**
 * Minimal server-capability fixture: plain, low-risk, no required args.
 * `paletteEligibility(base)` is the happy path → 'fire-and-toast'.
 */
const base: Capability = {
  id: 'goals:list',
  title: 'List Goals',
  description: 'list the goals',
  runsIn: 'server',
  requiresArgs: false,
  tier: 'low',
  gating: {},
};

describe('paletteEligibility — server capabilities', () => {
  it('a plain low-risk server capability fires-and-toasts', () => {
    expect(paletteEligibility(base)).toBe<PaletteEligibility>('fire-and-toast');
  });

  it('excludes streaming, interactive, and requiresArgs capabilities (the toast shim cannot host them)', () => {
    expect(paletteEligibility({ ...base, streaming: true })).toBe('exclude');
    expect(paletteEligibility({ ...base, interactive: true })).toBe('exclude');
    expect(paletteEligibility({ ...base, requiresArgs: true })).toBe('exclude');
  });

  it('exclusion wins over confirm — a destructive + streaming tool is excluded, not confirm-gated', () => {
    // streaming is checked before destructive/tier, so the streaming exclusion takes precedence.
    expect(paletteEligibility({ ...base, streaming: true, destructive: true })).toBe('exclude');
    expect(paletteEligibility({ ...base, interactive: true, tier: 'high' })).toBe('exclude');
    expect(paletteEligibility({ ...base, requiresArgs: true, destructive: true, tier: 'high' })).toBe(
      'exclude',
    );
  });

  it('requires confirm for destructive capabilities', () => {
    expect(paletteEligibility({ ...base, destructive: true })).toBe('confirm');
  });

  it('requires confirm for tier:high capabilities', () => {
    expect(paletteEligibility({ ...base, tier: 'high' })).toBe('confirm');
  });

  it('tier:medium alone (not destructive) still fires-and-toasts — only high gates', () => {
    expect(paletteEligibility({ ...base, tier: 'medium' })).toBe('fire-and-toast');
  });
});

describe('paletteEligibility — browser / hybrid branch', () => {
  it('a browser capability WITHOUT surfaces.palette is excluded', () => {
    expect(paletteEligibility({ ...base, runsIn: 'browser' })).toBe('exclude');
    expect(paletteEligibility({ ...base, runsIn: 'browser', surfaces: {} })).toBe('exclude');
  });

  it('a hybrid capability WITHOUT surfaces.palette is excluded', () => {
    expect(paletteEligibility({ ...base, runsIn: 'hybrid' })).toBe('exclude');
  });

  it('a browser capability WITH surfaces.palette fires-and-toasts (its in-tab handler owns side effects)', () => {
    const cap: Capability = {
      ...base,
      runsIn: 'browser',
      surfaces: { palette: { section: 'Navigation' } },
    };
    expect(paletteEligibility(cap)).toBe('fire-and-toast');
  });

  it('a hybrid capability WITH surfaces.palette fires-and-toasts', () => {
    const cap: Capability = {
      ...base,
      runsIn: 'hybrid',
      surfaces: { palette: { section: 'Navigation' } },
    };
    expect(paletteEligibility(cap)).toBe('fire-and-toast');
  });

  it('the browser branch ignores destructive/streaming/requiresArgs — palette annotation alone decides', () => {
    // The browser branch returns BEFORE the server-side streaming/destructive checks,
    // so an annotated browser command fires-and-toasts even when flagged destructive.
    const cap: Capability = {
      ...base,
      runsIn: 'browser',
      destructive: true,
      streaming: true,
      requiresArgs: true,
      tier: 'high',
      surfaces: { palette: { section: 'Danger' } },
    };
    expect(paletteEligibility(cap)).toBe('fire-and-toast');

    // …and without the annotation, that same dangerous browser command is simply excluded.
    expect(paletteEligibility({ ...cap, surfaces: undefined })).toBe('exclude');
  });
});

describe('isPaletteVisible', () => {
  it('is true for fire-and-toast and confirm, false for exclude', () => {
    expect(isPaletteVisible(base)).toBe(true); // fire-and-toast
    expect(isPaletteVisible({ ...base, destructive: true })).toBe(true); // confirm
    expect(isPaletteVisible({ ...base, streaming: true })).toBe(false); // exclude
    expect(isPaletteVisible({ ...base, runsIn: 'browser' })).toBe(false); // exclude
  });

  it('agrees with paletteEligibility !== exclude', () => {
    for (const cap of [
      base,
      { ...base, destructive: true },
      { ...base, tier: 'high' as const },
      { ...base, streaming: true },
      { ...base, runsIn: 'browser' as const },
      { ...base, runsIn: 'browser' as const, surfaces: { palette: { section: 's' } } },
    ]) {
      expect(isPaletteVisible(cap)).toBe(paletteEligibility(cap) !== 'exclude');
    }
  });
});

describe('requiresPaletteConfirm', () => {
  it('is true only for the confirm tier (destructive / high)', () => {
    expect(requiresPaletteConfirm({ ...base, destructive: true })).toBe(true);
    expect(requiresPaletteConfirm({ ...base, tier: 'high' })).toBe(true);
  });

  it('is false for fire-and-toast and for excluded capabilities', () => {
    expect(requiresPaletteConfirm(base)).toBe(false); // fire-and-toast
    expect(requiresPaletteConfirm({ ...base, streaming: true })).toBe(false); // excluded, not confirm
    expect(requiresPaletteConfirm({ ...base, runsIn: 'browser' })).toBe(false); // excluded
  });
});
