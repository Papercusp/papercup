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
  lockAuthorityForHive,
  selectAuthorityFromRows,
  resolveUseHrwRendezvous,
  routeToAuthority,
  queryPresenceRows,
  queryPresenceRowsForHive,
  DEFAULT_AUTHORITY_STALE_MS,
  type LockAuthorityDeps,
  type PeerRef,
} from '../lock-authority';
import { selectAuthorityRendezvous } from '../rendezvous-authority';
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
    // HRW_RENDEZVOUS_AUTHORITY defaults ON since its 2026-07-17 graduation; the
    // selection/routing tests in this file assert the argmin ROLLBACK path, so pin
    // it OFF here. HRW-path tests pass useHrwRendezvous: true explicitly.
    useHrwRendezvous: over.useHrwRendezvous ?? false,
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

// ── P-006: LOOSE SQL pre-filter prunes long-dead rows without changing the argmin ──
describe('queryPresenceRows / queryPresenceRowsForHive — LOOSE last_seen_at pre-filter (P-006)', () => {
  // A fake tagged-template `sql` that records each query's text + interpolated
  // values and returns canned rows — lets these pure tests assert the SQL shape
  // (the new `last_seen_at >=` predicate) without a real Postgres.
  //
  // EI-18714245790501659: production code now composes queries with postgres.js's
  // ternary-fragment idiom (`cond ? sql\`AND x = ${v}\` : sql\`\``, embedded as a
  // value in an outer sql`` template). Real postgres.js recognizes a nested sql``
  // call and splices its own literal text + bound values into the outer query
  // instead of binding it as an opaque parameter — so this mock must do the same
  // (flattenTemplate) rather than record the fragment as a single value, or a
  // top-level `await` on a never-embedded inner fragment would double-count calls.
  interface SqlFragment {
    __fragment: true;
    strings: TemplateStringsArray;
    values: unknown[];
  }

  function flattenTemplate(strings: TemplateStringsArray, values: unknown[]): { text: string; values: unknown[] } {
    let text = strings[0];
    const out: unknown[] = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v && typeof v === 'object' && (v as Partial<SqlFragment>).__fragment) {
        const frag = v as SqlFragment;
        const inner = flattenTemplate(frag.strings, frag.values);
        text += inner.text;
        out.push(...inner.values);
      } else {
        text += '§';
        out.push(v);
      }
      text += strings[i + 1];
    }
    return { text, values: out };
  }

  function recordingSql(rows: unknown[]) {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const fragment: SqlFragment = { __fragment: true, strings, values };
      return {
        ...fragment,
        then(onResolve: (v: unknown) => void, onReject?: (e: unknown) => void) {
          calls.push(flattenTemplate(strings, values));
          return Promise.resolve(rows).then(onResolve, onReject);
        },
      };
    }) as never;
    return { sql, calls };
  }

  it('harness query adds `last_seen_at >= now() - make_interval(2× staleness)` and maps the rows', async () => {
    const { sql, calls } = recordingSql([
      { device_pubkey: 'aaa', github_user_id: '1', machine_label: 'm1', last_seen_ms: '123' },
    ]);
    const out = await queryPresenceRows(sql, 'h', 90_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/harness_slug =/);
    expect(calls[0].text).toMatch(/last_seen_at\s*>=\s*now\(\)\s*-\s*make_interval/);
    // values = [harnessSlug, looseWindowSecs]; loose cutoff = 2×90s = 180s.
    // workspaceId omitted → the workspace_id predicate is OMITTED entirely
    // (EI-18714245790501659: no un-foldable parameterized-NULL OR, so no
    // workspaceId value at all rather than a WI-6032-era duplicated null).
    expect(calls[0].values).toEqual(['h', 180]);
    expect(calls[0].text).not.toMatch(/workspace_id/);
    // BIGINT→string columns are still coerced to numbers. `runs_routines`
    // (EI-18761517980514694, mig 682) and `active_routines` (EI-19330771435294981,
    // mig 724) are selected on the same read and normalised to null when the row
    // predates either column — absent ⇒ not a runner/routine candidate.
    expect(out).toEqual([
      {
        device_pubkey: 'aaa',
        github_user_id: 1,
        machine_label: 'm1',
        last_seen_ms: 123,
        runs_routines: null,
        active_routines: null,
      },
    ]);
  });

  it('WI-6032: harness query filters on workspace_id when passed', async () => {
    const { sql, calls } = recordingSql([]);
    await queryPresenceRows(sql, 'h', 90_000, 'ws-1');
    expect(calls[0].text).toMatch(/workspace_id = /);
    // EI-18714245790501659: a single bound occurrence now, not the old duplicated
    // (IS-NULL branch, eq branch) pair.
    expect(calls[0].values).toEqual(['h', 'ws-1', 180]);
  });

  it('hive query adds the same loose predicate, scoped on hive_slug', async () => {
    const { sql, calls } = recordingSql([]);
    await queryPresenceRowsForHive(sql, 'my-hive', 10_000);
    expect(calls[0].text).toMatch(/pot_slug =/);
    expect(calls[0].text).toMatch(/last_seen_at\s*>=\s*now\(\)\s*-\s*make_interval/);
    expect(calls[0].values).toEqual(['my-hive', 20]); // 2×10s, workspaceId omitted → predicate omitted
    expect(calls[0].text).not.toMatch(/workspace_id/);
  });

  it('WI-6032: hive query filters on workspace_id when passed', async () => {
    const { sql, calls } = recordingSql([]);
    await queryPresenceRowsForHive(sql, 'my-hive', 10_000, 'ws-2');
    expect(calls[0].text).toMatch(/workspace_id = /);
    expect(calls[0].values).toEqual(['my-hive', 'ws-2', 20]);
  });

  it('defaults the loose window to 2× the DEFAULT staleness window when staleMs is omitted', async () => {
    const { sql, calls } = recordingSql([]);
    await queryPresenceRows(sql, 'h');
    expect(calls[0].values[1]).toBe((2 * DEFAULT_AUTHORITY_STALE_MS) / 1000); // 180
  });

  it('the loose pre-filter never changes the argmin — selection is byte-identical to the un-pre-filtered set', async () => {
    const staleMs = 90_000;
    // Spans the three regimes around the cutoffs:
    //  - 'aaa' FRESH (within staleMs) — the rightful authority.
    //  - 'bbb' just-stale (between staleMs and 2× staleMs) — KEPT by the loose SQL,
    //    then dropped by the TS freshness cut; proves the 2× margin is harmless.
    //  - 'a00' long-dead (older than 2× staleMs) — the LOWEST pubkey, so it would
    //    hijack argmin if freshness were ignored; the loose SQL is what prunes it.
    const allRows = [
      { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm-fresh', last_seen_ms: NOW - 1_000 },
      { device_pubkey: 'bbb', github_user_id: 2, machine_label: 'm-juststale', last_seen_ms: NOW - 120_000 },
      { device_pubkey: 'a00', github_user_id: 3, machine_label: 'm-dead', last_seen_ms: NOW - 5_000_000 },
    ];
    // What Postgres returns under the loose (2× staleMs) cutoff: only 'a00' is pruned.
    const looseCutoff = NOW - 2 * staleMs;
    const afterLooseSql = allRows.filter((row) => row.last_seen_ms >= looseCutoff);
    expect(afterLooseSql.map((r) => r.device_pubkey).sort()).toEqual(['aaa', 'bbb']); // 'a00' gone

    const fromPrefiltered = await lockAuthorityFor('h', {
      now: () => NOW,
      staleMs,
      fetchPresenceRows: async () => afterLooseSql,
      resolveSelf: async () => null,
      useHrwRendezvous: false, // asserts argmin equivalence — pin the rollback path
    });
    const fromFull = selectAuthorityFromRows(allRows, null, NOW, staleMs);
    expect(fromPrefiltered).toEqual(fromFull);
    expect(fromPrefiltered.peer?.devicePubkey).toBe('aaa'); // not the long-dead 'a00'
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

// ── WI-1491 (P-021 live cutover): HRW rendezvous flag-gate ──────────────────────
describe('lockAuthorityFor / lockAuthorityForHive — HRW rendezvous cutover (WI-1491)', () => {
  const rows = [
    { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: NOW - 1000 },
    { device_pubkey: 'bbb', github_user_id: 2, machine_label: 'm2', last_seen_ms: NOW - 1000 },
    { device_pubkey: 'ccc', github_user_id: 3, machine_label: 'm3', last_seen_ms: NOW - 1000 },
  ];
  const self = { githubUserId: 1, devicePubkey: 'aaa' };
  const staleMs = 90_000;

  it('resolveUseHrwRendezvous: deps.useHrwRendezvous short-circuits (no flag read)', async () => {
    await expect(resolveUseHrwRendezvous({ useHrwRendezvous: true })).resolves.toBe(true);
    await expect(resolveUseHrwRendezvous({ useHrwRendezvous: false })).resolves.toBe(false);
  });

  it('resolveUseHrwRendezvous: defaults to the live flag, which is ON by default since the 2026-07-17 graduation', async () => {
    await expect(resolveUseHrwRendezvous({})).resolves.toBe(true);
  });

  it('flag OFF (pinned rollback path) → lockAuthorityFor is byte-identical to the argmin path, even with a scopeKey set', async () => {
    const r = await lockAuthorityFor('h', {
      now: () => NOW,
      staleMs,
      fetchPresenceRows: async () => rows,
      resolveSelf: async () => self,
      useHrwRendezvous: false,
      scopeKey: 'some-fine-grained-scope', // ignored while the flag is off
    });
    expect(r).toEqual(selectAuthorityFromRows(rows, self, NOW, staleMs));
  });

  it('flag ON, no scopeKey → lockAuthorityFor delegates to selectAuthorityRendezvous using the harnessSlug as the default scope key', async () => {
    const r = await lockAuthorityFor('my-harness', {
      now: () => NOW,
      staleMs,
      fetchPresenceRows: async () => rows,
      resolveSelf: async () => self,
      useHrwRendezvous: true,
    });
    expect(r).toEqual(selectAuthorityRendezvous(rows, self, NOW, staleMs, 'my-harness'));
    // Every existing call site (none pass scopeKey today) keeps a SINGLE authority
    // per harness under the cutover — only the winner RULE changes (HRW vs argmin).
  });

  it('flag ON + an explicit scopeKey overrides the harnessSlug default (fine-grained sharding)', async () => {
    const r = await lockAuthorityFor('my-harness', {
      now: () => NOW,
      staleMs,
      fetchPresenceRows: async () => rows,
      resolveSelf: async () => self,
      useHrwRendezvous: true,
      scopeKey: 'file:/some/path.ts',
    });
    expect(r).toEqual(selectAuthorityRendezvous(rows, self, NOW, staleMs, 'file:/some/path.ts'));
  });

  it('flag ON: two different scope keys over the SAME live peer set can resolve to DIFFERENT authorities (the HRW load-spread property)', async () => {
    const manyRows = [
      { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'm1', last_seen_ms: NOW - 1000 },
      { device_pubkey: 'bbb', github_user_id: 2, machine_label: 'm2', last_seen_ms: NOW - 1000 },
      { device_pubkey: 'ccc', github_user_id: 3, machine_label: 'm3', last_seen_ms: NOW - 1000 },
      { device_pubkey: 'ddd', github_user_id: 4, machine_label: 'm4', last_seen_ms: NOW - 1000 },
      { device_pubkey: 'eee', github_user_id: 5, machine_label: 'm5', last_seen_ms: NOW - 1000 },
    ];
    const winners = new Set<string>();
    for (const scopeKey of ['scope-a', 'scope-b', 'scope-c', 'scope-d', 'scope-e', 'scope-f']) {
      const r = await lockAuthorityFor('h', {
        now: () => NOW,
        staleMs,
        fetchPresenceRows: async () => manyRows,
        resolveSelf: async () => null,
        useHrwRendezvous: true,
        scopeKey,
      });
      winners.add(r.peer?.devicePubkey ?? '(self)');
    }
    // Global argmin would put every one of these 6 scopes on the SAME peer; HRW is
    // expected (not guaranteed for every possible input, but true for this fixture)
    // to spread them across more than one — the whole point of the cutover.
    expect(winners.size).toBeGreaterThan(1);
  });

  it('lockAuthorityForHive: flag ON, no scopeKey → defaults the scope key to the hive/pot slug', async () => {
    const r = await lockAuthorityForHive('my-hive', {
      now: () => NOW,
      staleMs,
      fetchHivePresenceRows: async () => rows,
      resolveSelf: async () => self,
      useHrwRendezvous: true,
    });
    expect(r).toEqual(selectAuthorityRendezvous(rows, self, NOW, staleMs, 'my-hive'));
  });

  it('lockAuthorityForHive: flag OFF → byte-identical to the argmin path', async () => {
    const r = await lockAuthorityForHive('my-hive', {
      now: () => NOW,
      staleMs,
      fetchHivePresenceRows: async () => rows,
      resolveSelf: async () => self,
      useHrwRendezvous: false,
    });
    expect(r).toEqual(selectAuthorityFromRows(rows, self, NOW, staleMs));
  });
});

// ── WI-5395: capability-gated candidacy (eligibleDevices) ────────────────────
describe('lockAuthorityForHive — eligibleDevices (WI-5395 capability-gated election)', () => {
  // Live-shape regression: 'aaa' plays the mac (argmin AND HRW-competitive
  // winner for the hive, but NOT capable of the repo — no bare store), 'zzz'
  // plays the tower (capable, would lose the un-gated election).
  const rows = [
    { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'mac', last_seen_ms: NOW - 1000 },
    { device_pubkey: 'zzz', github_user_id: 2, machine_label: 'tower', last_seen_ms: NOW - 1000 },
  ];
  const self = { githubUserId: 2, devicePubkey: 'zzz' };
  const hiveDeps = (over: Partial<LockAuthorityDeps> = {}): LockAuthorityDeps => ({
    now: () => NOW,
    staleMs: 90_000,
    fetchHivePresenceRows: async () => rows,
    resolveSelf: async () => self,
    useHrwRendezvous: false,
    evictionMonitor: null,
    ...over,
  });

  it('ungated (the pre-fix behavior): the incapable peer wins argmin and the capable member declines', async () => {
    const r = await lockAuthorityForHive('hive', hiveDeps());
    expect(r.isSelf).toBe(false);
    expect(r.peer?.machineLabel).toBe('mac');
  });

  it('gated: an ineligible peer is excluded from candidacy, so the lease lands on a CAPABLE member', async () => {
    const r = await lockAuthorityForHive('hive', hiveDeps({ eligibleDevices: new Set(['zzz']) }));
    expect(r).toEqual({ isSelf: true, liveCount: 1 });
  });

  it('gated + HRW path: eligibility constrains the rendezvous candidate set the same way', async () => {
    const r = await lockAuthorityForHive('hive', hiveDeps({ useHrwRendezvous: true, eligibleDevices: new Set(['zzz']) }));
    expect(r).toEqual({ isSelf: true, liveCount: 1 });
  });

  it('all peers eligible → byte-identical to the ungated election (no churn on healthy hives)', async () => {
    const gated = await lockAuthorityForHive('hive', hiveDeps({ eligibleDevices: new Set(['aaa', 'zzz']) }));
    const ungated = await lockAuthorityForHive('hive', hiveDeps());
    expect(gated).toEqual(ungated);
  });

  it('eligibility MERGES with eviction exclusions rather than replacing them', async () => {
    const evictingMonitor = {
      beforeSelect: () => new Set(['zzz']), // relay-confirmed dead
    };
    // 'aaa' ineligible (capability) + 'zzz' evicted (dead) → only self remains.
    const r = await lockAuthorityForHive(
      'hive',
      hiveDeps({
        resolveSelf: async () => ({ githubUserId: 3, devicePubkey: 'mmm' }),
        eligibleDevices: new Set(['mmm', 'zzz']),
        evictionMonitor: evictingMonitor as never,
      }),
    );
    expect(r).toEqual({ isSelf: true, liveCount: 1 });
  });

  it('SELF candidacy is not constrained by the allowlist (self-capability is the caller\'s own check)', async () => {
    // self 'zzz' not in the allowlist — still auto-added by the selector; the
    // integrator leg guarantees self-capability before electing (store check).
    const r = await lockAuthorityForHive('hive', hiveDeps({ eligibleDevices: new Set(['aaa']) }));
    expect(r.isSelf).toBe(false);
    expect(r.peer?.machineLabel).toBe('mac'); // 'aaa' eligible + argmin < self
  });
});

// ── EI-19330771435294981: routineHostsOnly, and its EMPTY-CAPABLE degenerate case
//
// `routineHostsOnly` narrows candidacy to devices publishing
// `shared_presence.runs_routines = true` (EI-18761517980514694). The bit is
// published only by nodes with an ACTIVE cadence routine (gym-cycle / scout-cycle
// — cadence-runner-capability.ts), so on a pot where neither is armed it is
// unpublished by EVERY device: measured 2026-08-02 on papercusp-workspace,
// `runs_routines` was null on all live presence rows.
//
// The narrowing then resolves to the EMPTY set — and an empty allowlist excludes
// every ROW, self's own row included (`withEligibility` iterates rows, not peers).
// Whether that ends in "self wins" or "nobody wins" is the difference between a
// caller failing safe and a caller freezing indefinitely, and it had NO test:
// the git-sync integrator election opted in (WI-6996, git-sync-action.ts:2716) on
// the strength of a prose safety comment alone, and when the integrator kept
// declining `not_authority` through an outage that comment was — reasonably, and
// wrongly — read as disproven.
//
// These pin the real behaviour so a future change to `withEligibility` /
// `selectAuthorityFromRows` that drops the unconditional self-add reds HERE
// instead of silently freezing a pot's integrator.
describe('lockAuthorityForHive — routineHostsOnly (EI-18761517980514694 narrowing + empty-capable degenerate case)', () => {
  type Row = {
    device_pubkey: string;
    github_user_id: number;
    machine_label: string;
    last_seen_ms: number;
    runs_routines?: boolean | null;
  };
  // 'aaa' plays the wrongly-elected peer: argmin winner, publishes no bit.
  // 'zzz' plays the node that actually runs the loops.
  const publishedRows: Row[] = [
    { device_pubkey: 'aaa', github_user_id: 1, machine_label: 'mac', last_seen_ms: NOW - 1000, runs_routines: null },
    { device_pubkey: 'zzz', github_user_id: 2, machine_label: 'tower', last_seen_ms: NOW - 1000, runs_routines: true },
  ];
  // The live shape: NOBODY publishes the bit.
  const inertRows: Row[] = publishedRows.map((r) => ({ ...r, runs_routines: null }));
  const self = { githubUserId: 3, devicePubkey: 'mmm' };
  const hiveDeps = (rows: Row[], over: Partial<LockAuthorityDeps> = {}): LockAuthorityDeps => ({
    now: () => NOW,
    staleMs: 90_000,
    fetchHivePresenceRows: async () => rows,
    resolveSelf: async () => self,
    useHrwRendezvous: false,
    evictionMonitor: null,
    routineHostsOnly: true,
    ...over,
  });

  it('narrows candidacy to bit-publishing peers: the non-publishing argmin peer is excluded', async () => {
    // Ungated, 'aaa' would win (argmin over aaa/mmm/zzz). Gated, only 'zzz'
    // publishes the bit, so the peer set is {zzz} and self 'mmm' wins argmin.
    const ungated = await lockAuthorityForHive('hive', hiveDeps(publishedRows, { routineHostsOnly: false }));
    expect(ungated.isSelf).toBe(false);
    expect(ungated.peer?.machineLabel).toBe('mac');

    const gated = await lockAuthorityForHive('hive', hiveDeps(publishedRows));
    expect(gated).toEqual({ isSelf: true, liveCount: 2 }); // {zzz, self}
  });

  it('EMPTY capable set ⇒ SELF wins — the narrowing fails SAFE, it never freezes the election', async () => {
    const r = await lockAuthorityForHive('hive', hiveDeps(inertRows));
    // Every row excluded; self re-added unconditionally by selectAuthorityFromRows.
    expect(r).toEqual({ isSelf: true, liveCount: 1 });
  });

  it('EMPTY capable set on the HRW path ⇒ SELF wins there too (both selectors re-add self)', async () => {
    const r = await lockAuthorityForHive('hive', hiveDeps(inertRows, { useHrwRendezvous: true }));
    expect(r).toEqual({ isSelf: true, liveCount: 1 });
  });

  it('EMPTY capable set + NO self identity ⇒ the single-box fallback, still isSelf', async () => {
    const r = await lockAuthorityForHive('hive', hiveDeps(inertRows, { resolveSelf: async () => null }));
    expect(r).toEqual({ isSelf: true, liveCount: 0 });
  });

  it('a peer must satisfy BOTH constraints — the sets INTERSECT, they do not union', async () => {
    // 'zzz' publishes the bit but is not in eligibleDevices → excluded anyway.
    const r = await lockAuthorityForHive(
      'hive',
      hiveDeps(publishedRows, { eligibleDevices: new Set(['aaa', 'mmm']) }),
    );
    expect(r).toEqual({ isSelf: true, liveCount: 1 });
  });

  it('the git-sync integrator configuration (eligibleDevices + routineHostsOnly, bit unpublished) elects SELF every tick', async () => {
    // git-sync-action.ts passes BOTH. With the bit unpublished the intersection is
    // empty, so the narrowing cannot exclude *some* peers — it excludes ALL of
    // them, on every node that reaches the election. Peer arbitration for the
    // integrator is therefore OFF, not merely relaxed: this is what the opt-in
    // actually buys today, and it is why the shipped fix "worked".
    const r = await lockAuthorityForHive(
      'hive',
      hiveDeps(inertRows, { eligibleDevices: new Set(['mmm', 'aaa', 'zzz']) }),
    );
    expect(r).toEqual({ isSelf: true, liveCount: 1 });
  });
});

// ── EI-19330771435294981 / mig 724: requiresRoutine — the per-election capability
//
// The describe above pins what `routineHostsOnly` actually does at the git-sync
// integrator call site: with the cadence bit unpublished it excludes EVERY peer,
// so integrator arbitration is OFF rather than tightened. `requiresRoutine` is the
// fix — the node publishes the SET of its ACTIVE routine names and each election
// asks its own question, so the integrator can require 'git-sync' instead of
// borrowing a bit about gym-cycle.
//
// The load-bearing test is 'RESTORES arbitration': same roster, same election,
// where routineHostsOnly elected self (nobody) requiresRoutine elects a real peer.
describe('lockAuthorityForHive — requiresRoutine (EI-19330771435294981)', () => {
  type Row = {
    device_pubkey: string;
    github_user_id: number;
    machine_label: string;
    last_seen_ms: number;
    runs_routines?: boolean | null;
    active_routines?: readonly string[] | null;
  };
  // NOT 'mmm' (unlike the routineHostsOnly block above): several tests below
  // expect a REAL remaining peer ('zzz'/tower) to win argmin once 'aaa' is
  // excluded, which requires self to sort AFTER 'zzz' lexicographically —
  // 'mmm' < 'zzz' would make self win those cases instead (as it correctly
  // does, on purpose, in the routineHostsOnly block's own 'zzz'-only case).
  const self = { githubUserId: 3, devicePubkey: 'zzzzzz' };
  // The real papercusp shape: no cadence routine anywhere (so runs_routines is null
  // on every row), but both peers DO run git-sync and now publish it.
  //
  // ⚠ These two fields must stay CONSISTENT with what a real publisher emits, and
  // since P-004 that is load-bearing rather than cosmetic. A mig-724 publisher gates
  // the set and the bit on the same `dbosLaunches()`, so a row carrying a cadence
  // routine in `active_routines` ALWAYS carries `runs_routines: true` too — and
  // `routineHostsOnly` now derives from the set when it is present. A fixture with
  // 'gym-cycle' in the set but a null bit is therefore not merely unrealistic, it
  // asserts the opposite of what it reads as: it makes that peer cadence-ELIGIBLE.
  const rows: Row[] = [
    {
      device_pubkey: 'aaa', github_user_id: 1, machine_label: 'mac',
      last_seen_ms: NOW - 1000, runs_routines: null, active_routines: ['git-sync'],
    },
    {
      device_pubkey: 'zzz', github_user_id: 2, machine_label: 'tower',
      last_seen_ms: NOW - 1000, runs_routines: null, active_routines: ['git-sync'],
    },
  ];
  const hiveDeps = (rs: Row[], over: Partial<LockAuthorityDeps> = {}): LockAuthorityDeps => ({
    now: () => NOW,
    staleMs: 90_000,
    fetchHivePresenceRows: async () => rs,
    resolveSelf: async () => self,
    useHrwRendezvous: false,
    evictionMonitor: null,
    ...over,
  });

  it('RESTORES arbitration where routineHostsOnly disabled it — same roster, real peer elected', async () => {
    // This is the entire point of the plan, as one comparison.
    const viaCadenceBit = await lockAuthorityForHive('hive', hiveDeps(rows, { routineHostsOnly: true }));
    expect(viaCadenceBit).toEqual({ isSelf: true, liveCount: 1 }); // every peer excluded — arbitration OFF

    const viaRoutine = await lockAuthorityForHive('hive', hiveDeps(rows, { requiresRoutine: 'git-sync' }));
    expect(viaRoutine.isSelf).toBe(false);
    expect(viaRoutine.peer?.machineLabel).toBe('mac'); // argmin over {aaa, zzz, self zzzzzz}
  });

  it('excludes a peer that does not publish the required routine', async () => {
    const mixed: Row[] = [
      { ...rows[0]!, active_routines: ['gym-cycle'] }, // 'aaa' does NOT run git-sync
      rows[1]!,
    ];
    const r = await lockAuthorityForHive('hive', hiveDeps(mixed, { requiresRoutine: 'git-sync' }));
    expect(r.isSelf).toBe(false);
    expect(r.peer?.machineLabel).toBe('tower'); // only 'zzz' qualifies
  });

  it('absent / null / EMPTY active_routines are all "not a candidate"', async () => {
    // A pre-mig-724 peer sends nothing; a node advertising nothing sends null (the
    // publisher collapses [] to null). All three must read identically here.
    for (const absent of [undefined, null, [] as readonly string[]]) {
      const r = await lockAuthorityForHive(
        'hive',
        hiveDeps(rows.map((x) => ({ ...x, active_routines: absent })), { requiresRoutine: 'git-sync' }),
      );
      expect(r).toEqual({ isSelf: true, liveCount: 1 }); // fails SAFE: self wins
    }
  });

  it('EMPTY capable set fails SAFE on BOTH selectors — argmin and HRW alike', async () => {
    const inert = rows.map((r) => ({ ...r, active_routines: null }));
    expect(await lockAuthorityForHive('hive', hiveDeps(inert, { requiresRoutine: 'git-sync' })))
      .toEqual({ isSelf: true, liveCount: 1 });
    expect(
      await lockAuthorityForHive(
        'hive',
        hiveDeps(inert, { requiresRoutine: 'git-sync', useHrwRendezvous: true }),
      ),
    ).toEqual({ isSelf: true, liveCount: 1 });
  });

  it('NARROWS the HRW selector too — the excluded peer wins no scope, and it is not a blanket self-election', async () => {
    // The degenerate case above only proves HRW fails SAFE when NOTHING qualifies.
    // This is the positive half P-006 asks for: that the narrowing actually binds
    // on the rendezvous path. HRW picks by hash, so no single scope key has a
    // hardcodable winner — but the narrowing is exactly assertable as a property.
    // Sweeping scope keys pins BOTH directions, which one key never could:
    // 'aaa' is reachable ungated, unreachable gated, and 'zzz' still wins real
    // scopes (so the gate narrowed candidacy rather than collapsing to self).
    const mixed: Row[] = [
      { ...rows[0]!, active_routines: ['gym-cycle'] }, // 'aaa' does NOT run git-sync
      rows[1]!,
    ];
    const winners = async (over: Partial<LockAuthorityDeps>) =>
      Promise.all(
        Array.from({ length: 40 }, (_, i) => `scope-${i}`).map(async (scopeKey) => {
          const r = await lockAuthorityForHive(
            'hive',
            hiveDeps(mixed, { useHrwRendezvous: true, scopeKey, ...over }),
          );
          return r.isSelf ? '(self)' : r.peer?.machineLabel;
        }),
      );

    const ungated = await winners({});
    expect(ungated).toContain('mac'); // 'aaa' is genuinely reachable under HRW

    const gated = await winners({ requiresRoutine: 'git-sync' });
    expect(gated).not.toContain('mac'); // ...and never is, once the routine is required
    expect(gated).toContain('tower'); // 'zzz' still wins scopes — candidacy narrowed, not disabled
  });

  it('INTERSECTS with eligibleDevices — both are necessary conditions', async () => {
    // 'aaa' publishes git-sync but is not an eligible device; 'zzz' is eligible but
    // here publishes nothing. Neither satisfies both ⇒ self.
    const mixed: Row[] = [rows[0]!, { ...rows[1]!, active_routines: null }];
    const r = await lockAuthorityForHive(
      'hive',
      hiveDeps(mixed, { requiresRoutine: 'git-sync', eligibleDevices: new Set(['zzz', 'mmm']) }),
    );
    expect(r).toEqual({ isSelf: true, liveCount: 1 });
  });

  it('INTERSECTS with routineHostsOnly when a caller opts into both', async () => {
    // 'zzz' runs git-sync AND a cadence routine; 'aaa' only git-sync. Since P-004
    // "publishes the cadence bit" means carrying a CADENCE ROUTINE in the set — the
    // set outranks the bit whenever it is present — so the two fields move together.
    const both: Row[] = [
      rows[0]!,
      { ...rows[1]!, active_routines: ['git-sync', 'gym-cycle'], runs_routines: true },
    ];
    const r = await lockAuthorityForHive(
      'hive',
      hiveDeps(both, { requiresRoutine: 'git-sync', routineHostsOnly: true }),
    );
    expect(r.isSelf).toBe(false);
    expect(r.peer?.machineLabel).toBe('tower'); // only 'zzz' satisfies both
  });

  it('is OPT-IN — omitting it leaves candidacy exactly as it was', async () => {
    const r = await lockAuthorityForHive('hive', hiveDeps(rows));
    expect(r.isSelf).toBe(false);
    expect(r.peer?.machineLabel).toBe('mac'); // plain argmin, no narrowing
  });

  it('matches the routine name EXACTLY — no prefix or substring match', async () => {
    const r = await lockAuthorityForHive(
      'hive',
      hiveDeps(
        rows.map((x) => ({ ...x, active_routines: ['git-sync-watchdog'] })),
        { requiresRoutine: 'git-sync' },
      ),
    );
    expect(r).toEqual({ isSelf: true, liveCount: 1 });
  });
});

// ── P-004 / D-006: `routineHostsOnly` DERIVED from the published set
//
// The predicate no longer reads `runs_routines` when `active_routines` is present:
// it asks `set ∩ CADENCE_RUNNER_ROUTINES ≠ ∅`. D-005 point 1 makes that
// semantics-preserving for a mig-724 publisher (one `dbosLaunches()` gates both).
//
// The case D-005 does NOT cover, and the reason the fallback exists, is the
// PRE-mig-724 peer: it publishes the bit and no set. Reading absent as "not a
// candidate" — correct for `requiresRoutine` — would silently drop that peer from
// the cadence election, which is the WI-6996 narrowing this plan exists to remove,
// reintroduced by its own fix. So absent DEFERS to the bit.
describe('lockAuthorityForHive — routineHostsOnly derived from active_routines (P-004 / D-006)', () => {
  type Row = {
    device_pubkey: string;
    github_user_id: number;
    machine_label: string;
    last_seen_ms: number;
    runs_routines?: boolean | null;
    active_routines?: readonly string[] | null;
  };
  const self = { githubUserId: 3, devicePubkey: 'zzzzzz' };
  const peer = (over: Partial<Row>): Row[] => [
    {
      device_pubkey: 'aaa', github_user_id: 1, machine_label: 'mac',
      last_seen_ms: NOW - 1000, ...over,
    },
  ];
  const deps = (rs: Row[]): LockAuthorityDeps => ({
    now: () => NOW,
    staleMs: 90_000,
    fetchHivePresenceRows: async () => rs,
    resolveSelf: async () => self,
    useHrwRendezvous: false,
    evictionMonitor: null,
    routineHostsOnly: true,
  });
  // Eligible ⇒ 'aaa' survives the narrowing and wins argmin over self 'zzzzzz'.
  const eligible = async (rs: Row[]) => (await lockAuthorityForHive('hive', deps(rs))).isSelf === false;

  it('NEW peer running a cadence routine ⇒ eligible (derived from the set)', async () => {
    expect(await eligible(peer({ active_routines: ['gym-cycle'], runs_routines: true }))).toBe(true);
  });

  it('NEW peer running ONLY git-sync ⇒ NOT eligible — the derivation does not widen', async () => {
    // The whole point of D-003: git-sync must not buy a seat in the cadence
    // election. This is the assertion that would fail if someone "simplified"
    // the predicate to a non-empty check on the set.
    expect(await eligible(peer({ active_routines: ['git-sync'], runs_routines: null }))).toBe(false);
  });

  it('PRE-mig-724 peer (bit true, NO set) ⇒ eligible via the fallback — the WI-6996 regression guard', async () => {
    // If this ever goes false, a rolling upgrade silently drops every not-yet-
    // upgraded cadence host out of the election.
    expect(await eligible(peer({ runs_routines: true }))).toBe(true);
    expect(await eligible(peer({ runs_routines: true, active_routines: null }))).toBe(true);
  });

  it('a peer publishing neither ⇒ NOT eligible', async () => {
    expect(await eligible(peer({}))).toBe(false);
    expect(await eligible(peer({ runs_routines: null, active_routines: null }))).toBe(false);
  });

  it('the SET OUTRANKS the bit when both are present — an upgraded peer is judged on what it actually runs', async () => {
    // A publisher cannot legitimately emit this pair (one dbosLaunches() gates
    // both), so it only arises from a stale/forged row. Pinning it makes the
    // precedence explicit rather than incidental.
    expect(await eligible(peer({ active_routines: ['git-sync'], runs_routines: true }))).toBe(false);
    expect(await eligible(peer({ active_routines: ['gym-cycle'], runs_routines: null }))).toBe(true);
  });

  it('an EMPTY set is "advertises nothing", not "unknown" — it does NOT fall back to the bit', async () => {
    // D-005 point 2: the publisher collapses [] to null on the wire, so a literal
    // [] should not reach a reader. If one does, it is a positive statement that
    // the node runs nothing — distinct from the absent case above it.
    expect(await eligible(peer({ active_routines: [], runs_routines: true }))).toBe(false);
  });

  it('matches cadence routine names EXACTLY — no prefix or substring match', async () => {
    expect(await eligible(peer({ active_routines: ['gym-cycle-watchdog'] }))).toBe(false);
    expect(await eligible(peer({ active_routines: ['scout-cycle'] }))).toBe(true);
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
        useHrwRendezvous: false, // fixture expects the argmin winner (aaa ≠ self) — pin the rollback path
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
    // WI-1550 (P-015): routeFileLockOp now also reports the resolved scope key so
    // callers can append their own lock-event on a LOCALLY-decided op (this is that
    // case — a mapped, federated domain where we ARE the authority).
    expect(res).toEqual({ value: 'L', via: 'local-authority', scope: 'h' });
  });
});
