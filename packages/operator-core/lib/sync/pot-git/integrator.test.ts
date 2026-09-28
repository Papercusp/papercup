/**
 * integrator.test.ts — pure helpers behind WI-10003731 (per-host state conflicts).
 * The real-git behaviour is in integrator.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  HOST_LOCAL_STATE_DIRS,
  formatIntegratorTickStatus,
  formatParkedConflicts,
  isHostLocalStatePath,
} from './integrator';

describe('formatIntegratorTickStatus', () => {
  const dev = 'ab'.repeat(32);
  const gated = { integrated: 2, queued: 0, errors: 0 };

  it('reports an ADVANCING tick with skipped:null so a stale no-advance note is overwritten', () => {
    const s = formatIntegratorTickStatus({
      advanced: true,
      staging: '69c6ccc0123456789abcdef',
      gated,
      parked: [],
      hostLocalResolved: 1,
      errorCount: 0,
    });
    expect(s.skipped).toBeNull();
    expect(s.detail).toBe(
      'integrator ran; advanced staging to 69c6ccc01234 (gate: integrated=2 queued=0 errors=0; conflicts=0; host-local-resolved=1; errors=0)',
    );
    expect(s.detail).not.toMatch(/no advance/);
  });

  it('keeps the exact no-advance wording (with parked paths) when staging did not move', () => {
    const s = formatIntegratorTickStatus({
      advanced: false,
      staging: 'dd578ec5',
      gated,
      parked: [{ deviceHex: dev, sha: 'ba9ce0fb'.padEnd(40, '0'), paths: ['app.txt'] }],
      hostLocalResolved: 0,
      errorCount: 0,
    });
    expect(s.skipped).toBe('ran_no_advance');
    expect(s.detail).toBe(
      `integrator ran; no advance (gate: integrated=2 queued=0 errors=0; conflicts=1; errors=0) parked: ${dev.slice(0, 12)}@ba9ce0fb: app.txt`,
    );
  });

  it('still names parked heads on an advance that integrated only some members', () => {
    const s = formatIntegratorTickStatus({
      advanced: true,
      staging: null,
      gated: null,
      parked: [{ deviceHex: dev, sha: 'c'.repeat(40), paths: ['x.ts'] }],
      hostLocalResolved: 0,
      errorCount: 1,
    });
    expect(s.skipped).toBeNull();
    expect(s.detail).toBe(
      `integrator ran; advanced staging to unknown (gate: none; conflicts=1; errors=1) parked: ${dev.slice(0, 12)}@cccccccc: x.ts`,
    );
  });
});

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
