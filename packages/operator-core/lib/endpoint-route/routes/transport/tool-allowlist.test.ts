/**
 * Unit tests for the agent-mcp `?tools=` allowlist (voice-persona P-009).
 *
 * The load-bearing property: an explicit `?tools=` request narrows the
 * operator's surface to its working set, while EVERY other spawn (worker /
 * scoper / validator / a bare probe — no `?tools=`) keeps its full role
 * surface untouched. These tests pin both halves so a future edit to the
 * filter can't silently shrink a non-operator surface.
 */

import { describe, it, expect } from 'vitest';
import {
  parseToolsAllowlist,
  filterListingsByAllowlist,
} from './tool-allowlist';

// A stand-in for the agent-mcp `tools/list` projections: the real
// listMcpProjections() returns `{ name, description, inputSchema, ... }`;
// the filter only reads `.name`, so a `{ name }` shape exercises it faithfully
// without booting the full projection registry (DB clients, side-effect loads).
const SURFACE = [
  { name: 'harness:status' },
  { name: 'harness:list' },
  { name: 'issues:list' },
  { name: 'chat:ask_choice' },
  { name: 'plans:get' },
  { name: 'features:get' }, // not in the operator set — a cross-role tool
  { name: 'work_items:set_state' }, // not in the operator set
];

describe('parseToolsAllowlist', () => {
  it('returns null when the param is absent (no filtering)', () => {
    expect(parseToolsAllowlist(null)).toBeNull();
    expect(parseToolsAllowlist(undefined)).toBeNull();
  });

  it('returns null for an empty / whitespace-only param', () => {
    expect(parseToolsAllowlist('')).toBeNull();
    expect(parseToolsAllowlist('   ')).toBeNull();
    expect(parseToolsAllowlist(' , , ')).toBeNull();
  });

  it('parses comma-separated colon names, trimming whitespace and blanks', () => {
    const set = parseToolsAllowlist('harness:status, harness:list ,,chat:ask_choice');
    expect(set).toEqual(new Set(['harness:status', 'harness:list', 'chat:ask_choice']));
  });
});

describe('filterListingsByAllowlist', () => {
  it('returns the FULL surface untouched when the allowlist is null (worker/scoper/probe)', () => {
    const out = filterListingsByAllowlist(SURFACE, null);
    expect(out).toEqual(SURFACE);
    expect(out).toHaveLength(SURFACE.length);
  });

  it('narrows to exactly the named tools when an allowlist is given (operator)', () => {
    const allow = parseToolsAllowlist('harness:status,harness:list,issues:list,chat:ask_choice,plans:get');
    const out = filterListingsByAllowlist(SURFACE, allow);
    expect(out.map((t) => t.name)).toEqual([
      'harness:status',
      'harness:list',
      'issues:list',
      'chat:ask_choice',
      'plans:get',
    ]);
    // The cross-role tools NOT named are excluded — that's the deferral fix.
    expect(out.map((t) => t.name)).not.toContain('features:get');
    expect(out.map((t) => t.name)).not.toContain('work_items:set_state');
  });

  it('ignores unknown names in the allowlist (a stale name never hides the rest)', () => {
    const allow = parseToolsAllowlist('harness:status,does:not_exist');
    const out = filterListingsByAllowlist(SURFACE, allow);
    expect(out.map((t) => t.name)).toEqual(['harness:status']);
  });

  it('does not mutate the input listing array', () => {
    const frozen = Object.freeze([...SURFACE]);
    expect(() => filterListingsByAllowlist(frozen, parseToolsAllowlist('harness:list'))).not.toThrow();
    expect(() => filterListingsByAllowlist(frozen, null)).not.toThrow();
  });
});
