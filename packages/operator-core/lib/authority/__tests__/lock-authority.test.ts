/**
 * Unit tests for the per-harness lock authority (Track B).
 *
 * Pure: every dependency (presence rows, self identity, clock, transport) is
 * injected, so the selection logic — argmin / isSelf / empty-set / staleness
 * failover — and the routing/fail-open behavior run with no PG and no booted
 * operator.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lockAuthorityFor,
  selectAuthorityFromRows,
  routeToAuthority,
  DEFAULT_AUTHORITY_STALE_MS,
  type LockAuthorityDeps,
  type PeerRef,
} from '../lock-authority';
import {
  setPeerRpcTransport,
  __resetPeerRpcTransportForTests,
  PeerUnreachableError,
  type PeerRpcTransport,
} from '../peer-rpc-transport';
import { routeFileLockOp } from '../file-lock-routing';
import { __resetRemotePeersCacheForTests } from '../remote-peers-cache';

const NOW = 1_000_000_000_000;

function deps(over: Partial<LockAuthorityDeps> & {
  rows?: Array<{ device_pubkey: string; github_user_id: number; machine_label: string; last_seen_ms: number }>;
  self?: { githubUserId: number; devicePubkey: string } | null;
} = {}): LockAuthorityDeps {
  return {
    now: () => NOW,
    fetchPresenceRows: async () => over.rows ?? [],
    resolveSelf: async () => (over.self === undefined ? null : over.self),
    staleMs: over.staleMs,
  };
}

afterEach(() => {
  __resetPeerRpcTransportForTests();
  __resetRemotePeersCacheForTests();
  vi.restoreAllMocks();
});

// ── Direct selection branches (depth pass, su-7f3e0376) ──────────────────────
describe('selectAuthorityFromRows — direct selection branches', () => {
  const r = (pk: string, lastSeen: number) => ({ device_pubkey: pk, github_user_id: 1, machine_label: pk, last_seen_ms: lastSeen });

  it('a row with an empty device_pubkey is never a candidate (a junk row must not win argmin)', () => {
    // '' sorts lexicographically FIRST — it would win argmin and hijack authority if not filtered.
    const res = selectAuthorityFromRows([r('', NOW), r('peer-b', NOW)], null, NOW, 90_000);
    expect(res.isSelf).toBe(false);
    expect(res.peer?.devicePubkey).toBe('peer-b');
    expect(res.liveCount).toBe(1);
  });

  it('the staleness cutoff is STRICT — a row exactly at the cutoff is stale; one ms newer is live', () => {
    const staleMs = 90_000;
    const cutoff = NOW - staleMs;
    // peer-a is the LOWER pubkey but sits exactly at the cutoff → dropped; peer-b (1ms newer) wins.
    const res = selectAuthorityFromRows([r('peer-a', cutoff), r('peer-b', cutoff + 1)], null, NOW, staleMs);
    expect(res.peer?.devicePubkey).toBe('peer-b');
    expect(res.liveCount).toBe(1);
  });

  it('liveCount counts every live candidate (self + remotes); an excluded peer is not counted', () => {
    const self = { githubUserId: 9, devicePubkey: 'zzz-self' };
    const res = selectAuthorityFromRows([r('aaa', NOW), r('mmm', NOW)], self, NOW, 90_000, new Set(['aaa']));
    // aaa excluded → candidates = {mmm, zzz-self}; argmin = mmm → a remote authority, not self.
    expect(res.isSelf).toBe(false);
    expect(res.peer?.devicePubkey).toBe('mmm');
    expect(res.liveCount).toBe(2);
  });
});

describe('lockAuthorityFor — selection', () => {
  it('single box (no peers, no self identity) → isSelf, liveCount 0', async () => {
    const r = await lockAuthorityFor('h', deps({ rows: [], self: null }));
    expect(r).toEqual({ isSelf: true, liveCount: 0 });
  });

  it('self only (no remote peers) → isSelf', async () => {
    const r = await lockAuthorityFor('h', deps({ rows: [], self: { githubUserId: 7, devicePubkey: 'kZZZ' } }));
    expect(r.isSelf).toBe(true);
    expect(r.liveCount).toBe(1);
  });

  it('self is the lowest pubkey among live peers → isSelf', async () => {
    const r = await lockAuthorityFor(
      'h',
      deps({
        self: { githubUserId: 1, devicePubkey: 'aaa' },
        rows: [
          { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: NOW - 1000 },
          { device_pubkey: 'mmm', github_user_id: 2, machine_label: 'm2', last_seen_ms: NOW - 1000 },
          { device_pubkey: 'zzz', github_user_id: 3, machine_label: 'm3', last_seen_ms: NOW - 1000 },
        ],
      }),
    );
    expect(r.isSelf).toBe(true);
    expect(r.liveCount).toBe(3);
  });

  it('self is NOT the lowest → isSelf false, peer = argmin', async () => {
    const r = await lockAuthorityFor(
      'h',
      deps({
        self: { githubUserId: 2, devicePubkey: 'mmm' },
        rows: [
          { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: NOW - 1000 },
          { device_pubkey: 'mmm', github_user_id: 2, machine_label: 'm2', last_seen_ms: NOW - 1000 },
        ],
      }),
    );
    expect(r.isSelf).toBe(false);
    expect(r.peer).toEqual({ devicePubkey: 'aaa', githubUserId: 1, machineLabel: 'm1' });
  });

  it('self has no identity but remote peers exist → isSelf false, peer = min remote', async () => {
    const r = await lockAuthorityFor(
      'h',
      deps({
        self: null,
        rows: [
          { device_pubkey: 'ggg', github_user_id: 9, machine_label: 'mg', last_seen_ms: NOW - 1000 },
          { device_pubkey: 'bbb', github_user_id: 8, machine_label: 'mb', last_seen_ms: NOW - 1000 },
        ],
      }),
    );
    expect(r.isSelf).toBe(false);
    expect(r.peer?.devicePubkey).toBe('bbb');
  });

  it('dedups by pubkey, keeping the freshest row', async () => {
    const r = await lockAuthorityFor(
      'h',
      deps({
        self: null,
        rows: [
          { device_pubkey: 'bbb', github_user_id: 8, machine_label: 'old', last_seen_ms: NOW - 5000 },
          { device_pubkey: 'bbb', github_user_id: 8, machine_label: 'new', last_seen_ms: NOW - 100 },
        ],
      }),
    );
    expect(r.liveCount).toBe(1);
    expect(r.peer?.machineLabel).toBe('new');
  });
});

describe('lockAuthorityFor — staleness / failover (D-005)', () => {
  it('excludes peers outside the staleness window', async () => {
    const r = await lockAuthorityFor(
      'h',
      deps({
        self: { githubUserId: 2, devicePubkey: 'mmm' },
        staleMs: 10_000,
        rows: [
          // 'aaa' is stale (older than 10s) → excluded; 'mmm' (self) becomes min
          { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: NOW - 20_000 },
          { device_pubkey: 'mmm', github_user_id: 2, machine_label: 'm2', last_seen_ms: NOW - 1000 },
        ],
      }),
    );
    expect(r.isSelf).toBe(true);
    expect(r.liveCount).toBe(1);
  });

  it('failover: the current authority going stale promotes the next-lowest live peer', async () => {
    // self = 'mmm'. While 'aaa' is fresh, authority is 'aaa' (remote, not self).
    const fresh = await lockAuthorityFor(
      'h',
      deps({
        self: { githubUserId: 2, devicePubkey: 'mmm' },
        staleMs: 10_000,
        rows: [
          { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: NOW - 1000 },
          { device_pubkey: 'mmm', github_user_id: 2, machine_label: 'm2', last_seen_ms: NOW - 1000 },
        ],
      }),
    );
    expect(fresh.peer?.devicePubkey).toBe('aaa');
    expect(fresh.isSelf).toBe(false);

    // 'aaa' (the authority) heartbeat goes stale → self ('mmm') is now authority.
    const afterFail = await lockAuthorityFor(
      'h',
      deps({
        self: { githubUserId: 2, devicePubkey: 'mmm' },
        staleMs: 10_000,
        rows: [
          { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: NOW - 20_000 },
          { device_pubkey: 'mmm', github_user_id: 2, machine_label: 'm2', last_seen_ms: NOW - 1000 },
        ],
      }),
    );
    expect(afterFail.isSelf).toBe(true);
  });

  it('uses the documented default staleness window when none is given', () => {
    expect(DEFAULT_AUTHORITY_STALE_MS).toBe(90_000);
  });

  it('rejects an empty harness slug', async () => {
    await expect(lockAuthorityFor('', deps())).rejects.toThrow(/non-empty/);
  });
});

describe('routeToAuthority — routing + fail-open (D-004)', () => {
  it('we are the authority → runs local, via local-authority', async () => {
    const res = await routeToAuthority('h', { local: async () => 'L' }, deps({ self: null, rows: [] }));
    expect(res).toEqual({ value: 'L', via: 'local-authority' });
  });

  it('remote authority + no transport → fail-open, runs local with a warning', async () => {
    const res = await routeToAuthority(
      'h',
      { local: async () => 'L' },
      deps({ self: { githubUserId: 2, devicePubkey: 'mmm' }, rows: [
        { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: NOW - 1000 },
        { device_pubkey: 'mmm', github_user_id: 2, machine_label: 'm2', last_seen_ms: NOW - 1000 },
      ] }),
    );
    expect(res.value).toBe('L');
    expect(res.via).toBe('fail-open');
    expect(res.warning).toMatch(/remote peer/);
    expect(res.warning).toMatch(/git-merged/);
  });

  it('remote authority + transport + remote envelope → via remote-authority, decodes the response', async () => {
    const seen: PeerRef[] = [];
    const transport: PeerRpcTransport = {
      async rpc(peer) {
        seen.push(peer);
        return { raw: 42 };
      },
    };
    setPeerRpcTransport(transport);
    const res = await routeToAuthority(
      'h',
      {
        local: async () => -1,
        remote: { kind: 'acquire', payload: { p: 'x' }, decode: (raw) => (raw as { raw: number }).raw },
      },
      deps({ self: { githubUserId: 2, devicePubkey: 'mmm' }, rows: [
        { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: NOW - 1000 },
        { device_pubkey: 'mmm', github_user_id: 2, machine_label: 'm2', last_seen_ms: NOW - 1000 },
      ] }),
    );
    expect(res).toEqual({ value: 42, via: 'remote-authority' });
    expect(seen[0]?.devicePubkey).toBe('aaa');
  });

  it('remote authority + transport throws PeerUnreachable → fail-open to local', async () => {
    setPeerRpcTransport({
      async rpc() {
        throw new PeerUnreachableError('down');
      },
    });
    const res = await routeToAuthority(
      'h',
      {
        local: async () => 'L',
        remote: { kind: 'acquire', payload: {}, decode: (raw) => raw as string },
      },
      deps({ self: { githubUserId: 2, devicePubkey: 'mmm' }, rows: [
        { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: NOW - 1000 },
        { device_pubkey: 'mmm', github_user_id: 2, machine_label: 'm2', last_seen_ms: NOW - 1000 },
      ] }),
    );
    expect(res.value).toBe('L');
    expect(res.via).toBe('fail-open');
  });

  it('remote authority + transport throws a NON-unreachable error → rethrows (not fail-open)', async () => {
    setPeerRpcTransport({
      async rpc() {
        throw new Error('protocol bug');
      },
    });
    await expect(
      routeToAuthority(
        'h',
        { local: async () => 'L', remote: { kind: 'acquire', payload: {}, decode: (raw) => raw as string } },
        deps({ self: { githubUserId: 2, devicePubkey: 'mmm' }, rows: [
          { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: NOW - 1000 },
          { device_pubkey: 'mmm', github_user_id: 2, machine_label: 'm2', last_seen_ms: NOW - 1000 },
        ] }),
      ),
    ).rejects.toThrow(/protocol bug/);
  });
});

describe('routeFileLockOp — file-claim scope guard (D-009)', () => {
  it('unknown/unmanaged domain → runs local (no federated harness)', async () => {
    const res = await routeFileLockOp('/some/repo', { local: async () => 'L' }, {
      domainToHarnessSlug: () => null,
    });
    expect(res).toEqual({ value: 'L', via: 'local-authority' });
  });

  it('mapped domain → delegates to authority routing (fail-open when remote)', async () => {
    const res = await routeFileLockOp(
      '/repo/h',
      { local: async () => 'L' },
      {
        domainToHarnessSlug: () => 'h',
        now: () => NOW,
        resolveSelf: async () => ({ githubUserId: 2, devicePubkey: 'mmm' }),
        fetchPresenceRows: async () => [
          { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: NOW - 1000 },
          { device_pubkey: 'mmm', github_user_id: 2, machine_label: 'm2', last_seen_ms: NOW - 1000 },
        ],
      },
    );
    expect(res.via).toBe('fail-open');
    expect(res.value).toBe('L');
  });

  it('mapped domain where we are authority → local', async () => {
    const res = await routeFileLockOp(
      '/repo/h',
      { local: async () => 'L' },
      {
        domainToHarnessSlug: () => 'h',
        now: () => NOW,
        resolveSelf: async () => ({ githubUserId: 1, devicePubkey: 'aaa' }),
        fetchPresenceRows: async () => [
          { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: NOW - 1000 },
        ],
      },
    );
    expect(res).toEqual({ value: 'L', via: 'local-authority' });
  });
});
