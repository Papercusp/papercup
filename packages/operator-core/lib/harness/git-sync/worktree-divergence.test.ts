import { describe, expect, it } from 'vitest';
import {
  DIVERGENCE_REFRESH_MS,
  describeDivergenceTransition,
  nextWorktreeDivergence,
  parseWorktreeDivergence,
  type WorktreeDivergence,
} from './worktree-divergence';

// WI-10006476 / plan agent-capacity-and-cost-gcp-2026-09-30 D-055. S6 (P-525) ran
// 55+ min with a joiner and the tower forked on a content conflict and nothing
// recorded it. These pin the rules that make that fork a visible, persisted state.

const T0 = 1_791_000_000_000;
const L1 = 'a'.repeat(40);
const L2 = 'b'.repeat(40);
const H1 = 'c'.repeat(40);
const H2 = 'd'.repeat(40);

const conflict = (paths: string[], localHead = L1, hiveSha = H1) =>
  ({ kind: 'diverged', localHead, hiveSha, paths }) as const;

const prior = (over: Partial<WorktreeDivergence> = {}): WorktreeDivergence => ({
  since: T0,
  lastSeenAt: T0,
  localHead: L1,
  hiveSha: H1,
  paths: ['soak-heartbeat.txt'],
  ...over,
});

describe('nextWorktreeDivergence (D-055)', () => {
  it('a conflicting divergence with no prior state STARTS: persisted, logged, paths sorted', () => {
    const t = nextWorktreeDivergence(null, conflict(['z.txt', 'a.txt']), T0);
    expect(t).toEqual({
      next: { since: T0, lastSeenAt: T0, localHead: L1, hiveSha: H1, paths: ['a.txt', 'z.txt'] },
      log: 'started',
      write: true,
    });
  });

  it('a CLEAN divergence is not recorded (the integrator merges it itself)', () => {
    expect(nextWorktreeDivergence(null, conflict([]), T0)).toEqual({ next: null, log: null, write: false });
  });

  it('a clean divergence or containment CLEARS a recorded conflict', () => {
    expect(nextWorktreeDivergence(prior(), conflict([]), T0 + 1)).toEqual({ next: null, log: 'cleared', write: true });
    expect(nextWorktreeDivergence(prior(), { kind: 'contained' }, T0 + 1)).toEqual({
      next: null,
      log: 'cleared',
      write: true,
    });
  });

  it('steady containment is free: no write, no log', () => {
    expect(nextWorktreeDivergence(null, { kind: 'contained' }, T0)).toEqual({ next: null, log: null, write: false });
  });

  it('an unknown tick or a failed probe keeps the prior state untouched (never clears on no evidence)', () => {
    const p = prior();
    expect(nextWorktreeDivergence(p, { kind: 'unknown' }, T0 + 99)).toEqual({ next: p, log: null, write: false });
    expect(nextWorktreeDivergence(p, conflict(null as unknown as string[]), T0 + 99)).toEqual({
      next: p,
      log: null,
      write: false,
    });
  });

  it('a persisting conflict keeps `since` while both heads move, and writes without re-logging', () => {
    const t = nextWorktreeDivergence(prior(), conflict(['soak-heartbeat.txt'], L2, H2), T0 + 60_000);
    expect(t.log).toBeNull();
    expect(t.write).toBe(true);
    expect(t.next).toEqual({ since: T0, lastSeenAt: T0 + 60_000, localHead: L2, hiveSha: H2, paths: ['soak-heartbeat.txt'] });
  });

  it('a changed conflicting path set is logged again', () => {
    const t = nextWorktreeDivergence(prior(), conflict(['soak-heartbeat.txt', 'b.txt']), T0 + 1);
    expect(t.log).toBe('paths-changed');
    expect(t.next?.since).toBe(T0);
  });

  it('identical observations write only once per refresh window', () => {
    expect(nextWorktreeDivergence(prior(), conflict(['soak-heartbeat.txt']), T0 + 1).write).toBe(false);
    const late = nextWorktreeDivergence(prior(), conflict(['soak-heartbeat.txt']), T0 + DIVERGENCE_REFRESH_MS);
    expect(late.write).toBe(true);
    expect(late.next?.lastSeenAt).toBe(T0 + DIVERGENCE_REFRESH_MS);
  });
});

describe('parseWorktreeDivergence', () => {
  it('round-trips a persisted value and rejects malformed or empty-path rows', () => {
    expect(parseWorktreeDivergence(JSON.parse(JSON.stringify(prior())))).toEqual(prior());
    expect(parseWorktreeDivergence(null)).toBeNull();
    expect(parseWorktreeDivergence({ ...prior(), paths: [] })).toBeNull();
    expect(parseWorktreeDivergence({ ...prior(), since: 'yesterday' })).toBeNull();
  });
});

describe('describeDivergenceTransition', () => {
  it('names the slug, both heads, the paths and the decision; silent when nothing is logged', () => {
    const t = nextWorktreeDivergence(null, conflict(['soak-heartbeat.txt']), T0);
    const line = describeDivergenceTransition('hello-world-3-pot', null, t, T0) ?? '';
    expect(line).toContain('hello-world-3-pot');
    expect(line).toContain('DIVERGED');
    expect(line).toContain(H1.slice(0, 12));
    expect(line).toContain(L1.slice(0, 12));
    expect(line).toContain('soak-heartbeat.txt');
    expect(line).toContain('D-055');
    expect(describeDivergenceTransition('s', null, { next: null, log: null, write: false }, T0)).toBeNull();
  });

  it('a cleared divergence reports how long the fork lasted', () => {
    const p = prior();
    const t = nextWorktreeDivergence(p, { kind: 'contained' }, T0 + 55 * 60_000);
    expect(describeDivergenceTransition('s', p, t, T0 + 55 * 60_000)).toContain('CLEARED after ~55m');
  });
});
