/**
 * summariseWorkspaceSubstrate tests.
 */

import { describe, expect, it } from 'vitest';
import { summariseWorkspaceSubstrate } from '../summary';

describe('summariseWorkspaceSubstrate', () => {
  it('flag off + no rows → disabled summary', () => {
    const s = summariseWorkspaceSubstrate(false, []);
    expect(s).toEqual({
      enabled: false,
      totalHarnesses: 0,
      healthy: 0,
      booting: 0,
      degraded: 0,
      unhealthy: 0,
      disabled: 0,
      worstVerdict: 'disabled',
    });
  });

  it('flag on + no rows → healthy summary (idle — nothing wrong, nothing booted)', () => {
    const s = summariseWorkspaceSubstrate(true, []);
    expect(s.worstVerdict).toBe('healthy');
    expect(s.totalHarnesses).toBe(0);
  });

  it('all healthy → healthy summary', () => {
    const s = summariseWorkspaceSubstrate(true, [
      { workspaceId: 'ws-1', harnessSlug: 'a', verdict: 'healthy' },
      { workspaceId: 'ws-1', harnessSlug: 'b', verdict: 'healthy' },
    ]);
    expect(s.worstVerdict).toBe('healthy');
    expect(s.healthy).toBe(2);
    expect(s.degraded).toBe(0);
  });

  it('worst-wins: one unhealthy among healthy rows', () => {
    const s = summariseWorkspaceSubstrate(true, [
      { workspaceId: 'ws-1', harnessSlug: 'a', verdict: 'healthy' },
      { workspaceId: 'ws-1', harnessSlug: 'b', verdict: 'unhealthy' },
      { workspaceId: 'ws-1', harnessSlug: 'c', verdict: 'healthy' },
    ]);
    expect(s.worstVerdict).toBe('unhealthy');
    expect(s.healthy).toBe(2);
    expect(s.unhealthy).toBe(1);
  });

  it('degraded beats booting and healthy', () => {
    const s = summariseWorkspaceSubstrate(true, [
      { workspaceId: 'ws-1', harnessSlug: 'a', verdict: 'healthy' },
      { workspaceId: 'ws-1', harnessSlug: 'b', verdict: 'degraded' },
      { workspaceId: 'ws-1', harnessSlug: 'c', verdict: 'booting' },
    ]);
    expect(s.worstVerdict).toBe('degraded');
  });

  it('unhealthy beats degraded', () => {
    const s = summariseWorkspaceSubstrate(true, [
      { workspaceId: 'ws-1', harnessSlug: 'a', verdict: 'degraded' },
      { workspaceId: 'ws-1', harnessSlug: 'b', verdict: 'unhealthy' },
    ]);
    expect(s.worstVerdict).toBe('unhealthy');
  });

  it('booting beats healthy', () => {
    const s = summariseWorkspaceSubstrate(true, [
      { workspaceId: 'ws-1', harnessSlug: 'a', verdict: 'healthy' },
      { workspaceId: 'ws-1', harnessSlug: 'b', verdict: 'booting' },
    ]);
    expect(s.worstVerdict).toBe('booting');
  });

  it('counts each verdict independently', () => {
    const s = summariseWorkspaceSubstrate(true, [
      { workspaceId: 'ws-1', harnessSlug: 'a', verdict: 'healthy' },
      { workspaceId: 'ws-1', harnessSlug: 'b', verdict: 'healthy' },
      { workspaceId: 'ws-1', harnessSlug: 'c', verdict: 'degraded' },
      { workspaceId: 'ws-1', harnessSlug: 'd', verdict: 'unhealthy' },
      { workspaceId: 'ws-1', harnessSlug: 'e', verdict: 'booting' },
    ]);
    expect(s.healthy).toBe(2);
    expect(s.degraded).toBe(1);
    expect(s.unhealthy).toBe(1);
    expect(s.booting).toBe(1);
    expect(s.totalHarnesses).toBe(5);
  });

  it('flag off + mixed rows still summarizes by worst-rank', () => {
    // Edge case — if rows exist with flag off (snapshot mismatch),
    // worst still ranks within the input, not flag-driven.
    const s = summariseWorkspaceSubstrate(false, [
      { workspaceId: 'ws-1', harnessSlug: 'a', verdict: 'healthy' },
      { workspaceId: 'ws-1', harnessSlug: 'b', verdict: 'degraded' },
    ]);
    expect(s.worstVerdict).toBe('degraded');
    expect(s.enabled).toBe(false);
  });
});
