/**
 * file-lock-routing — Hive-aware file-claim routing (shared-hive-federation P-009).
 * A Hive member's file-locks serialize at the HIVE authority; non-members stay
 * harness-scoped (unchanged). Pure/seamed — injected resolvers + presence, no PG.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  routeFileLockOp,
  configureFileLockDomainResolver,
  getDomainToHarnessSlug,
  configureFileLockHiveResolver,
  getHarnessToHiveSlug,
} from '../file-lock-routing';
import { __resetRemotePeersCacheForTests } from '../remote-peers-cache';

const NOW = 1_000_000_000_000;
const row = (pk: string) => ({ device_pubkey: pk, github_user_id: 1, machine_label: pk, last_seen_ms: NOW });

beforeEach(() => __resetRemotePeersCacheForTests());

// Force authority resolution (bypass the no-remote-peers fast-path) for the routing tests.
const forced = {
  domainToHarnessSlug: () => 'repo-a',
  now: () => NOW,
  skipRemotePeersFastPath: true,
};

describe('routeFileLockOp — Hive-aware (P-009)', () => {
  it('routes a Hive member to the HIVE authority — local when we are the Hive authority', async () => {
    let ran = false;
    const r = await routeFileLockOp(
      '/repo',
      { local: async () => { ran = true; return 1; } },
      {
        ...forced,
        harnessToHiveSlug: () => 'my-hive',
        fetchHivePresenceRows: async (h) => { expect(h).toBe('my-hive'); return []; },
        resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'aaa' }),
      },
    );
    expect(ran).toBe(true);
    expect(r.via).toBe('local-authority');
  });

  it('routes a Hive member to the HIVE authority — fail-open when a remote Swarm is the authority', async () => {
    const r = await routeFileLockOp(
      '/repo',
      { local: async () => 2 },
      {
        ...forced,
        harnessToHiveSlug: () => 'my-hive',
        fetchHivePresenceRows: async () => [row('aaa')], // remote aaa < self zzz
        resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'zzz' }),
      },
    );
    expect(r.via).toBe('fail-open');
    expect(r.value).toBe(2);
    expect(r.warning).toMatch(/hive "my-hive"/);
  });

  it('routes a NON-Hive harness to the HARNESS authority (unchanged behavior)', async () => {
    const r = await routeFileLockOp(
      '/repo',
      { local: async () => 3 },
      {
        ...forced,
        harnessToHiveSlug: () => null,
        fetchPresenceRows: async (h) => { expect(h).toBe('repo-a'); return [row('aaa')]; },
        resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'zzz' }),
      },
    );
    expect(r.via).toBe('fail-open');
    expect(r.warning).toMatch(/harness "repo-a"/);
  });

  it('fast-path: a Hive with no remote Swarms runs locally (no authority query)', async () => {
    let ran = false;
    const r = await routeFileLockOp(
      '/repo',
      { local: async () => { ran = true; return 4; } },
      {
        domainToHarnessSlug: () => 'repo-a',
        harnessToHiveSlug: () => 'my-hive',
        now: () => NOW,
        fetchHivePresenceRows: async () => [], // self-alone → no remote peers
        resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'aaa' }),
      },
    );
    expect(ran).toBe(true);
    expect(r.via).toBe('local-authority');
  });

  it('unknown domain → local (no federated scope)', async () => {
    const r = await routeFileLockOp('/x', { local: async () => 5 }, { domainToHarnessSlug: () => null });
    expect(r).toMatchObject({ via: 'local-authority', value: 5 });
  });
});

// ── Global resolver seam + defaults (depth pass, su-7f3e0376) ────────────────
// The tests above inject resolvers via deps; the module-GLOBAL resolvers (the
// boot-wiring seam) + their local-only DEFAULTS were untested. The default-null
// domain resolver is the single-box safety guarantee — if it were non-null, every
// op on an unmanaged checkout would wrongly try to route to a remote authority.
describe('routeFileLockOp — global resolver seam + defaults', () => {
  afterEach(() => {
    configureFileLockDomainResolver(null);
    configureFileLockHiveResolver(null);
  });

  it('the global domain resolver defaults to null (local-only) and is install/reset-able', () => {
    expect(getDomainToHarnessSlug()('/any')).toBeNull(); // default → no federated harness → local
    configureFileLockDomainResolver((d) => (d === '/repo' ? 'repo-a' : null));
    expect(getDomainToHarnessSlug()('/repo')).toBe('repo-a');
    expect(getDomainToHarnessSlug()('/other')).toBeNull();
    configureFileLockDomainResolver(null);
    expect(getDomainToHarnessSlug()('/repo')).toBeNull(); // reset → back to the local-only default
  });

  it('the global hive resolver defaults to null (harness scope) and is install/reset-able', () => {
    expect(getHarnessToHiveSlug()('repo-a')).toBeNull();
    configureFileLockHiveResolver((h) => (h === 'repo-a' ? 'my-hive' : null));
    expect(getHarnessToHiveSlug()('repo-a')).toBe('my-hive');
    configureFileLockHiveResolver(null);
    expect(getHarnessToHiveSlug()('repo-a')).toBeNull();
  });

  it('routeFileLockOp falls back to the GLOBAL domain resolver when deps has no override (default null → local)', async () => {
    let ran = false;
    const r = await routeFileLockOp('/repo', { local: async () => { ran = true; return 7; } }, { now: () => NOW });
    expect(ran).toBe(true); // no global resolver + no deps override → unmanaged → local
    expect(r).toMatchObject({ via: 'local-authority', value: 7 });
  });

  it('routeFileLockOp routes through a GLOBALLY-installed domain resolver (no deps override)', async () => {
    configureFileLockDomainResolver(() => 'repo-a'); // boot-wired mapping
    const r = await routeFileLockOp(
      '/repo',
      { local: async () => 8 },
      {
        now: () => NOW,
        skipRemotePeersFastPath: true,
        harnessToHiveSlug: () => null,
        fetchPresenceRows: async (h) => { expect(h).toBe('repo-a'); return [row('aaa')]; },
        resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'zzz' }),
      },
    );
    expect(r.via).toBe('fail-open'); // global resolver mapped /repo → repo-a → routed to the (remote) authority
  });
});
