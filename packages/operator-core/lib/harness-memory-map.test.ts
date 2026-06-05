/**
 * Coverage for harness-memory-map: resolveMemoryPath (the path-traversal guard —
 * rejects .., empty, and any target escaping the project root) and detectTier
 * (exact MEMORY_MAP match → its tier; unknown under .papercusp/ → yellow; else
 * green). known-roles is mocked so the module's import-time fail-closed
 * attribution validation (which greps the prompts dir) passes in the test env.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./known-roles', () => ({
  getKnownRoles: () => ['scoper', 'worker', 'validator', 'architect', 'curator', 'orchestrator', 'reviewer'],
}));

import {
  resolveMemoryPath,
  detectTier,
  MEMORY_ATTRIBUTION_META,
  MEMORY_MAP,
} from './harness-memory-map';
import type { ProjectEntry } from './harness-registry';

const project = { path: '/proj' } as ProjectEntry;

describe('resolveMemoryPath', () => {
  it('resolves a clean relative path under the project root', () => {
    expect(resolveMemoryPath(project, 'AGENTS.md')).toEqual({ abs: '/proj/AGENTS.md' });
    expect(resolveMemoryPath(project, '.papercusp/memory/MEMORY.md')).toEqual({
      abs: '/proj/.papercusp/memory/MEMORY.md',
    });
  });

  it('strips a leading slash (treats it as relative)', () => {
    expect(resolveMemoryPath(project, '/foo')).toEqual({ abs: '/proj/foo' });
  });

  it('rejects .. traversal', () => {
    expect(resolveMemoryPath(project, '../etc/passwd')).toBeNull();
    expect(resolveMemoryPath(project, 'a/../../b')).toBeNull();
  });

  it('rejects an empty path', () => {
    expect(resolveMemoryPath(project, '')).toBeNull();
    expect(resolveMemoryPath(project, '/')).toBeNull();
  });
});

describe('detectTier', () => {
  it('returns the MEMORY_MAP tier for an exact match', () => {
    const t = detectTier('AGENTS.md');
    expect(t.tier).toBe('green');
    expect(t.meta?.path).toBe('AGENTS.md');
  });

  it('handles a ./-prefixed path by normalizing', () => {
    expect(detectTier('./.papercusp/memory/raw.md').tier).toBe('yellow'); // raw.md is yellow in the map
  });

  it('defaults unknown .papercusp/ files to yellow (soft-warn)', () => {
    const t = detectTier('.papercusp/scratch/unknown.md');
    expect(t.tier).toBe('yellow');
    expect(t.meta).toBeNull();
  });

  it('defaults unknown project-root files to green', () => {
    const t = detectTier('README.md');
    expect(t.tier).toBe('green');
    expect(t.meta).toBeNull();
  });
});

describe('MEMORY_MAP / MEMORY_ATTRIBUTION_META', () => {
  it('the meta-actor set is the non-role attributions', () => {
    expect(MEMORY_ATTRIBUTION_META).toEqual(new Set(['human', 'all', 'run.sh', 'UI']));
  });
  it('every entry declares a tier + language', () => {
    for (const m of MEMORY_MAP) {
      expect(['green', 'yellow', 'red']).toContain(m.tier);
      expect(['markdown', 'json', 'text', 'jsonl']).toContain(m.language);
    }
  });
});
