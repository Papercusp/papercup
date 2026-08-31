/**
 * listening-socket-apps — socket → workspace-app attribution (EI-21967021435856392).
 *
 * The project fixtures below reproduce the SHAPE of real `harness_registry` rows
 * observed on 2026-08-31 — slugs verbatim, roots anonymized (a hardcoded home
 * path in shipped source reds the identity-lint gate). The two shapes are what
 * the matcher actually has to survive, so neither is incidental:
 *   • `…/apps/portal` sits beside `…/apps/portal-checkpoint`
 *   • `…/papercusp` CONTAINS `…/papercusp/libs/papercusp`
 * Tidied-away sibling names would test a registry this join never sees.
 */
import { describe, it, expect } from 'vitest';
import {
  attributeSocket,
  isWithinPath,
  matchProjectForPath,
  viewableUrl,
  type AppProject,
  type AttributableSocket,
} from './listening-socket-apps';

const APPS = '/w/.papercusp-workspaces/papercusp-workspace/.papercusp/apps';
const REPO = '/w/workspace/papercusp';

/** Verbatim registry project rows (slug + path only, which is all the join reads). */
const PROJECTS: AppProject[] = [
  { slug: 'portal', path: `${APPS}/portal` },
  { slug: 'email', path: `${APPS}/email` },
  { slug: 'panda-gallery', path: `${APPS}/panda-gallery` },
  { slug: 'papercusp', path: REPO },
  { slug: 'papercusp/libs/papercusp', path: `${REPO}/libs/papercusp` },
  { slug: 'papercusp/papercusp-desktop', path: `${REPO}/papercusp-desktop` },
];

/** A socket with a readable owner, as `parseSsOutput` would produce it. */
function socket(over: Partial<AttributableSocket> = {}): AttributableSocket {
  return { port: 3801, address: '127.0.0.1', pid: 1545472, pids: [1545472], ownerVisible: true, ...over };
}

const cwdOf = (map: Record<number, string>) => (pid: number) => map[pid] ?? null;

describe('isWithinPath', () => {
  it('matches a path against itself and its descendants', () => {
    expect(isWithinPath(`${APPS}/portal`, `${APPS}/portal`)).toBe(true);
    expect(isWithinPath(`${APPS}/portal`, `${APPS}/portal/src/app`)).toBe(true);
  });

  it('does NOT match a sibling that merely shares a name prefix', () => {
    // The bug this guards: `portal-checkpoint` is a real directory beside
    // `portal`, so a naive startsWith() attributes the checkpoint tree's
    // sockets to the live app — and sends someone to edit the wrong tree.
    expect(isWithinPath(`${APPS}/portal`, `${APPS}/portal-checkpoint`)).toBe(false);
    expect(isWithinPath(`${APPS}/portal`, `${APPS}/portal-checkpoint/src`)).toBe(false);
  });

  it('ignores a trailing slash on either side', () => {
    expect(isWithinPath(`${APPS}/portal/`, `${APPS}/portal`)).toBe(true);
    expect(isWithinPath(`${APPS}/portal`, `${APPS}/portal/`)).toBe(true);
  });
});

describe('matchProjectForPath', () => {
  it('resolves an app from a cwd inside it', () => {
    expect(matchProjectForPath(`${APPS}/portal`, PROJECTS)?.slug).toBe('portal');
    expect(matchProjectForPath(`${APPS}/email/src/pages`, PROJECTS)?.slug).toBe('email');
  });

  it('prefers the LONGEST match when projects nest', () => {
    // Both `papercusp` and `papercusp/libs/papercusp` contain this cwd; the
    // sub-harness is the honest answer.
    expect(matchProjectForPath(`${REPO}/libs/papercusp/libs/db`, PROJECTS)?.slug).toBe(
      'papercusp/libs/papercusp',
    );
    expect(matchProjectForPath(`${REPO}/packages/operator-core`, PROJECTS)?.slug).toBe('papercusp');
  });

  it('returns null for a cwd outside every project', () => {
    expect(matchProjectForPath('/tmp/scratch', PROJECTS)).toBeNull();
  });
});

describe('viewableUrl', () => {
  it('rewrites wildcard binds to loopback — 0.0.0.0 is not dialable', () => {
    expect(viewableUrl('0.0.0.0', 3170)).toBe('http://127.0.0.1:3170');
    expect(viewableUrl('*', 3170)).toBe('http://127.0.0.1:3170');
    expect(viewableUrl('::', 80)).toBe('http://[::1]:80');
  });

  it('keeps a specific address, bracketing ipv6', () => {
    expect(viewableUrl('127.0.0.1', 3801)).toBe('http://127.0.0.1:3801');
    expect(viewableUrl('::1', 6010)).toBe('http://[::1]:6010');
  });
});

describe('attributeSocket', () => {
  it('answers the motivating question: which URL serves the portal', () => {
    const result = attributeSocket(
      socket(),
      PROJECTS,
      cwdOf({ 1545472: `${APPS}/portal` }),
    );
    expect(result.app).toEqual({ slug: 'portal', path: `${APPS}/portal` });
    expect(result.localUrl).toBe('http://127.0.0.1:3801');
    expect(result.appUnknownReason).toBeNull();
  });

  it('attributes the checkpoint tree to the checkpoint app, not the live one', () => {
    // Same guard as isWithinPath, exercised through the real entry point: the
    // checkpoint path is not a registered project here, so the honest answer is
    // "no project" — emphatically NOT "portal".
    const result = attributeSocket(
      socket({ port: 3899, pid: 999, pids: [999] }),
      PROJECTS,
      cwdOf({ 999: `${APPS}/portal-checkpoint` }),
    );
    expect(result.app).toBeNull();
    expect(result.appUnknownReason).toBe('no-registry-project');
  });

  it('reports an unreadable owner as unreadable, never as unattributed', () => {
    const result = attributeSocket(
      socket({ pid: null, pids: [], ownerVisible: false, port: 5432, address: '0.0.0.0' }),
      PROJECTS,
      () => {
        throw new Error('cwd must not be read for an invisible owner');
      },
    );
    expect(result.app).toBeNull();
    expect(result.appUnknownReason).toBe('owner-not-visible');
    // Still answerable without an owner — the port IS bound.
    expect(result.localUrl).toBe('http://127.0.0.1:5432');
  });

  it('distinguishes a FAILED registry read from a genuine no-match', () => {
    // The failure this separates: `registry-unavailable` read as "no app owns
    // this port" is a confident wrong answer about every row at once.
    const unavailable = attributeSocket(socket(), null, cwdOf({ 1545472: `${APPS}/portal` }));
    expect(unavailable.appUnknownReason).toBe('registry-unavailable');

    const empty = attributeSocket(socket(), [], cwdOf({ 1545472: `${APPS}/portal` }));
    expect(empty.appUnknownReason).toBe('no-registry-project');
  });

  it('separates an unreadable cwd from a cwd outside every project', () => {
    const unreadable = attributeSocket(socket(), PROJECTS, () => null);
    expect(unreadable.appUnknownReason).toBe('cwd-unreadable');

    const outside = attributeSocket(socket(), PROJECTS, cwdOf({ 1545472: '/tmp/scratch' }));
    expect(outside.appUnknownReason).toBe('no-registry-project');
  });

  it('resolves a SO_REUSEPORT group when only a later worker is still readable', () => {
    // The representative pid can exit between the `ss` read and the /proc read;
    // a group with one readable worker is still a resolvable group.
    const result = attributeSocket(
      socket({ pid: 47585, pids: [47585, 47586, 47587], port: 3170, address: '0.0.0.0' }),
      PROJECTS,
      cwdOf({ 47587: `${REPO}/packages/operator-core` }),
    );
    expect(result.app?.slug).toBe('papercusp');
    expect(result.localUrl).toBe('http://127.0.0.1:3170');
  });

  it('never trusts a declared port over the observed socket', () => {
    // The portal's package.json says `next dev --webpack` (Next default 3000)
    // and its /proc environ carries PORT=3070 inherited from the operator that
    // spawned it, while it actually serves 3801. Attribution reads the SOCKET,
    // so the reported URL is the one that works.
    const result = attributeSocket(socket({ port: 3801 }), PROJECTS, cwdOf({ 1545472: `${APPS}/portal` }));
    expect(result.localUrl).toContain(':3801');
    expect(result.localUrl).not.toContain('3000');
    expect(result.localUrl).not.toContain('3070');
  });
});
