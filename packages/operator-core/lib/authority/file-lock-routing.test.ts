/**
 * file-lock-routing.test.ts — the file-claim → lock-authority router.
 *
 * Reliability-critical: file-claim locks serialize concurrent edits to the SHARED repo across
 * machines; mis-routing them risks concurrent corruption. The D-009 scope guard (only managed,
 * federated checkouts route to an authority; everything else runs LOCAL) and the hot-path guard
 * (a box with no live remote peers stays purely local) are the two safety properties pinned here.
 * All deps are injected; the module-global resolvers + remote-peers cache are reset between tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  routeFileLockOp,
  configureFileLockDomainResolver,
  getDomainToHarnessSlug,
  configureFileLockHiveResolver,
  getHarnessToHiveSlug,
  _testing,
  type FileLockRoutingDeps,
} from './file-lock-routing';
import { __resetRemotePeersCacheForTests } from './remote-peers-cache';
import type { AuthorityOp } from './lock-authority';

/** An AuthorityOp whose local() returns `value` and counts its calls. No remote envelope ⇒ a
 *  remote authority would fail open to local (D-004). */
function op<T>(value: T) {
  const o = { localCalls: 0, local: async () => { o.localCalls++; return value; } };
  return o as AuthorityOp<T> & { localCalls: number };
}

beforeEach(() => __resetRemotePeersCacheForTests());
afterEach(() => {
  configureFileLockDomainResolver(null);
  configureFileLockHiveResolver(null);
  __resetRemotePeersCacheForTests();
});

describe('resolver seams default to local-only and are swappable', () => {
  it('the domain→harness resolver defaults to null (no federated harness → local)', () => {
    expect(getDomainToHarnessSlug()('/any/repo')).toBeNull();
    expect(_testing.defaultDomainToHarnessSlug('/any/repo')).toBeNull();
  });

  it('configureFileLockDomainResolver swaps it, and null restores the default', () => {
    configureFileLockDomainResolver((d) => (d === '/managed' ? 'harness-x' : null));
    expect(getDomainToHarnessSlug()('/managed')).toBe('harness-x');
    expect(getDomainToHarnessSlug()('/other')).toBeNull();
    configureFileLockDomainResolver(null);
    expect(getDomainToHarnessSlug()('/managed')).toBeNull();
  });

  it('the harness→hive resolver defaults to null (non-Hive → harness scope) and is swappable', () => {
    expect(getHarnessToHiveSlug()('harness-x')).toBeNull();
    configureFileLockHiveResolver((h) => (h === 'harness-x' ? 'hive-1' : null));
    expect(getHarnessToHiveSlug()('harness-x')).toBe('hive-1');
    configureFileLockHiveResolver(null);
    expect(getHarnessToHiveSlug()('harness-x')).toBeNull();
  });
});

describe('routeFileLockOp — D-009 scope guard + hot-path guard', () => {
  it('runs LOCALLY for an unmanaged domain (no federated harness)', async () => {
    const o = op('RESULT');
    const res = await routeFileLockOp('/unmanaged', o, { domainToHarnessSlug: () => null });
    expect(res).toEqual({ value: 'RESULT', via: 'local-authority' });
    expect(o.localCalls).toBe(1);
  });

  it('uses the registered resolver when deps omit an override', async () => {
    configureFileLockDomainResolver(() => null); // registry says: not a managed harness
    const o = op('R');
    const res = await routeFileLockOp('/repo', o, {});
    expect(res.via).toBe('local-authority');
    expect(o.localCalls).toBe(1);
  });

  it('a managed harness with NO live remote peers stays local (hot-path guard) and queries harness presence', async () => {
    const harnessFetch = vi.fn(async () => []);
    const hiveFetch = vi.fn(async () => []);
    const deps: FileLockRoutingDeps = {
      domainToHarnessSlug: () => 'harness-x',
      harnessToHiveSlug: () => null, // harness scope
      fetchPresenceRows: harnessFetch,
      fetchHivePresenceRows: hiveFetch,
      resolveSelf: async () => null,
      now: () => 1000,
    };
    const o = op('R');
    const res = await routeFileLockOp('/repo', o, deps);
    expect(res.via).toBe('local-authority');
    expect(o.localCalls).toBe(1);
    // P-006: presence fetch carries the (TS) staleMs window as a loose SQL pre-filter
    // (DEFAULT_AUTHORITY_STALE_MS). We assert the SCOPE (harness slug), not the tunable window.
    expect(harnessFetch).toHaveBeenCalledWith('harness-x', expect.any(Number)); // harness-scoped presence consulted
    expect(hiveFetch).not.toHaveBeenCalled();
  });

  it('a Hive-member harness routes at HIVE scope (consults hive presence) and stays local with no hive peers', async () => {
    const harnessFetch = vi.fn(async () => []);
    const hiveFetch = vi.fn(async () => []);
    const deps: FileLockRoutingDeps = {
      domainToHarnessSlug: () => 'harness-x',
      harnessToHiveSlug: () => 'hive-1', // hive scope
      fetchPresenceRows: harnessFetch,
      fetchHivePresenceRows: hiveFetch,
      resolveSelf: async () => null,
      now: () => 1000,
    };
    const o = op('R');
    const res = await routeFileLockOp('/repo', o, deps);
    expect(res.via).toBe('local-authority');
    expect(hiveFetch).toHaveBeenCalledWith('hive-1', expect.any(Number)); // hive-scoped presence consulted (P-006 staleMs window)
    expect(harnessFetch).not.toHaveBeenCalled();
  });
});
