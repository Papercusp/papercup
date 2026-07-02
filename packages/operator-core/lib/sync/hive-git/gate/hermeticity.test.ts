/**
 * hermeticity.test.ts — DG-6 (P-049): the pure capability/coverage model the
 * scheduler (DG-3) and aggregator (DG-5) consume.
 * Run: cd packages/operator-core && npx vitest run lib/sync/hive-git/gate/hermeticity.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  GATE_COVERAGE_BOUNDARY,
  KNOWN_COVERAGE_COUPLINGS,
  assessShard,
  baseCapabilities,
} from './hermeticity';

describe('gate hermeticity (DG-6)', () => {
  it('unit shards need only node; integration shards add docker', () => {
    expect(baseCapabilities('unit')).toEqual(['node']);
    expect(baseCapabilities('integration')).toEqual(['node', 'docker']);
  });

  it('a plain library shard is fully hermetic', () => {
    const a = assessShard({ shardId: '@papercusp/rules::unit', workspaceName: '@papercusp/rules', layer: 'unit' });
    expect(a).toEqual({
      shardId: '@papercusp/rules::unit',
      required: ['node'],
      narrowsWithout: [],
      fullyHermetic: true,
    });
  });

  it('the operator-core integration shard carries its live-operator narrowings', () => {
    const a = assessShard({
      shardId: '@papercusp/operator-core::integration',
      workspaceName: '@papercusp/operator-core',
      layer: 'integration',
    });
    expect(a.required).toEqual(['node', 'docker']);
    expect(a.fullyHermetic).toBe(false);
    expect(a.narrowsWithout.length).toBeGreaterThanOrEqual(7);
    // Every registered coupling is optional-by-behavior — none may hard-require.
    for (const c of a.narrowsWithout) {
      expect(['self-skips', 'opt-in-env', 'fail-soft']).toContain(c.behavior);
    }
  });

  it('the operator-core UNIT shard is not tainted by integration couplings', () => {
    const a = assessShard({
      shardId: '@papercusp/operator-core::unit',
      workspaceName: '@papercusp/operator-core',
      layer: 'unit',
    });
    expect(a.fullyHermetic).toBe(true);
  });

  it('registry rows are well-formed evidence (path + note + known capability)', () => {
    for (const c of KNOWN_COVERAGE_COUPLINGS) {
      expect(c.path.length).toBeGreaterThan(0);
      expect(c.note.length).toBeGreaterThan(0);
      expect(['node', 'docker', 'live-operator', 'llm-credentials']).toContain(c.capability);
    }
  });

  it('the gate coverage boundary is declared, not silent', () => {
    const frameworks = GATE_COVERAGE_BOUNDARY.map((b) => b.framework).join(' ');
    expect(frameworks).toMatch(/Playwright/);
    expect(frameworks).toMatch(/Cargo/);
    expect(frameworks).toMatch(/LLM scenarios/);
  });
});
