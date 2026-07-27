/**
 * WI-559 / EI-18775450536624845 — the joiner FK-parent reconcile.
 *
 * These tests pin the GUARDS, not just the happy path: every one of them is a
 * failure mode that was reasoned about while choosing this design, and several
 * encode a way the "obvious" fix would have REGRESSED something that works today.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  reconcilePotCanonicalSlug,
  reconcileAllJoinedPotCanonicalSlugs,
  type ReconcilePotCanonicalSlugDeps,
} from './pot-canonical-slug-reconcile';

const OWNER_SLUG = 'spoon-knife-pot';
const JOINER_SLUG = 'octocat-spoon-knife';
const PUBKEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const WS = 'workspace-b31a7a01';

function deps(
  over: {
    projects?: Array<Record<string, unknown>>;
    pot?: Record<string, unknown> | null;
    announced?: string | null;
    setResult?: unknown;
  } = {},
): { d: ReconcilePotCanonicalSlugDeps; setCanonical: ReturnType<typeof vi.fn> } {
  const setCanonical = vi.fn(async () =>
    (over.setResult ?? { ok: true, changed: true, record: {} }) as never,
  );
  const d: ReconcilePotCanonicalSlugDeps = {
    loadRegistry: (async () => ({
      projects: over.projects ?? [{ slug: JOINER_SLUG, remote_hive: true }],
    })) as never,
    getPotBySlug: (async () =>
      over.pot === undefined
        ? ({
            homeSlug: JOINER_SLUG,
            canonicalHomeSlug: JOINER_SLUG,
            pubkeyBase64: PUBKEY,
            keychainId: `remote:${PUBKEY}`,
          } as never)
        : (over.pot as never)) as never,
    loadAnnouncedSlug: (async () =>
      (over.announced === undefined ? OWNER_SLUG : over.announced) as never) as never,
    setCanonical: setCanonical as never,
  };
  return { d, setCanonical };
}

// A successful rebind logs a deliberate operator-facing receipt; the repo fails a
// test on an unexpected console.warn, so capture it and assert it instead.
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe('reconcilePotCanonicalSlug — the WI-559 FK-parent repair', () => {
  it('stamps the OWNER-announced slug on a joiner whose local handle diverged', async () => {
    const { d, setCanonical } = deps();
    const res = await reconcilePotCanonicalSlug(WS, JOINER_SLUG, d);

    expect(res).toMatchObject({ ok: true, changed: true, canonical: OWNER_SLUG });
    // The receipt an operator correlates against the roster filling in.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[pot-canonical-slug]'));
    // The LOCAL handle is passed through untouched — renaming it is precisely what
    // this design avoids (it would desync the registry + the substrate rows the
    // live rig proved the view actually carries).
    expect(setCanonical).toHaveBeenCalledWith(WS, JOINER_SLUG, OWNER_SLUG);
  });

  it('is a no-op WRITE when the row already names the announced slug (idempotent — it runs every boot)', async () => {
    const { d, setCanonical } = deps({
      pot: {
        homeSlug: JOINER_SLUG,
        canonicalHomeSlug: OWNER_SLUG,
        pubkeyBase64: PUBKEY,
        keychainId: `remote:${PUBKEY}`,
      },
    });
    const res = await reconcilePotCanonicalSlug(WS, JOINER_SLUG, d);

    expect(res).toMatchObject({ ok: true, changed: false });
    expect(setCanonical).not.toHaveBeenCalled();
  });

  it('REFUSES an owned Pot — it is the authority for its own slug, and rebinding it would double-apply its own rows as remote', async () => {
    const { d, setCanonical } = deps({
      projects: [{ slug: OWNER_SLUG, remote_hive: false }],
    });
    const res = await reconcilePotCanonicalSlug(WS, OWNER_SLUG, d);

    expect(res).toMatchObject({ ok: false, reason: 'not_a_joined_view' });
    expect(setCanonical).not.toHaveBeenCalled();
  });

  it('REFUSES when no announce resolves — a guessed/synthetic potId must never become the demux key', async () => {
    // loadAnnouncedHiveHomeSlug returns null for a potIdSynthetic descriptor; this
    // asserts we fail OPEN on that rather than inventing a slug.
    const { d, setCanonical } = deps({ announced: null });
    const res = await reconcilePotCanonicalSlug(WS, JOINER_SLUG, d);

    expect(res).toMatchObject({ ok: false, reason: 'no_announced_slug' });
    expect(setCanonical).not.toHaveBeenCalled();
  });

  it('fails OPEN (never throws) when the identity row is missing', async () => {
    const { d, setCanonical } = deps({ pot: null });
    const res = await reconcilePotCanonicalSlug(WS, JOINER_SLUG, d);

    expect(res).toMatchObject({ ok: false, reason: 'no_identity_row' });
    expect(setCanonical).not.toHaveBeenCalled();
  });

  it('surfaces a slug COLLISION as a typed refusal instead of forcing two identity rows onto one federated scope', async () => {
    const { d } = deps({ setResult: { ok: false, reason: 'canonical_taken' } });
    const res = await reconcilePotCanonicalSlug(WS, JOINER_SLUG, d);

    expect(res).toMatchObject({ ok: false, reason: 'canonical_taken' });
  });

  it('swallows a PG fault — this runs on the boot path and must never break a working Pot', async () => {
    const { d } = deps();
    d.getPotBySlug = (async () => {
      throw new Error('connection reset');
    }) as never;
    const res = await reconcilePotCanonicalSlug(WS, JOINER_SLUG, d);

    expect(res).toMatchObject({ ok: false, reason: 'error' });
    expect((res as { detail?: string }).detail).toContain('connection reset');
  });

  it('falls back to the registry-stamped hive_pubkey when the identity row carries none', async () => {
    const { d, setCanonical } = deps({
      projects: [{ slug: JOINER_SLUG, remote_hive: true, hive_pubkey: PUBKEY }],
      pot: {
        homeSlug: JOINER_SLUG,
        canonicalHomeSlug: JOINER_SLUG,
        pubkeyBase64: undefined,
        keychainId: `remote:${PUBKEY}`,
      },
    });
    const res = await reconcilePotCanonicalSlug(WS, JOINER_SLUG, d);

    expect(res).toMatchObject({ ok: true, changed: true, canonical: OWNER_SLUG });
    expect(setCanonical).toHaveBeenCalled();
  });
});

describe('reconcileAllJoinedPotCanonicalSlugs — the boot sweep', () => {
  it('reconciles every joined view and skips owned Pots', async () => {
    const { d, setCanonical } = deps({
      projects: [
        { slug: JOINER_SLUG, remote_hive: true },
        { slug: 'another-view', remote_hive: true },
        { slug: 'my-own-pot', remote_hive: false },
      ],
    });
    const res = await reconcileAllJoinedPotCanonicalSlugs(WS, d);

    expect(res.reconciled).toBe(2);
    expect(res.changed).toBe(2);
    expect(setCanonical).toHaveBeenCalledTimes(2);
    expect(setCanonical.mock.calls.map((c) => c[1])).toEqual([JOINER_SLUG, 'another-view']);
  });

  it('one failing view never aborts the sweep', async () => {
    let n = 0;
    const { d } = deps({
      projects: [
        { slug: 'bad-view', remote_hive: true },
        { slug: JOINER_SLUG, remote_hive: true },
      ],
    });
    d.getPotBySlug = (async () => {
      if (n++ === 0) throw new Error('boom');
      return {
        homeSlug: JOINER_SLUG,
        canonicalHomeSlug: JOINER_SLUG,
        pubkeyBase64: PUBKEY,
        keychainId: `remote:${PUBKEY}`,
      } as never;
    }) as never;

    const res = await reconcileAllJoinedPotCanonicalSlugs(WS, d);
    expect(res.results).toHaveLength(2);
    expect(res.results[0]).toMatchObject({ ok: false, reason: 'error' });
    expect(res.results[1]).toMatchObject({ ok: true });
  });

  it('returns an empty sweep (never throws) when the registry is unreadable', async () => {
    const { d } = deps();
    d.loadRegistry = (async () => {
      throw new Error('registry gone');
    }) as never;

    await expect(reconcileAllJoinedPotCanonicalSlugs(WS, d)).resolves.toEqual({
      reconciled: 0,
      changed: 0,
      results: [],
    });
  });
});
