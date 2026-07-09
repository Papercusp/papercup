import { describe, it, expect, afterEach } from 'vitest';
import {
  bakedCanonicalHiveInvite,
  joinCanonicalPapercuspHive,
  type CanonicalHiveInvite,
  type JoinCanonicalDeps,
} from './papercusp-hive-join';
import { CANONICAL_PAPERCUSP_HIVE_INVITE } from './canonical-hive-invite';

const okId = async () => ({ kind: 'ok' as const, token: 'tok', githubUserId: 7, githubLogin: 'aviynw' });
const INVITE: CanonicalHiveInvite = { pubkeyBase64: 'PUB==', inviteSecret: 'sec' };

describe('bakedCanonicalHiveInvite', () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
  });

  it('explicit override wins', () => {
    expect(bakedCanonicalHiveInvite(INVITE)).toEqual(INVITE);
  });
  it('reads env when BOTH present', () => {
    process.env.PAPERCUP_DOGFOOD_HIVE_PUBKEY = 'P';
    process.env.PAPERCUP_DOGFOOD_HIVE_INVITE_SECRET = 'S';
    expect(bakedCanonicalHiveInvite()).toEqual({ pubkeyBase64: 'P', inviteSecret: 'S' });
  });
  it('falls back to the committed canonical constant when env is unset', () => {
    delete process.env.PAPERCUP_DOGFOOD_HIVE_PUBKEY;
    delete process.env.PAPERCUP_DOGFOOD_HIVE_INVITE_SECRET;
    expect(bakedCanonicalHiveInvite()).toEqual(CANONICAL_PAPERCUSP_HIVE_INVITE);
  });
  it('falls back to the committed constant when only one env var is present', () => {
    process.env.PAPERCUP_DOGFOOD_HIVE_PUBKEY = 'P';
    delete process.env.PAPERCUP_DOGFOOD_HIVE_INVITE_SECRET;
    expect(bakedCanonicalHiveInvite()).toEqual(CANONICAL_PAPERCUSP_HIVE_INVITE);
  });
});

describe('joinCanonicalPapercuspHive', () => {
  const baseDeps = (over: Partial<JoinCanonicalDeps> = {}): JoinCanonicalDeps => ({
    resolveGithub: okId,
    ensureWired: async () => ({
      joinInviteTopic: async () => undefined,
      confirmInviteAnnounce: async () => ({
        found: true,
        hive: { potId: 'papercusp', hivePubkey: 'PUB==', memberLinks: ['link1'] },
      }),
    }),
    joinHive: async () => ({ ok: true, potSlug: 'papercusp' }),
    setHomeWorkspace: () => {},
    ...over,
  });

  it('gh unauth → skipped + parks on the sign-in prompt', async () => {
    const records: Array<[string, string, { detail?: string } | undefined]> = [];
    const res = await joinCanonicalPapercuspHive(INVITE, {
      ...baseDeps(),
      resolveGithub: async () => ({ kind: 'gh_auth_required' as const }),
      record: (s, st, e) => records.push([s, st, e]),
    });
    expect(res.state).toBe('skipped');
    expect(records.some((r) => /sign in to github/i.test(r[2]?.detail ?? ''))).toBe(true);
  });

  it('no directory wiring → skipped', async () => {
    const res = await joinCanonicalPapercuspHive(INVITE, { ...baseDeps(), ensureWired: async () => null });
    expect(res.state).toBe('skipped');
  });

  it('owner offline (confirm not found) → skipped', async () => {
    const res = await joinCanonicalPapercuspHive(INVITE, {
      ...baseDeps(),
      ensureWired: async () => ({ joinInviteTopic: async () => undefined, confirmInviteAnnounce: async () => ({ found: false }) }),
      listDiscovered: async () => [],
    });
    expect(res.state).toBe('skipped');
    expect(res.reason).toContain('owner offline');
  });

  // ── WI-1585 (LIVE-1 Avis-iMac strand) — defect A regressions ──────────────
  // confirmInviteAnnounce only reports a hive that NEWLY appears in its window;
  // an announce already in the (PG-hydrated) discovered cache is in its `seen`
  // snapshot and can never be "found". The join must fall through to the
  // pubkey-PINNED cache match instead of stranding "owner offline" forever.
  it('WI-1585: confirm miss + pubkey-pinned CACHED announce → joins from the cache', async () => {
    let joined: { hivePubkey?: string; memberLinks?: string[] } | undefined;
    const res = await joinCanonicalPapercuspHive(INVITE, {
      ...baseDeps(),
      ensureWired: async () => ({
        joinInviteTopic: async () => undefined,
        confirmInviteAnnounce: async () => ({ found: false }),
      }),
      listDiscovered: async () => [
        { potId: 'papercusp', hivePubkey: 'PUB==', memberLinks: ['cached-link'] },
      ],
      joinHive: async (o) => {
        joined = o;
        return { ok: true, potSlug: 'papercusp' };
      },
    });
    expect(res.state).toBe('joined');
    expect(res.slug).toBe('papercusp');
    expect(joined?.memberLinks).toEqual(['cached-link']);
    // The hives-row identity stays PINNED to the baked pubkey (P-003).
    expect(joined?.hivePubkey).toBe('PUB==');
  });

  it('WI-1585: confirm miss + cached NON-canonical pubkey → still skips (never joins the wrong hive)', async () => {
    let joinCalled = false;
    const res = await joinCanonicalPapercuspHive(INVITE, {
      ...baseDeps(),
      ensureWired: async () => ({
        joinInviteTopic: async () => undefined,
        confirmInviteAnnounce: async () => ({ found: false }),
      }),
      listDiscovered: async () => [
        { potId: 'papercusp', hivePubkey: 'EVIL==', memberLinks: ['hijack-link'] },
      ],
      joinHive: async () => {
        joinCalled = true;
        return { ok: true, potSlug: 'papercusp' };
      },
    });
    expect(res.state).toBe('skipped');
    expect(res.reason).toContain('owner offline');
    expect(joinCalled).toBe(false);
  });

  it('found + member-links → joins → joined', async () => {
    let joined: { memberLinks?: string[]; workspaceId?: string } | undefined;
    const res = await joinCanonicalPapercuspHive(INVITE, {
      ...baseDeps(),
      joinHive: async (o) => {
        joined = o;
        return { ok: true, potSlug: 'papercusp' };
      },
    });
    expect(res.state).toBe('joined');
    expect(res.slug).toBe('papercusp');
    expect(joined?.memberLinks).toEqual(['link1']);
    expect(joined?.workspaceId).toBeTruthy();
  });

  it('falls back to listDiscovered for member-links when the confirm omits them', async () => {
    let joined: { memberLinks?: string[] } | undefined;
    const res = await joinCanonicalPapercuspHive(INVITE, {
      ...baseDeps(),
      ensureWired: async () => ({
        joinInviteTopic: async () => undefined,
        confirmInviteAnnounce: async () => ({ found: true, hive: { potId: 'papercusp', memberLinks: [] } }),
      }),
      listDiscovered: async () => [{ potId: 'papercusp', hivePubkey: 'PUB==', memberLinks: ['link2'] }],
      joinHive: async (o) => {
        joined = o;
        return { ok: true, potSlug: 'papercusp' };
      },
    });
    expect(res.state).toBe('joined');
    expect(joined?.memberLinks).toEqual(['link2']);
  });

  it('join failure → skipped', async () => {
    const res = await joinCanonicalPapercuspHive(INVITE, {
      ...baseDeps(),
      joinHive: async () => ({ ok: false, error: 'boom' }),
    });
    expect(res.state).toBe('skipped');
    expect(res.reason).toContain('boom');
  });

  it('never throws on an internal error', async () => {
    const res = await joinCanonicalPapercuspHive(INVITE, {
      ...baseDeps(),
      ensureWired: async () => {
        throw new Error('wire boom');
      },
    });
    expect(res.state).toBe('skipped');
  });

  it('a hung wire is bounded → skipped + advances off 5% (the dogfood stall fix)', async () => {
    const records: Array<[string, string, { percent?: number; detail?: string } | undefined]> = [];
    const res = await joinCanonicalPapercuspHive(INVITE, {
      ...baseDeps(),
      // ensureWired never settles — the exact failure mode that froze the bar at 5%.
      ensureWired: (() => new Promise(() => {})) as unknown as JoinCanonicalDeps['ensureWired'],
      wireTimeoutMs: 60,
      record: (s, st, e) => records.push([s, st, e]),
    });
    expect(res.state).toBe('skipped');
    expect(res.reason).toMatch(/stalled/);
    // Must move the bar OFF 5% so the banner doesn't read "connecting (5%)" forever.
    expect(records.some((r) => r[2]?.percent === 10)).toBe(true);
  }, 5_000);
});
