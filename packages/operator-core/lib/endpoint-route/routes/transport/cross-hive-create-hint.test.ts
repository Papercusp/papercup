import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { crossHiveCreateHint } from './_mcp-host';

/**
 * EI-24646272383071079: a hive-confined session's `harness:create { slug }` was refused
 * with "slug ... names a harness outside this session's hive", which reads as a naming
 * conflict. The real fact is that, without `pot`, the NEW harness would be hive-less.
 * The clamp stays (collectHarnessSlugArgs checks `pot` when given); the refusal must name
 * the argument that creates the harness inside the caller's hive.
 */
describe('crossHiveCreateHint', () => {
  it('tells a refused harness:create to pass pot:<its hive>', () => {
    const hint = crossHiveCreateHint('harness:create', 'slug', 'papercusp');
    expect(hint).toContain('pot:"papercusp"');
    expect(hint).toContain('NEW harness');
  });

  it('is silent for every other tool or argument', () => {
    expect(crossHiveCreateHint('harness:create', 'pot', 'papercusp')).toBe('');
    expect(crossHiveCreateHint('pot:obliterate', 'slug', 'papercusp')).toBe('');
    expect(crossHiveCreateHint('git-sync:run', 'harness', 'papercusp')).toBe('');
  });

  it('is wired into BOTH harness_forbidden clamp sweeps of _mcp-host.ts', () => {
    const source = readFileSync(join(import.meta.dirname, '_mcp-host.ts'), 'utf8');
    const calls = source.match(/\$\{crossHiveCreateHint\(toolName, arg, scopeHive\)\}/g) ?? [];
    const sweeps = source.match(/\$\{crossHiveSelfSweepHint\(toolName, slug, scopeHive\)\}/g) ?? [];
    expect(sweeps.length).toBeGreaterThan(0);
    expect(calls.length).toBe(sweeps.length);
  });
});
