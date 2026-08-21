import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * EI-19306394439939264 / WI-6739 — a cached pool must never outlive the URL that built it.
 *
 * On 2026-08-01 the operator logged 20,144 × `connect ECONNREFUSED 127.0.0.1:20216` for
 * ~100 minutes against a dead embedded-pg port. The outage was self-healable and did not
 * self-heal: `getHarnessAdminUrl()` had already started returning the healthy native
 * `:5432` fallback, but the hand-rolled module pools compared against nothing and stayed
 * bound to what they were built with until a manual restart.
 *
 * These tests pin the rebind, so a refactor that reintroduces a plain `let pool` cache
 * fails here rather than during the next outage.
 */

// The real module opens sockets; we only care about WHICH url each build received.
const built: string[] = [];
const builtOpts: Record<string, unknown>[] = [];
const ended: string[] = [];

/**
 * What the store at each URL reports as its identity. Keying this BY URL is the whole
 * point of the WI-7180 fixture: an impostor is a different CLUSTER reachable at a
 * different ADDRESS, and the defect is that address-shaped guards cannot tell the two
 * apart. A URL with no entry reports nothing readable → `indeterminate`.
 */
let identityByUrl: Record<string, { system_identifier: string; database: string }> = {};
/** Set to make the driver's `.unsafe` blow up, proving the probe cannot break the pool. */
let unsafeThrows = false;

vi.mock('postgres', () => ({
  default: (url: string, opts: Record<string, unknown>) => {
    built.push(url);
    builtOpts.push(opts);
    return {
      __url: url,
      end: async () => { ended.push(url); },
      unsafe: (_q: string) => {
        if (unsafeThrows) throw new Error('driver has no unsafe()');
        const row = identityByUrl[url];
        return Promise.resolve(row ? [row] : []);
      },
    };
  },
}));

let currentUrl = 'postgresql://u:p@127.0.0.1:20216/papercusp';
vi.mock('./embedded-pg-discovery', () => ({
  getHarnessAdminUrl: () => currentUrl,
}));

// Use the REAL endStalePool — the whole point is that this wiring actually invokes the
// primitive, not a stand-in that trivially agrees with the assertion. Same reasoning for
// the store-identity state machine below: it is pure by design (no postgres import, no
// I/O), so the real one drops straight in and the wiring is tested against the actual
// primitive rather than a re-implementation that would agree with itself.
vi.mock('@papercusp/db-org', async (orig) => {
  const endStalePool = (client: unknown, builtWith: string | null, url: string) => {
    if (!client || builtWith === url) return false;
    void (client as { end: () => Promise<void> }).end();
    return true;
  };
  const identity = await import('../../../libs/papercusp/libs/db/src/store-identity');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    endStalePool,
    longLivedPoolConnectionOptions: (label: string) => ({ onnotice: () => {}, connection: { application_name: label } }),
    poolIdleTimeoutSec: () => 30,
    STORE_IDENTITY_SQL: identity.STORE_IDENTITY_SQL,
    parseStoreIdentity: identity.parseStoreIdentity,
    pinOrVerifyStoreIdentity: identity.pinOrVerifyStoreIdentity,
    describeStoreIdentityMismatch: identity.describeStoreIdentityMismatch,
  };
});

import {
  _resetStoreIdentityForTests,
  storeIdentityViolation,
  pinnedStoreIdentity,
} from '../../../libs/papercusp/libs/db/src/store-identity';

/** The probe is fire-and-forget, so let its microtasks settle before asserting. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const NATIVE = 'postgresql://u:p@localhost:5432/papercusp';
const IMPOSTOR = 'postgresql://u:p@127.0.0.1:22826/papercusp';
/** initdb assigns these; two independently-created clusters cannot share one. */
const OURS = { system_identifier: '7401111111111111111', database: 'papercusp' };
const THEIRS = { system_identifier: '7409999999999999999', database: 'papercusp' };

let mod: typeof import('./long-lived-admin-pool');
beforeEach(async () => {
  built.length = 0;
  builtOpts.length = 0; // must reset too — else builtOpts[0] is test #1's build, not this test's
  ended.length = 0;
  currentUrl = 'postgresql://u:p@127.0.0.1:20216/papercusp';
  identityByUrl = {};
  unsafeThrows = false;
  _resetStoreIdentityForTests();
  mod = await import('./long-lived-admin-pool');
  mod._resetLongLivedAdminPoolsForTests();
});
afterEach(() => void vi.clearAllMocks());

describe('getLongLivedAdminPool — endpoint rebind (EI-19306394439939264)', () => {
  it('builds once and reuses the SAME instance while the URL is stable', () => {
    const a = mod.getLongLivedAdminPool('probe');
    const b = mod.getLongLivedAdminPool('probe');
    expect(a).toBe(b);
    expect(built).toHaveLength(1);
    expect(ended).toHaveLength(0); // a stable endpoint must never churn the pool
  });

  it('THE 2026-08-01 CASE: rebuilds onto the new endpoint when the resolved URL moves', () => {
    const stale = mod.getLongLivedAdminPool('probe');
    expect(mod.boundAdminPoolUrl('probe')).toContain(':20216');

    // The desktop's embedded PG dies; discovery falls back to healthy native :5432.
    currentUrl = 'postgresql://u:p@localhost:5432/papercusp';

    const fresh = mod.getLongLivedAdminPool('probe');
    expect(fresh).not.toBe(stale); // the bug was returning `stale` here, forever
    expect(mod.boundAdminPoolUrl('probe')).toContain(':5432');
    expect(built).toEqual([
      'postgresql://u:p@127.0.0.1:20216/papercusp',
      'postgresql://u:p@localhost:5432/papercusp',
    ]);
    // and the dead pool is drained rather than leaked
    expect(ended).toEqual(['postgresql://u:p@127.0.0.1:20216/papercusp']);
  });

  it('keeps labels independent — rebinding one pool does not disturb another', () => {
    const other = mod.getLongLivedAdminPool('other');
    mod.getLongLivedAdminPool('probe');
    currentUrl = 'postgresql://u:p@localhost:5432/papercusp';

    mod.getLongLivedAdminPool('probe'); // rebinds
    expect(mod.getLongLivedAdminPool('other')).not.toBe(other); // 'other' re-resolves too
    expect(mod.boundAdminPoolUrl('other')).toContain(':5432');
  });

  it('applies idle_timeout + attribution for the call site, and lets its own options win', () => {
    // Regression guard for the past saturation crit: postgres-js defaults idle_timeout to
    // 0 = never close, so a migrated site must not silently lose the drain. Supplying it
    // centrally is the reason a call site can no longer forget it.
    mod.getLongLivedAdminPool('opts-probe', { max: 4, prepare: false });
    const opts = builtOpts[0];
    expect(opts.idle_timeout).toBe(30);
    expect((opts.connection as Record<string, string>).application_name).toBe('opts-probe');
    expect(opts.max).toBe(4);
    expect(opts.prepare).toBe(false);
  });

  it('a call site may override a centrally-supplied default (extras are spread last)', () => {
    mod.getLongLivedAdminPool('override-probe', { idle_timeout: 5 });
    expect(builtOpts[0].idle_timeout).toBe(5);
  });
});

/**
 * WI-7180 — generation 3 (IDENTITY) on this seam.
 *
 * The rebind tests above are generation 2, and they are exactly what these tests must show
 * to be INSUFFICIENT: a rebind is the correct response to an endpoint that moved, so a
 * store capture presents to generations 1 and 2 as a perfectly ordinary, healthy move.
 * The guard has to answer a question neither of them asks — *is the store at the new
 * address the same store?* — without disturbing the move itself.
 */
describe('getLongLivedAdminPool — store identity (WI-7180)', () => {
  it('THE 2026-08-02 CASE: a rebind onto a DIFFERENT cluster is detected and latched', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    identityByUrl = { [NATIVE]: OURS, [IMPOSTOR]: THEIRS };

    // Boot on the trusted native store. This is what establishes the pin — and a pin that
    // is never established cannot later disagree, which is why the probe runs on the FIRST
    // build and not only on rebinds.
    currentUrl = NATIVE;
    mod.getLongLivedAdminPool('probe');
    await flush();
    expect(pinnedStoreIdentity()?.systemIdentifier).toBe(OURS.system_identifier);
    expect(storeIdentityViolation()).toBeNull();

    // A desktop boots and rewrites ~/.papercusp/embedded-pg.json with its own embedded PG.
    // That endpoint is genuinely alive, listening and freshly migrated — so every
    // address-shaped guard passes and the pool rebinds onto it, exactly as designed.
    currentUrl = IMPOSTOR;
    mod.getLongLivedAdminPool('probe');
    await flush();

    // Generations 1 and 2 did their job and saw nothing wrong: the pool moved, happily.
    expect(built).toEqual([NATIVE, IMPOSTOR]);
    expect(ended).toEqual([NATIVE]);

    // Generation 3 is the only one that can see it.
    const v = storeIdentityViolation();
    expect(v).not.toBeNull();
    expect(v!.pinned.systemIdentifier).toBe(OURS.system_identifier);
    expect(v!.observed.systemIdentifier).toBe(THEIRS.system_identifier);
    // The operator-facing message must name the pool and kill the data-loss reading, since
    // the entire cost of this failure last time was that it presented as missing records.
    const msg = err.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('WRONG STORE');
    expect(msg).toContain('pool: probe');
    expect(msg).toContain('NOT evidence of data loss');
    err.mockRestore();
  });

  it('a legitimately-moving embedded port on the SAME cluster stays silent', async () => {
    // The constraint that makes this guard non-trivial. The desktop picks a new free PG
    // port every boot, and the resolver re-resolves on every call precisely so a consumer
    // is never pinned to a previous launch's dead port (the Windows wedge that
    // embedded-pg-discovery's re-resolution contract exists to prevent). A guard that
    // refused to follow a moving port would reintroduce that wedge.
    //
    // `system_identifier` is immune by construction: initdb assigns it once and it
    // survives restarts and port changes, so our own store moving addresses is a MATCH,
    // not a mismatch.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const oldPort = 'postgresql://u:p@127.0.0.1:22826/papercusp';
    const newPort = 'postgresql://u:p@127.0.0.1:22060/papercusp';
    identityByUrl = { [oldPort]: OURS, [newPort]: OURS };

    currentUrl = oldPort;
    mod.getLongLivedAdminPool('probe');
    await flush();

    currentUrl = newPort;
    mod.getLongLivedAdminPool('probe');
    await flush();

    // The rebind still happens — re-resolution is preserved, not suppressed.
    expect(built).toEqual([oldPort, newPort]);
    // ...and it is silent, because it is the same store.
    expect(storeIdentityViolation()).toBeNull();
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('an unreadable identity is INDETERMINATE: it never pins and never latches', async () => {
    // "A check that cannot run must never reject a healthy configuration" — the same rule
    // the generic resolver's listeningPorts() already follows. An old server, a missing
    // column or a failed probe must change nothing at all.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    identityByUrl = {}; // nothing readable anywhere

    currentUrl = NATIVE;
    mod.getLongLivedAdminPool('probe');
    await flush();
    currentUrl = IMPOSTOR;
    mod.getLongLivedAdminPool('probe');
    await flush();

    expect(pinnedStoreIdentity()).toBeNull();
    expect(storeIdentityViolation()).toBeNull();
    expect(err).not.toHaveBeenCalled();
    expect(built).toEqual([NATIVE, IMPOSTOR]); // and the pool behaves exactly as before
    err.mockRestore();
  });

  it('a probe that throws cannot affect the pool it is observing', async () => {
    // Fire-and-forget and fully swallowed: wiring a diagnostic into this seam must not be
    // able to turn a driver quirk into an outage.
    unsafeThrows = true;
    currentUrl = NATIVE;
    const a = mod.getLongLivedAdminPool('probe');
    await flush();
    expect(a).toBeTruthy();
    expect(mod.boundAdminPoolUrl('probe')).toBe(NATIVE);
    expect(mod.getLongLivedAdminPool('probe')).toBe(a); // still cached and reusable
    expect(storeIdentityViolation()).toBeNull();
  });

  it('probes on the FIRST build too — otherwise the first impostor seen becomes the pin', async () => {
    // If only rebinds were probed, a process that happened to boot while the discovery
    // file already pointed at an impostor would pin the impostor and legitimise it, and
    // every later comparison would be against the wrong baseline.
    identityByUrl = { [NATIVE]: OURS };
    currentUrl = NATIVE;
    mod.getLongLivedAdminPool('first-build');
    await flush();
    expect(pinnedStoreIdentity()?.systemIdentifier).toBe(OURS.system_identifier);
  });
});
