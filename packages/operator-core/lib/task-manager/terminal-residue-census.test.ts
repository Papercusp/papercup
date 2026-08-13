import { describe, expect, it } from 'vitest';
import {
  appendResidueSample,
  censusTerminalResidue,
  cgroupWindowProtects,
  evaluateResidueTrend,
  isMaintDue,
  isPidInLiveWindowScope,
  resolveTerminalSliceAbs,
  type ResidueSample,
} from './terminal-residue-census';
import { parseResidueSamples } from './terminal-residue-store';
import type { CgroupFs } from './cgroup-read';

const ROOT = '/sys/fs/cgroup';
const TERM = `${ROOT}/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice`;

const SERVER = 500;
const USER_MANAGER = 2026497;

/** Mirrors terminal-window.test.ts's fake so the two agree on /proc shape. */
function box(opts: {
  children: Record<string, number[]>;
  ppids: Record<number, number>;
  unreadableScopes?: string[];
}): CgroupFs {
  const files: Record<string, string> = {};
  const dirs = new Set<string>([TERM]);

  for (const [name, pids] of Object.entries(opts.children)) {
    const abs = `${TERM}/${name}`;
    dirs.add(abs);
    if (!opts.unreadableScopes?.includes(name)) files[`${abs}/cgroup.procs`] = pids.join('\n');
  }
  for (const [pid, ppid] of Object.entries(opts.ppids)) {
    files[`/proc/${pid}/stat`] =
      `${pid} (node) S ${ppid} 1 1 0 -1 0 0 0 0 0 1 2 0 0 20 0 1 0 12345 0 0`;
  }

  return {
    readFile: (p) => files[p] ?? null,
    isDir: (p) => dirs.has(p),
    readDir: (p) => {
      const out = new Set<string>();
      for (const d of dirs) {
        if (d.startsWith(`${p}/`)) out.add(d.slice(p.length + 1).split('/')[0]!);
      }
      return [...out];
    },
  };
}

const scope = (n: number) => `vte-spawn-0000000${n}-0000-0000-0000-000000000000.scope`;

describe('censusTerminalResidue', () => {
  it('counts a scope whose window is gone, and leaves live ones alone', () => {
    const fs = box({
      children: {
        'gnome-terminal-server.service': [SERVER],
        [scope(1)]: [1001], // child of the server -> window ALIVE
        [scope(2)]: [2001, 2002], // orphaned onto the user manager -> window DEAD
      },
      ppids: { [SERVER]: 1, 1001: SERVER, 2001: USER_MANAGER, 2002: USER_MANAGER },
    });

    const c = censusTerminalResidue(TERM, fs);

    expect(c.scopesTotal).toBe(2);
    expect(c.scopesDead).toBe(1);
    expect(c.deadPids).toBe(2);
    expect(c.unprobeable).toBe(0);
    // With no probe supplied the disposition is `indeterminate` — never a guess,
    // and never a silently-clean-looking zero.
    expect(c.dead).toEqual([
      {
        scope: scope(2),
        pidCount: 2,
        disposition: 'indeterminate',
        oldestPidAgeMs: null,
        // No probe ⇒ no attribution either; empty means "no opinion" (EI-20369673282334981).
        owningSessionIds: [],
      },
    ]);
    expect(c.deadStale).toBe(0);
    expect(c.deadIndeterminate).toBe(1);
  });

  it('never counts an undecidable scope as dead — unknown is not dead', () => {
    const fs = box({
      children: {
        'gnome-terminal-server.service': [SERVER],
        [scope(1)]: [1001],
        [scope(2)]: [2001],
      },
      // no /proc entry for 2001 at all -> probe observes nothing -> null
      ppids: { [SERVER]: 1, 1001: SERVER },
      unreadableScopes: [],
    });

    const c = censusTerminalResidue(TERM, fs);

    expect(c.scopesDead).toBe(0);
    expect(c.unprobeable).toBe(1);
  });

  it('ignores non-window units in the slice', () => {
    const fs = box({
      children: {
        'gnome-terminal-server.service': [SERVER],
        'something-else.service': [9001],
        [scope(1)]: [2001],
      },
      ppids: { [SERVER]: 1, 9001: 1, 2001: USER_MANAGER },
    });

    const c = censusTerminalResidue(TERM, fs);
    expect(c.scopesTotal).toBe(1);
    expect(c.scopesDead).toBe(1);
  });

  it('is immune to cmdline — the filter that blinds the scan (D-017)', () => {
    // The probe reads only cgroup.procs + /proc/<pid>/stat. No cmdline is
    // provided by the fake at all, and the census still sees the residue. This is
    // the whole reason P-013 does not build on summary.unaccounted.
    const fs = box({
      children: {
        'gnome-terminal-server.service': [SERVER],
        [scope(1)]: [2001, 2002, 2003],
      },
      ppids: { [SERVER]: 1, 2001: USER_MANAGER, 2002: USER_MANAGER, 2003: USER_MANAGER },
    });

    const c = censusTerminalResidue(TERM, fs);
    expect(c.scopesDead).toBe(1);
    expect(c.deadPids).toBe(3);
  });
});

/**
 * EI-19418147529720290. The bug these guard against is not arithmetic — it is a
 * reader (an agent, on 2026-08-03) taking "15 dead scopes" as 15 things to clean
 * up, when 61% of the memory involved was the live staging operator whose terminal
 * had merely been closed.
 *
 * The invariant under test is one-directional: mislabelling a stale scope as
 * `indeterminate` costs nothing, mislabelling a LIVE one as `stale` points a human
 * at a running service. So every probe failure must land on the safe side.
 */
describe('censusTerminalResidue disposition (EI-19418147529720290)', () => {
  const DAY_MS = 24 * 60 * 60_000;
  const deadBox = (scopes: Record<string, number[]>) =>
    box({
      children: { 'gnome-terminal-server.service': [SERVER], ...scopes },
      ppids: {
        [SERVER]: 1,
        ...Object.fromEntries(Object.values(scopes).flat().map((p) => [p, USER_MANAGER])),
      },
    });

  const probe = (opts: {
    listening?: number[];
    knownLive?: number[];
    ages?: Record<number, number | null>;
    defaultAge?: number | null;
    sids?: Record<number, string | null>;
  }) => ({
    listeningPids: () => new Set(opts.listening ?? []),
    knownLivePids: opts.knownLive ? () => new Set(opts.knownLive!) : undefined,
    owningSessionId: opts.sids ? (pid: number) => opts.sids![pid] ?? null : undefined,
    pidAgeMs: (pid: number) =>
      (opts.ages && pid in opts.ages ? opts.ages[pid] : opts.defaultAge ?? 30 * DAY_MS),
  });

  /** Binds the slice path once so a call cannot pass the fs in its place. */
  const census = (scopes: Record<string, number[]>, opts?: Parameters<typeof censusTerminalResidue>[2]) =>
    censusTerminalResidue(TERM, deadBox(scopes), opts);

  it('a scope holding a LISTENING socket is a service, not residue', () => {
    // The 2026-08-03 case exactly: window dead, days old, but serving :3170. Old
    // and unclaimed, so EI-20369673282334981 now NAMES it separately — but the
    // property this test exists to hold is unchanged and asserted below: a
    // listener is never `stale`, i.e. never a reclaim candidate.
    const c = census({ [scope(1)]: [2001, 2002] }, { probe: probe({ listening: [2002] }) });
    expect(c.dead[0]!.disposition).toBe('live-service-unclaimed');
    expect(c.deadStale).toBe(0);
  });

  it('a listener that is claimed by a known-live pid stays `live-service-held`, at any age', () => {
    const c = census(
      { [scope(1)]: [2001, 2002] },
      { probe: probe({ listening: [2002], knownLive: [2001], defaultAge: 30 * DAY_MS }) },
    );
    expect(c.dead[0]!.disposition).toBe('live-service-held');
    expect(c.deadLiveServiceHeld).toBe(1);
    expect(c.deadLiveServiceUnclaimed).toBe(0);
  });

  it('a YOUNG listener is `live-service-held` — unclaimed is a claim about AGE too', () => {
    const c = census(
      { [scope(1)]: [2001] },
      { probe: probe({ listening: [2001], ages: { 2001: 60_000 } }) },
    );
    expect(c.dead[0]!.disposition).toBe('live-service-held');
    expect(c.deadLiveServiceUnclaimed).toBe(0);
  });

  it('an UNREADABLE age keeps a listener `live-service-held` — a failed read is not evidence of age', () => {
    const c = census(
      { [scope(1)]: [2001] },
      { probe: probe({ listening: [2001], ages: { 2001: null } }) },
    );
    expect(c.dead[0]!.disposition).toBe('live-service-held');
    expect(c.dead[0]!.oldestPidAgeMs).toBeNull();
  });

  /**
   * EI-20369673282334981, the whole point of the bucket: on 2026-08-13 a Hono host
   * on :4015 left by an ENDED agent session held ~70 GiB for 12 hours, and the
   * census could not have reported it at any age — a listener short-circuited
   * every staleness test into one undifferentiated `live-service-held` count.
   */
  it('an OLD listener no known-live pid claims is reported as `live-service-unclaimed`', () => {
    const c = census(
      { [scope(1)]: [2001] },
      { probe: probe({ listening: [2001], knownLive: [9999], ages: { 2001: 12 * 60 * 60_000 } }), staleAfterMs: 6 * 60 * 60_000 },
    );
    expect(c.dead[0]!.disposition).toBe('live-service-unclaimed');
    expect(c.deadLiveServiceUnclaimed).toBe(1);
    // The safety property: naming it did NOT make it reapable.
    expect(c.deadStale).toBe(0);
  });

  /**
   * The guard on the one change that would make this dangerous. `stale` is the
   * only disposition anything may ever act on, so the new bucket must not become a
   * back door into it: a listening pid stays protected at ANY age, exactly as
   * before. If a future edit reorders `classify` so a listener can fall through to
   * the staleness test, this fails.
   */
  it('NO listener reaches `stale`, however old — the split added a label, not kill power', () => {
    for (const age of [DAY_MS, 30 * DAY_MS, 365 * DAY_MS]) {
      const c = census({ [scope(1)]: [2001] }, { probe: probe({ listening: [2001], ages: { 2001: age } }) });
      expect(c.dead[0]!.disposition).not.toBe('stale');
      expect(c.deadStale).toBe(0);
    }
  });

  it('a scope holding a pid the caller knows is live is spared too', () => {
    // An enrolled agent session owns no listening socket, so without this leg the
    // ONLY signal left is age — and an old agent session is exactly the 14-of-15
    // case D-016 measured.
    const c = census({ [scope(1)]: [2001] }, { probe: probe({ knownLive: [2001] }) });
    expect(c.dead[0]!.disposition).toBe('live-service-held');
  });

  it('earns `stale` only when it is old AND shows no sign of a live tenant', () => {
    const c = census({ [scope(1)]: [2001] }, { probe: probe({ ages: { 2001: 17 * DAY_MS } }) });
    expect(c.dead[0]!.disposition).toBe('stale');
    expect(c.dead[0]!.oldestPidAgeMs).toBe(17 * DAY_MS);
    expect(c.deadStale).toBe(1);
  });

  it('a YOUNG scope is indeterminate — a just-closed window is a race, not an orphan', () => {
    const c = census({ [scope(1)]: [2001] }, { probe: probe({ ages: { 2001: 60_000 } }) });
    expect(c.dead[0]!.disposition).toBe('indeterminate');
    expect(c.deadStale).toBe(0);
  });

  it('an UNREADABLE age is not a young one, and must not fall through to stale', () => {
    const c = census({ [scope(1)]: [2001] }, { probe: probe({ ages: { 2001: null } }) });
    expect(c.dead[0]!.disposition).toBe('indeterminate');
    expect(c.dead[0]!.oldestPidAgeMs).toBeNull();
  });

  it('takes the OLDEST pid in the scope, so one fresh process cannot mask old residue', () => {
    const c = census(
      { [scope(1)]: [2001, 2002] },
      { probe: probe({ ages: { 2001: 60_000, 2002: 17 * DAY_MS } }) },
    );
    expect(c.dead[0]!.oldestPidAgeMs).toBe(17 * DAY_MS);
    expect(c.dead[0]!.disposition).toBe('stale');
  });

  it('honours a caller-supplied staleAfterMs threshold', () => {
    const scopes = { [scope(1)]: [2001] };
    const ages = { 2001: 2 * DAY_MS };
    expect(
      census(scopes, { probe: probe({ ages }), staleAfterMs: DAY_MS }).dead[0]!.disposition,
    ).toBe('stale');
    expect(
      census(scopes, { probe: probe({ ages }), staleAfterMs: 7 * DAY_MS }).dead[0]!.disposition,
    ).toBe('indeterminate');
  });

  it('WITHOUT a probe every dead scope is indeterminate — never silently clean', () => {
    // The default must not look like "0 stale, all healthy". A caller that forgets
    // the probe should get "undecided", which is a different claim from "fine".
    const c = census({ [scope(1)]: [2001], [scope(2)]: [2002] });
    expect(c.deadIndeterminate).toBe(2);
    expect(c.deadStale).toBe(0);
    expect(c.deadLiveServiceHeld).toBe(0);
    expect(c.scopesDead).toBe(2);
  });

  it('the four dispositions always partition scopesDead', () => {
    const c = census(
      { [scope(1)]: [2001], [scope(2)]: [2002], [scope(3)]: [2003], [scope(4)]: [2004] },
      {
        probe: probe({
          listening: [2001, 2004],
          knownLive: [2001],
          ages: { 2001: 17 * DAY_MS, 2002: 60_000, 2003: 17 * DAY_MS, 2004: 17 * DAY_MS },
        }),
      },
    );
    expect(
      c.deadStale + c.deadLiveServiceHeld + c.deadLiveServiceUnclaimed + c.deadIndeterminate,
    ).toBe(c.scopesDead);
    expect([
      c.deadLiveServiceHeld,
      c.deadLiveServiceUnclaimed,
      c.deadIndeterminate,
      c.deadStale,
    ]).toEqual([1, 1, 1, 1]);
  });

  /**
   * EI-20369673282334981 attribution. Validated on this box 2026-08-13: 52 of 200
   * readable `/proc/<pid>/environ` carry `PAPERCUSP_SID`, and env is inherited, so
   * a process launched from an agent shell names the session that started it.
   */
  describe('owningSessionIds', () => {
    it('reports the distinct launching session ids, deduped across a scope', () => {
      // The ordinary shape: one agent shell plus its children, all inheriting the
      // SAME id. Reporting it three times would read as three sessions.
      const c = census(
        { [scope(1)]: [2001, 2002, 2003] },
        { probe: probe({ sids: { 2001: 'su-aaa', 2002: 'su-aaa', 2003: 'su-bbb' } }) },
      );
      expect(c.dead[0]!.owningSessionIds).toEqual(['su-aaa', 'su-bbb']);
    });

    it('is EMPTY, never a verdict, when environ carries no session id', () => {
      // 148 of the 200 sampled pids were this case — a systemd unit, a bootstrap,
      // anything the owner started by hand. Empty must read as "no opinion".
      const c = census({ [scope(1)]: [2001] }, { probe: probe({ sids: { 2001: null } }) });
      expect(c.dead[0]!.owningSessionIds).toEqual([]);
    });

    it('is EMPTY when the probe cannot answer at all, and changes no disposition', () => {
      // A probe predating this field (owningSessionId undefined) must still
      // classify exactly as before — attribution is additive reporting only.
      const c = census({ [scope(1)]: [2001] }, { probe: probe({ ages: { 2001: 17 * DAY_MS } }) });
      expect(c.dead[0]!.owningSessionIds).toEqual([]);
      expect(c.dead[0]!.disposition).toBe('stale');
    });

    it('does NOT influence disposition — an ended-looking session cannot promote a scope', () => {
      // The binding constraint from D-016: attribution is not authorization. The
      // `:3170` staging operator is attributable to a session that has long ended
      // and is still critical shared infra.
      const withSid = census(
        { [scope(1)]: [2001] },
        { probe: probe({ listening: [2001], sids: { 2001: 'su-ended' }, ages: { 2001: 17 * DAY_MS } }) },
      );
      const withoutSid = census(
        { [scope(1)]: [2001] },
        { probe: probe({ listening: [2001], ages: { 2001: 17 * DAY_MS } }) },
      );
      expect(withSid.dead[0]!.disposition).toBe(withoutSid.dead[0]!.disposition);
      expect(withSid.deadStale).toBe(0);
    });
  });
});

describe('evaluateResidueTrend', () => {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;
  const now = 10 * DAY;

  const at = (daysAgo: number, scopesDead: number): ResidueSample => ({
    atMs: now - daysAgo * DAY,
    scopesDead,
  });

  it('flags a rising FLOOR as accumulation', () => {
    const samples = [
      at(6, 3),
      at(5, 4),
      at(4, 3),
      // recent window (<24h)
      { atMs: now - 3 * HOUR, scopesDead: 9 },
      { atMs: now - 2 * HOUR, scopesDead: 11 },
      { atMs: now - 1 * HOUR, scopesDead: 10 },
    ];

    const v = evaluateResidueTrend(samples, { nowMs: now });

    expect(v.trend).toBe('rising');
    expect(v.olderFloor).toBe(3);
    expect(v.recentFloor).toBe(9);
    expect(v.floorDelta).toBe(6);
    expect(v.alarm).toBe(true);
  });

  it('does NOT fire on churn — a moving peak over a flat floor', () => {
    // Windows opening and closing all day swing the max wildly; the floor is what
    // says whether anything is actually stuck. This is the false-positive D-016
    // measured at ~93% for a level-based alarm.
    const samples = [
      at(6, 2),
      at(5, 40),
      at(4, 3),
      { atMs: now - 3 * HOUR, scopesDead: 38 },
      { atMs: now - 2 * HOUR, scopesDead: 2 },
      { atMs: now - 1 * HOUR, scopesDead: 45 },
    ];

    const v = evaluateResidueTrend(samples, { nowMs: now });

    expect(v.trend).toBe('steady');
    expect(v.alarm).toBe(false);
  });

  it('reports falling when residue is being cleared', () => {
    const samples = [
      at(6, 12),
      at(5, 14),
      at(4, 13),
      { atMs: now - 3 * HOUR, scopesDead: 2 },
      { atMs: now - 2 * HOUR, scopesDead: 3 },
      { atMs: now - 1 * HOUR, scopesDead: 2 },
    ];

    const v = evaluateResidueTrend(samples, { nowMs: now });

    expect(v.trend).toBe('falling');
    expect(v.alarm).toBe(false);
  });

  it('says UNKNOWN rather than healthy when history is too thin', () => {
    const v = evaluateResidueTrend(
      [{ atMs: now - HOUR, scopesDead: 30 }],
      { nowMs: now },
    );

    expect(v.trend).toBe('unknown');
    expect(v.alarm).toBe(false);
    expect(v.summary).toMatch(/not the same as healthy/);
  });

  it('ignores samples older than the lookback', () => {
    const samples = [
      at(90, 0), // ancient, outside lookback — must not become the older floor
      at(6, 8),
      at(5, 9),
      at(4, 8),
      { atMs: now - 3 * HOUR, scopesDead: 9 },
      { atMs: now - 2 * HOUR, scopesDead: 10 },
      { atMs: now - 1 * HOUR, scopesDead: 9 },
    ];

    const v = evaluateResidueTrend(samples, { nowMs: now });

    expect(v.olderFloor).toBe(8);
    expect(v.trend).toBe('steady');
  });

  it('treats an unreadable store ([]) as unknown, never as healthy', () => {
    // readResidueSamples returns [] on ANY failure. If that rendered as 'steady'
    // a storage outage would look exactly like "no accumulation" — the laundering
    // shape D-017 is about.
    const v = evaluateResidueTrend([], { nowMs: now });
    expect(v.trend).toBe('unknown');
    expect(v.alarm).toBe(false);
  });

  it('models the 16-day silent accumulation this indicator exists to catch', () => {
    // One scope leaks per day and nothing clears it. No single day looks alarming,
    // which is exactly why a level alarm never fired.
    const samples: ResidueSample[] = [];
    for (let d = 16; d >= 0; d--) {
      samples.push({ atMs: now - d * DAY, scopesDead: 16 - d });
    }
    // enough recent samples to satisfy the floor comparison
    samples.push({ atMs: now - 2 * HOUR, scopesDead: 16 });
    samples.push({ atMs: now - 1 * HOUR, scopesDead: 16 });

    const v = evaluateResidueTrend(samples, { nowMs: now });

    expect(v.trend).toBe('rising');
    expect(v.alarm).toBe(true);
  });
});

describe('isPidInLiveWindowScope / cgroupWindowProtects (P-012 / D-019)', () => {
  /** box() + a /proc/<pid>/cgroup pointing the pid at one of its scopes. */
  const boxWithCgroup = (
    opts: Parameters<typeof box>[0] & { cgroupOf: Record<number, string> },
  ): CgroupFs => {
    const inner = box(opts);
    return {
      ...inner,
      readFile: (p) => {
        const m = /^\/proc\/(\d+)\/cgroup$/.exec(p);
        if (m) {
          const rel = opts.cgroupOf[Number(m[1])];
          return rel ? `0::${rel}\n` : null;
        }
        return inner.readFile(p);
      },
    };
  };

  const rel = (name: string) =>
    `/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/${name}`;

  it('reports alive for a pid inside a live window', () => {
    const fs = boxWithCgroup({
      children: { 'gnome-terminal-server.service': [SERVER], [scope(1)]: [1001] },
      ppids: { [SERVER]: 1, 1001: SERVER },
      cgroupOf: { 1001: rel(scope(1)) },
    });
    expect(isPidInLiveWindowScope(1001, fs)).toBe('alive');
  });

  it('reports dead for a pid whose window is gone', () => {
    const fs = boxWithCgroup({
      children: { 'gnome-terminal-server.service': [SERVER], [scope(2)]: [2001] },
      ppids: { [SERVER]: 1, 2001: USER_MANAGER },
      cgroupOf: { 2001: rel(scope(2)) },
    });
    expect(isPidInLiveWindowScope(2001, fs)).toBe('dead');
  });

  it('reports unknown for a REAL window scope it cannot decide', () => {
    // A window scope whose members have no readable /proc entry. This is the case
    // the reaper's wmctrl leg gets wrong (empty ⇒ unprotected ⇒ kill).
    const fs = boxWithCgroup({
      children: { 'gnome-terminal-server.service': [SERVER], [scope(3)]: [3001] },
      ppids: { [SERVER]: 1 }, // no /proc/3001/stat
      cgroupOf: { 3001: rel(scope(3)) },
    });
    expect(isPidInLiveWindowScope(3001, fs)).toBe('unknown');
  });

  it('distinguishes not-a-window from unknown — collapsing them disables the reaper', () => {
    const fs = boxWithCgroup({
      children: { 'gnome-terminal-server.service': [SERVER] },
      ppids: { [SERVER]: 1 },
      cgroupOf: { 4242: '/system.slice/papercup-bg-host.service' },
    });
    expect(isPidInLiveWindowScope(4242, fs)).toBe('not-a-window');
    // unreadable /proc is likewise "no opinion", never a window verdict
    expect(isPidInLiveWindowScope(9999, fs)).toBe('not-a-window');
  });

  it('PROTECTS on alive and unknown, never on dead or not-a-window (D-019 polarity)', () => {
    // The reaper's existing wmctrl protection fails toward KILLING (an empty set
    // protects nobody); this leg must fail toward SPARING for a real window,
    // matching classifyScope's "unknown stays exempt" — while staying strictly
    // additive, so a non-window session is left to the existing rules.
    expect(cgroupWindowProtects('alive')).toBe(true);
    expect(cgroupWindowProtects('unknown')).toBe(true);
    expect(cgroupWindowProtects('dead')).toBe(false);
    expect(cgroupWindowProtects('not-a-window')).toBe(false);
  });
});

describe('resolveTerminalSliceAbs', () => {
  it('resolves the terminal slice under the user manager root', () => {
    expect(resolveTerminalSliceAbs('/user.slice/user-1000.slice/user@1000.service')).toBe(
      `${ROOT}/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice`,
    );
  });

  it('is null when there is no user manager root, rather than guessing a path', () => {
    expect(resolveTerminalSliceAbs(null)).toBeNull();
  });

  it('targets the Terminal slice, NOT app.slice (the too-wide probe reads everything as alive)', () => {
    const abs = resolveTerminalSliceAbs('/user.slice/user-1000.slice/user@1000.service')!;
    expect(abs.endsWith('/app-org.gnome.Terminal.slice')).toBe(true);
  });
});

describe('appendResidueSample', () => {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;

  it('appends and keeps chronological order', () => {
    const ring = appendResidueSample(
      [{ atMs: 1000, scopesDead: 1 }],
      { atMs: 2000, scopesDead: 2 },
    );
    expect(ring).toEqual([
      { atMs: 1000, scopesDead: 1 },
      { atMs: 2000, scopesDead: 2 },
    ]);
  });

  it('prunes samples older than the retention window', () => {
    const now = 100 * DAY;
    const ring = appendResidueSample(
      [
        { atMs: now - 60 * DAY, scopesDead: 99 }, // way outside default 21d
        { atMs: now - 2 * DAY, scopesDead: 5 },
      ],
      { atMs: now, scopesDead: 6 },
    );
    expect(ring.map((s) => s.scopesDead)).toEqual([5, 6]);
  });

  it('retains LONGER than the trend lookback, so both windows can be populated', () => {
    // Default retention (21d) must exceed the default trend lookback (7d),
    // otherwise the older comparison window is always empty and the verdict is
    // permanently 'unknown'.
    const now = 100 * DAY;
    const ring = appendResidueSample(
      [{ atMs: now - 10 * DAY, scopesDead: 3 }],
      { atMs: now, scopesDead: 4 },
    );
    expect(ring).toHaveLength(2);
  });

  it('caps ring length', () => {
    const now = 100 * DAY;
    const existing = Array.from({ length: 10 }, (_, i) => ({
      atMs: now - (10 - i) * HOUR,
      scopesDead: i,
    }));
    const ring = appendResidueSample(existing, { atMs: now, scopesDead: 42 }, { maxSamples: 5 });
    expect(ring).toHaveLength(5);
    expect(ring[ring.length - 1]).toEqual({ atMs: now, scopesDead: 42 });
  });
});

describe('parseResidueSamples', () => {
  it('reads a well-formed ring', () => {
    expect(parseResidueSamples([{ atMs: 2, scopesDead: 1 }, { atMs: 1, scopesDead: 0 }])).toEqual([
      { atMs: 1, scopesDead: 0 },
      { atMs: 2, scopesDead: 1 },
    ]);
  });

  it('discards malformed entries instead of throwing', () => {
    expect(
      parseResidueSamples([
        { atMs: 1, scopesDead: 2 },
        null,
        'nope',
        { atMs: 'x', scopesDead: 1 },
        { atMs: 3 },
        { atMs: Number.NaN, scopesDead: 1 },
      ]),
    ).toEqual([{ atMs: 1, scopesDead: 2 }]);
  });

  it('reads a non-array (absent key, wrong shape) as empty', () => {
    expect(parseResidueSamples(undefined)).toEqual([]);
    expect(parseResidueSamples({})).toEqual([]);
  });
});

describe('isMaintDue (EI-19407950136194410)', () => {
  const HOUR = 60 * 60_000;
  const NOW = 1_785_734_000_000;

  it('is due once the interval has elapsed, and not before', () => {
    expect(isMaintDue({ lastAtMs: NOW - HOUR + 1, nowMs: NOW, intervalMs: HOUR })).toBe(false);
    expect(isMaintDue({ lastAtMs: NOW - HOUR, nowMs: NOW, intervalMs: HOUR })).toBe(true);
    expect(isMaintDue({ lastAtMs: NOW - 5 * HOUR, nowMs: NOW, intervalMs: HOUR })).toBe(true);
  });

  it('treats an ABSENT or unreadable watermark as due, never as satisfied', () => {
    // The store returns null both for "never run" and for "could not read". Both must
    // answer DUE: a detector that goes quiet because its own history was unreadable is
    // the exact failure this replaces.
    expect(isMaintDue({ lastAtMs: null, nowMs: NOW, intervalMs: HOUR })).toBe(true);
    expect(isMaintDue({ lastAtMs: Number.NaN, nowMs: NOW, intervalMs: HOUR })).toBe(true);
  });

  it('treats a FUTURE watermark as due rather than wedging shut', () => {
    // Clock skew or a restored backup could otherwise disable the job for as long as
    // the skew lasts — silently, which is the polarity we are eliminating.
    expect(isMaintDue({ lastAtMs: NOW + 10 * HOUR, nowMs: NOW, intervalMs: HOUR })).toBe(true);
  });

  it('REGRESSION: still fires when the host restarts more often than the interval', () => {
    // THE BUG. The old gate counted 30s ticks in a module-scoped `let`, so reaching
    // 120 needed 60 uninterrupted minutes of uptime. A host restarting every ~50min
    // ran the census and the GC exactly ZERO times, forever, with no error and no log.
    // Simulate that churn: uptime never reaches the interval, but real elapsed time
    // does — and the watermark, unlike a counter, survives the restarts.
    const restartEveryMs = 50 * 60_000;
    const lastRunAtMs = NOW;
    let clock = NOW;
    let fired = false;

    for (let restart = 0; restart < 5; restart += 1) {
      clock += restartEveryMs; // a fresh process; an in-process counter would reset here
      if (isMaintDue({ lastAtMs: lastRunAtMs, nowMs: clock, intervalMs: HOUR })) fired = true;
    }

    expect(fired).toBe(true);
  });

  it('a null watermark makes a restart run the job SOONER, never never', () => {
    // The GC leg carries no persisted watermark on purpose: `null` at process start
    // answers due, so churn accelerates it instead of silencing it.
    expect(isMaintDue({ lastAtMs: null, nowMs: NOW, intervalMs: HOUR })).toBe(true);
    expect(isMaintDue({ lastAtMs: NOW, nowMs: NOW, intervalMs: HOUR })).toBe(false);
  });
});
