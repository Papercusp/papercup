/**
 * formatSubstrateStatus tests.
 */

import { describe, expect, it } from 'vitest';
import { formatSubstrateStatus } from '../format-cli';
import type { WorkspaceSubstrateSummary } from '../summary';

function summary(
  overrides: Partial<WorkspaceSubstrateSummary> = {},
): WorkspaceSubstrateSummary {
  return {
    enabled: true,
    totalHarnesses: 0,
    healthy: 0,
    booting: 0,
    degraded: 0,
    unhealthy: 0,
    disabled: 0,
    worstVerdict: 'healthy',
    ...overrides,
  };
}

describe('formatSubstrateStatus', () => {
  it('disabled view → exit 0 + disabled hint', () => {
    const r = formatSubstrateStatus({ enabled: false, bootedCount: 0 });
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toContain('· off');
    expect(r.lines.join('\n')).toContain('substrate reported disabled');
  });

  it('on + no booted → exit 0 + idle hint (always-on substrate, nothing shared)', () => {
    const r = formatSubstrateStatus({ enabled: true, bootedCount: 0 });
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toContain('✓ ON');
    expect(r.lines.join('\n')).toContain('no shared harnesses booted');
  });

  it('singular "harness" for booted=1', () => {
    const r = formatSubstrateStatus({ enabled: true, bootedCount: 1 });
    expect(r.lines[0]).toContain('1 harness');
    expect(r.lines[0]).not.toContain('1 harnesses');
  });

  it('plural for booted > 1', () => {
    const r = formatSubstrateStatus({ enabled: true, bootedCount: 3 });
    expect(r.lines[0]).toContain('3 harnesses');
  });

  it('all healthy → exit 0 + table', () => {
    const r = formatSubstrateStatus({
      enabled: true,
      bootedCount: 2,
      summary: summary({
        totalHarnesses: 2,
        healthy: 2,
        worstVerdict: 'healthy',
      }),
      harnesses: [
        {
          workspaceId: 'ws-1',
          harnessSlug: 'a',
          verdict: 'healthy',
        },
        {
          workspaceId: 'ws-1',
          harnessSlug: 'b',
          verdict: 'healthy',
        },
      ],
    });
    expect(r.exitCode).toBe(0);
    const text = r.lines.join('\n');
    expect(text).toContain('Workspace summary: healthy');
    expect(text).toContain('2✓');
    expect(text).toMatch(/ws-1\s+a\s+✓ healthy/);
  });

  it('any degraded → exit 1', () => {
    const r = formatSubstrateStatus({
      enabled: true,
      bootedCount: 2,
      summary: summary({
        totalHarnesses: 2,
        healthy: 1,
        degraded: 1,
        worstVerdict: 'degraded',
      }),
      harnesses: [
        { workspaceId: 'ws-1', harnessSlug: 'a', verdict: 'healthy' },
        {
          workspaceId: 'ws-1',
          harnessSlug: 'b',
          verdict: 'degraded',
          reasons: ['claim error rate 10%'],
        },
      ],
    });
    expect(r.exitCode).toBe(1);
    const text = r.lines.join('\n');
    expect(text).toContain('Workspace summary: degraded');
    expect(text).toContain('claim error rate 10%');
  });

  it('unhealthy verdicts contribute exit 1', () => {
    const r = formatSubstrateStatus({
      enabled: true,
      bootedCount: 1,
      harnesses: [
        {
          workspaceId: 'ws-1',
          harnessSlug: 'a',
          verdict: 'unhealthy',
          reasons: ['boom'],
        },
      ],
    });
    expect(r.exitCode).toBe(1);
  });

  it('booting verdict also contributes exit 1', () => {
    const r = formatSubstrateStatus({
      enabled: true,
      bootedCount: 1,
      harnesses: [
        { workspaceId: 'ws-1', harnessSlug: 'a', verdict: 'booting' },
      ],
    });
    expect(r.exitCode).toBe(1);
  });

  it('reasons only print for non-healthy rows', () => {
    const r = formatSubstrateStatus({
      enabled: true,
      bootedCount: 1,
      harnesses: [
        {
          workspaceId: 'ws-1',
          harnessSlug: 'a',
          verdict: 'healthy',
          reasons: ['should-not-print'],
        },
      ],
    });
    expect(r.lines.join('\n')).not.toContain('should-not-print');
  });

  it('verdict mark mapping', () => {
    const r = formatSubstrateStatus({
      enabled: true,
      bootedCount: 4,
      harnesses: [
        { workspaceId: 'w', harnessSlug: 'h-healthy', verdict: 'healthy' },
        { workspaceId: 'w', harnessSlug: 'h-booting', verdict: 'booting' },
        { workspaceId: 'w', harnessSlug: 'h-degraded', verdict: 'degraded' },
        { workspaceId: 'w', harnessSlug: 'h-unhealthy', verdict: 'unhealthy' },
      ],
    });
    const text = r.lines.join('\n');
    expect(text).toMatch(/h-healthy\s+✓ healthy/);
    expect(text).toMatch(/h-booting\s+⏳ booting/);
    expect(text).toMatch(/h-degraded\s+! degraded/);
    expect(text).toMatch(/h-unhealthy\s+✗ unhealthy/);
  });

  it('summary segments use dash when all counts zero', () => {
    const r = formatSubstrateStatus({
      enabled: true,
      bootedCount: 1,
      summary: summary({ totalHarnesses: 0 }),
      harnesses: [],
    });
    expect(r.lines.join('\n')).toContain('—');
  });
});
