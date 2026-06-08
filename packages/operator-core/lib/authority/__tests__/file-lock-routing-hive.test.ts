/**
 * file-lock-routing — Hive-aware file-claim routing (shared-hive-federation P-009).
 * A Hive member's file-locks serialize at the HIVE authority; non-members stay
 * harness-scoped (unchanged). Pure/seamed — injected resolvers + presence, no PG.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { routeFileLockOp } from '../file-lock-routing';
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
