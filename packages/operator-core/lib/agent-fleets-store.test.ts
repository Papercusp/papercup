/**
 * Coverage for agent-fleets-store.fleetSlugFromName — the pure name→slug derivation
 * used by the psu "enter a new fleet name" step (the slug is the durable id, the
 * env-var value, and the presence label).
 */
import { describe, expect, it } from 'vitest';
import { fleetSlugFromName } from './agent-fleets-store';

describe('fleetSlugFromName', () => {
  it('kebab-cases a human name', () => {
    expect(fleetSlugFromName('My Cool Fleet')).toBe('my-cool-fleet');
  });

  it('collapses runs of non-alphanumerics (incl. underscores) and trims the edges', () => {
    expect(fleetSlugFromName('  Front-End  Squad!! ')).toBe('front-end-squad');
    expect(fleetSlugFromName('a___b')).toBe('a-b');
    expect(fleetSlugFromName('Fleet #1 (alpha)')).toBe('fleet-1-alpha');
  });

  it('caps length to 60 chars', () => {
    expect(fleetSlugFromName('x'.repeat(100))).toHaveLength(60);
  });

  it('falls back to "fleet" for empty / all-symbol input', () => {
    expect(fleetSlugFromName('')).toBe('fleet');
    expect(fleetSlugFromName('   ')).toBe('fleet');
    expect(fleetSlugFromName('!!!')).toBe('fleet');
  });
});
