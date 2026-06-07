import { describe, it, expect, afterEach } from 'vitest';
import {
  createDisplayPool,
  displayPoolFromEnv,
  agentDisplayPool,
  acquireAgentDisplay,
  _resetDisplayPoolForTests,
} from './display-allocator';

afterEach(() => {
  _resetDisplayPoolForTests();
  delete process.env.PAPERCUSP_DESKTOP_DISPLAYS;
  delete process.env.PAPERCUSP_DESKTOP_DISPLAY_BASE;
  delete process.env.PAPERCUSP_DESKTOP_STATE_DIR;
});

describe('createDisplayPool', () => {
  it('leases the lowest free display, formatted as :N', () => {
    const pool = createDisplayPool(99, 2);
    const a = pool.acquire();
    expect(a?.display).toBe(':99');
    expect(a?.number).toBe(99);
    const b = pool.acquire();
    expect(b?.display).toBe(':100');
  });

  it('exhausted pool returns undefined (spawn proceeds headless)', () => {
    const pool = createDisplayPool(99, 1);
    expect(pool.acquire()).toBeDefined();
    expect(pool.acquire()).toBeUndefined();
  });

  it('release returns the display; re-acquire reuses the lowest free', () => {
    const pool = createDisplayPool(99, 2);
    const a = pool.acquire()!;
    pool.acquire();
    a.release();
    expect(pool.leased()).toEqual([100]);
    expect(pool.acquire()?.display).toBe(':99');
  });

  it('release is idempotent (double-release cannot free a re-leased display)', () => {
    const pool = createDisplayPool(99, 1);
    const a = pool.acquire()!;
    a.release();
    const b = pool.acquire()!;
    a.release(); // stale double-release — must NOT free b's display
    expect(pool.leased()).toEqual([99]);
    b.release();
    expect(pool.leased()).toEqual([]);
  });

  it('leased() reports ascending numbers', () => {
    const pool = createDisplayPool(99, 3);
    pool.acquire();
    pool.acquire();
    expect(pool.leased()).toEqual([99, 100]);
  });
});

describe('displayPoolFromEnv', () => {
  it('no env → undefined (not a desktop frame)', () => {
    expect(displayPoolFromEnv({})).toBeUndefined();
  });

  it('zero / garbage counts → undefined', () => {
    expect(displayPoolFromEnv({ PAPERCUSP_DESKTOP_DISPLAYS: '0' })).toBeUndefined();
    expect(displayPoolFromEnv({ PAPERCUSP_DESKTOP_DISPLAYS: 'nope' })).toBeUndefined();
  });

  it('reads count + base from the bootstrap-advertised env', () => {
    const pool = displayPoolFromEnv({
      PAPERCUSP_DESKTOP_DISPLAYS: '2',
      PAPERCUSP_DESKTOP_DISPLAY_BASE: '50',
    })!;
    expect(pool.base).toBe(50);
    expect(pool.size).toBe(2);
    expect(pool.acquire()?.display).toBe(':50');
  });

  it('base defaults to 99', () => {
    const pool = displayPoolFromEnv({ PAPERCUSP_DESKTOP_DISPLAYS: '1' })!;
    expect(pool.base).toBe(99);
  });
});

describe('lease metadata + snapshot', () => {
  it('acquire records role + since; leases() reports them', () => {
    const pool = createDisplayPool(99, 2);
    pool.acquire({ role: 'worker' });
    const leases = pool.leases();
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ number: 99, role: 'worker' });
    expect(leases[0].sinceMs).toBeGreaterThan(0);
  });

  it('onChange fires on acquire and release with the current lease set', () => {
    const seen: number[][] = [];
    const pool = createDisplayPool(99, 2, (l) => seen.push(l.map((x) => x.number)));
    const a = pool.acquire()!;
    pool.acquire();
    a.release();
    expect(seen).toEqual([[99], [99, 100], [100]]);
  });

  it('singleton writes the lease snapshot to PAPERCUSP_DESKTOP_STATE_DIR', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'pc-displays-'));
    process.env.PAPERCUSP_DESKTOP_DISPLAYS = '2';
    process.env.PAPERCUSP_DESKTOP_STATE_DIR = dir;
    _resetDisplayPoolForTests();
    const lease = acquireAgentDisplay({ role: 'validator' })!;
    const snap = JSON.parse(readFileSync(join(dir, 'leases.json'), 'utf8'));
    expect(snap.leases).toHaveLength(1);
    expect(snap.leases[0]).toMatchObject({ number: 99, role: 'validator' });
    lease.release();
    const after = JSON.parse(readFileSync(join(dir, 'leases.json'), 'utf8'));
    expect(after.leases).toEqual([]);
  });
});

describe('process-wide singleton', () => {
  it('acquireAgentDisplay is a no-op off-frame', () => {
    expect(acquireAgentDisplay()).toBeUndefined();
  });

  it('memoizes the pool from process env', () => {
    process.env.PAPERCUSP_DESKTOP_DISPLAYS = '2';
    process.env.PAPERCUSP_DESKTOP_STATE_DIR = '/tmp/pc-displays-singleton-test';
    _resetDisplayPoolForTests();
    const lease = acquireAgentDisplay();
    expect(lease?.display).toBe(':99');
    // same singleton: second acquire takes :100
    expect(agentDisplayPool()?.acquire()?.display).toBe(':100');
    lease?.release();
  });
});
