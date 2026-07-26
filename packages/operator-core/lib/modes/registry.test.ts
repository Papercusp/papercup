/**
 * The registry's UI display helpers.
 *
 * These exist because two GUI surfaces (the HUD session card, the Sessions
 * roster) each used to spell their own mode label and hover text, so only the
 * three modes someone remembered to write copy for were ever explained —
 * `cold-auto` and `grade` rendered a bare "Standing mode: grade". Deriving from
 * this registry means adding a mode explains it everywhere; these tests are what
 * keeps that true as MODES grows.
 */
import { describe, it, expect } from 'vitest';
import { MODES, modeChipLabel, modeChipTitle } from './registry';

describe('modeChipLabel', () => {
  it('renders a mode id as a chip label, hyphens as spaces', () => {
    expect(modeChipLabel('auto')).toBe('AUTO');
    expect(modeChipLabel('cold-auto')).toBe('COLD AUTO');
  });

  it('passes an unknown id through rather than rendering an empty chip', () => {
    expect(modeChipLabel('sideways')).toBe('SIDEWAYS');
  });
});

describe('modeChipTitle', () => {
  it('explains every registered mode with its title and one-liner', () => {
    for (const def of MODES) {
      const title = modeChipTitle(def.id);
      expect(title, def.id).toContain(def.title);
      expect(title, def.id).toContain(def.oneLiner);
    }
  });

  it('adds provenance when the caller knows it — the half that makes it actionable', () => {
    expect(modeChipTitle('auto', { ownerDirected: true })).toContain('Set by the owner');
    expect(modeChipTitle('auto', { ownerDirected: false })).toContain('set this itself');
  });

  it('omits the provenance line entirely when it is unknown', () => {
    const t = modeChipTitle('auto');
    expect(t).not.toContain('Set by the owner');
    expect(t).not.toContain('set this itself');
  });

  it('degrades to a named fallback for an unregistered mode instead of throwing', () => {
    expect(modeChipTitle('sideways')).toContain('Standing mode: sideways');
  });
});
