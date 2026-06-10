/**
 * ship-link.test.ts — hive-loop-e2e-testing-2026-06-10 P-011.
 *
 * Pure half: the lag decision (up-to-date / fresh-gap / stale-gap). Git half:
 * readShipLinkState against a REAL throwaway repo with a staging branch ahead
 * of main (backdated commits), plus the collector's off-host + bad-repo skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shipLinkSignalsFromState,
  readShipLinkState,
  collectShipLinkSignals,
} from './ship-link';

const HOUR = 3_600_000;

describe('shipLinkSignalsFromState (pure)', () => {
  it('main up to date → silent', () => {
    expect(shipLinkSignalsFromState({ oldestUnshippedSec: null, behindCount: 0 })).toEqual([]);
  });

  it('a fresh gap (inside the lag bar) → silent — the hourly checkpoint owns it', () => {
    const now = Date.now();
    const state = { oldestUnshippedSec: Math.floor((now - 2 * HOUR) / 1000), behindCount: 7 };
    expect(shipLinkSignalsFromState(state, { maxLagHours: 6, nowMs: now })).toEqual([]);
  });

  it('a stale gap fires ONE major signal naming the refs, age, and depth', () => {
    const now = Date.now();
    const state = { oldestUnshippedSec: Math.floor((now - 9 * HOUR) / 1000), behindCount: 12 };
    const signals = shipLinkSignalsFromState(state, { maxLagHours: 6, nowMs: now });
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('ship-link-stuck');
    expect(signals[0].key).toBe('staging->main');
    expect(signals[0].severity).toBe('major');
    expect(signals[0].body).toContain('~9h old');
    expect(signals[0].body).toContain('12 commit(s) behind');
  });
});

describe('readShipLinkState + collectShipLinkSignals (real git)', () => {
  let repo: string;
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'ship-link-'));
    execFileSync('git', ['init', '-b', 'main', repo]);
    g('config', 'user.email', 'test@test');
    g('config', 'user.name', 'test');
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    g('add', '.');
    g('commit', '-m', 'base');
    // staging diverges ahead with two commits, the older one backdated 10h.
    g('checkout', '-b', 'staging');
    writeFileSync(join(repo, 'a.txt'), 'landed work\n');
    g('add', '.');
    const old = new Date(Date.now() - 10 * HOUR).toISOString();
    execFileSync('git', ['-C', repo, 'commit', '-m', 'old landed work'], {
      env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old },
    });
    writeFileSync(join(repo, 'a.txt'), 'newer work\n');
    g('add', '.');
    g('commit', '-m', 'newer work');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    delete process.env.PAPERCUSP_INTEGRATION_ROOT;
  });

  it('reads the oldest unshipped commit + behind count from the main..staging range', async () => {
    const state = await readShipLinkState(repo, 'main', 'staging');
    expect(state.behindCount).toBe(2);
    const ageHours = (Date.now() - state.oldestUnshippedSec! * 1000) / HOUR;
    expect(ageHours).toBeGreaterThan(9);
    expect(ageHours).toBeLessThan(11);
  });

  it('the collector fires on this repo through the env wiring', async () => {
    process.env.PAPERCUSP_INTEGRATION_ROOT = repo;
    const res = await collectShipLinkSignals({ maxLagHours: 6 });
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0].source).toBe('ship-link-stuck');
  });

  it('after main fast-forwards to staging (the green-checkpoint advance), the signal clears', async () => {
    g('checkout', 'main');
    g('merge', '--ff-only', 'staging');
    g('checkout', 'staging');
    const state = await readShipLinkState(repo, 'main', 'staging');
    expect(state).toEqual({ oldestUnshippedSec: null, behindCount: 0 });
    process.env.PAPERCUSP_INTEGRATION_ROOT = repo;
    expect((await collectShipLinkSignals({ maxLagHours: 6 })).signals).toEqual([]);
  });

  it('skips with a note off the release host (env unset) and on a bad repo — never noise', async () => {
    delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    const off = await collectShipLinkSignals();
    expect(off.signals).toEqual([]);
    expect(off.note).toContain('PAPERCUSP_INTEGRATION_ROOT unset');

    process.env.PAPERCUSP_INTEGRATION_ROOT = '/nonexistent/not-a-repo';
    const bad = await collectShipLinkSignals();
    expect(bad.signals).toEqual([]);
    expect(bad.note).toContain('git read failed');
  });
});
