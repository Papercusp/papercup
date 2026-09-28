/**
 * integrator.test.ts — pure helpers behind WI-10003731 (per-host state conflicts).
 * The real-git behaviour is in integrator.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { HOST_LOCAL_STATE_DIRS, formatParkedConflicts, isHostLocalStatePath } from './integrator';

describe('isHostLocalStatePath', () => {
  it('derives its directories from the retired git tables via stateDirFor', () => {
    expect(HOST_LOCAL_STATE_DIRS).toEqual(['.papercusp/state/escalations/']);
  });

  it('matches per-host escalation files only', () => {
    expect(isHostLocalStatePath('.papercusp/state/escalations/github-bridge.md')).toBe(true);
    expect(isHostLocalStatePath('.papercusp/state/escalations/origin-freshness-watchdog.md')).toBe(true);
    // Shared git documents keep the normal park-and-rebase contract.
    expect(isHostLocalStatePath('.papercusp/state/decisions/d-1.md')).toBe(false);
    expect(isHostLocalStatePath('.papercusp/state/text-artifacts/x.md')).toBe(false);
    // Prefix, not substring: a nested lookalike is ordinary content.
    expect(isHostLocalStatePath('docs/.papercusp/state/escalations/x.md')).toBe(false);
    expect(isHostLocalStatePath('.papercusp/state/escalations')).toBe(false);
    expect(isHostLocalStatePath('app.txt')).toBe(false);
  });
});

describe('formatParkedConflicts', () => {
  const dev = 'a'.repeat(64);
  const sha = 'b'.repeat(40);

  it('is empty when nothing was parked', () => {
    expect(formatParkedConflicts([])).toBe('');
  });

  it('names the head and its conflicted paths', () => {
    expect(formatParkedConflicts([{ deviceHex: dev, sha, paths: ['app.txt', '.papercusp/state/escalations/x.md'] }])).toBe(
      ` parked: ${'a'.repeat(12)}@${'b'.repeat(8)}: app.txt, .papercusp/state/escalations/x.md`,
    );
  });

  it('reports a merge error instead of paths', () => {
    expect(formatParkedConflicts([{ deviceHex: dev, sha, paths: [], error: 'refusing to merge unrelated histories' }])).toBe(
      ` parked: ${'a'.repeat(12)}@${'b'.repeat(8)}: merge error (refusing to merge unrelated histories)`,
    );
  });

  it('bounds paths and heads so metadata cannot bloat', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ deviceHex: dev, sha, paths: ['p1', 'p2', 'p3', 'p4', 'p5'].map((p) => `${p}-${i}`) }));
    const out = formatParkedConflicts(many);
    expect(out).toContain('p1-0, p2-0, p3-0 +2 more');
    expect(out).not.toContain('p4-0');
    expect(out).toContain('; +2 more head(s)');
    expect(out.match(/@bbbbbbbb/g)).toHaveLength(3);
  });
});
