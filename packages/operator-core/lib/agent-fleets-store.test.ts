/**
 * Coverage for agent-fleets-store.fleetSlugFromName — the pure name→slug derivation
 * used by the psu "enter a new fleet name" step (the slug is the durable id, the
 * env-var value, and the presence label).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { asFleetType, FLEET_TYPES, fleetSlugFromName } from './agent-fleets-store';

const LIB_ROOT = fileURLToPath(new URL('.', import.meta.url));
const STORE_MOCK_START_RE = /vi\.mock\(\s*(['"])[^'"]*agent-fleets-store\1/;
const STORE_OBJECT_MOCK_RE = /vi\.mock\(\s*(['"])[^'"]*agent-fleets-store\1\s*,[\s\S]*?\}\)\);/g;

function testSourcesBelow(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testSourcesBelow(path);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * A full vi.mock replaces every runtime export. goal-launch-settings builds its
 * fleetType schema from FLEET_TYPES at module scope, so omitting the value makes
 * any newly-connected import path fail during collection before a test can run.
 * Partial importOriginal/actual mocks keep the real export and are intentionally
 * exempt. This is the central recurrence guard for the strand that red-pinned
 * unrelated fleet, capability, bootstrap and coordination test files.
 */
function fullStoreMocksWithoutFleetTypes(): string[] {
  const offenders: string[] = [];
  for (const file of testSourcesBelow(LIB_ROOT)) {
    const source = readFileSync(file, 'utf8');
    if (!STORE_MOCK_START_RE.test(source)) continue;
    STORE_OBJECT_MOCK_RE.lastIndex = 0;
    const calls = [...source.matchAll(STORE_OBJECT_MOCK_RE)].map((match) => match[0]);
    if (calls.length === 0) {
      // Block-bodied partial mocks use `const actual = await orig()` and return
      // `{ ...actual, overrides }`; they preserve every unmentioned export.
      if (!/\.\.\.actual/.test(source)) offenders.push(`${file} (unparsed mock shape)`);
      continue;
    }
    for (const call of calls) {
      if (/importOriginal|\.\.\.actual/.test(call)) continue;
      if (!call.includes('FLEET_TYPES')) offenders.push(file);
    }
  }
  return [...new Set(offenders)].sort();
}

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

describe('agent-fleets-store full-mock contract', () => {
  it('preserves the runtime FLEET_TYPES vocabulary in every full vi.mock factory', () => {
    expect(fullStoreMocksWithoutFleetTypes()).toEqual([]);
  });
});
