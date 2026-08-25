/**
 * Coverage for agent-fleets-store.fleetSlugFromName — the pure name→slug derivation
 * used by the psu "enter a new fleet name" step (the slug is the durable id, the
 * env-var value, and the presence label).
 */
import { describe, expect, it } from 'vitest';
import { asFleetType, FLEET_TYPES, fleetSlugFromName } from './agent-fleets-store';

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

/**
 * asFleetType — the defensive narrowing behind AgentFleetRecord.fleetType
 * (directed-pair-work-items-2026-08-25 D-008 / P-010, migration 964).
 *
 * The asymmetry is the whole point and is what these cases pin: 'paired' is the
 * ONLY value that opens the paired code paths, and every other input — a legacy
 * row that predates the column, a typo, a value written by a newer release, a
 * lookalike like 'Paired' or 'pair' — reads back 'single'. A fleet can therefore
 * never be treated as paired by accident, only by having explicitly said so.
 */
describe('asFleetType', () => {
  it('honours the one non-default value', () => {
    expect(asFleetType('paired')).toBe('paired');
  });

  it('passes the default through', () => {
    expect(asFleetType('single')).toBe('single');
  });

  it('narrows a legacy/absent value to single', () => {
    // Rows written before migration 964 have no fleet_type at all.
    expect(asFleetType(null)).toBe('single');
    expect(asFleetType(undefined)).toBe('single');
  });

  it('narrows an unrecognised or lookalike value to single, never to paired', () => {
    for (const bogus of ['Paired', 'PAIRED', ' paired', 'pair', 'pairs', 'duo', '', 'true']) {
      expect(asFleetType(bogus)).toBe('single');
    }
  });

  it('narrows non-string junk to single rather than throwing', () => {
    for (const junk of [0, 1, true, false, {}, [], NaN]) {
      expect(asFleetType(junk)).toBe('single');
    }
  });

  it('only ever returns a declared fleet type', () => {
    for (const input of ['paired', 'single', null, 'nonsense', 42]) {
      expect(FLEET_TYPES).toContain(asFleetType(input));
    }
  });
});
