/**
 * join-invite.test.ts — POST /api/discovery/join-invite (hive-from-repo-
 * hardening P-006 / D-006), the invitee side of a hive invite artifact.
 *
 * Verifies: strict link validation (400 on malformed, the wiring never
 * touched), the joinInviteTopic call with the EXACT secret from the link,
 * the gh-unauthed 503 `directory_unavailable`, and the loopback auth tier.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import joinInviteRoute from './join-invite';
import { formatHiveInviteLink } from '../../../harness/hive-invite-link';
import type { HiveDirectoryWiring } from '../../../hive-directory-boot';

const joined: string[] = [];
let wiring: Pick<HiveDirectoryWiring, 'joinInviteTopic'> | null = null;

vi.mock('../../../hive-directory-boot', () => ({
  ensureHiveDirectoryWired: vi.fn(async () => wiring),
}));
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-test',
}));

const SECRET = 'deadbeef'.repeat(4); // 32 hex chars

async function post(body: unknown) {
  const req = new Request('http://127.0.0.1/api/discovery/join-invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = (await joinInviteRoute.handler(req as never, {} as never)) as Response;
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeEach(() => {
  joined.length = 0;
  wiring = {
    joinInviteTopic: async (s: string) => {
      joined.push(s);
    },
  };
});

describe('POST /api/discovery/join-invite (P-006)', () => {
  it('declares the loopback auth tier (auth-tier Wave 1)', () => {
    expect((joinInviteRoute as { auth?: unknown }).auth).toBe('loopback');
  });

  it('joins the invite topic from a full artifact and reports joined', async () => {
    const link = formatHiveInviteLink({
      pubkeyBase64: Buffer.alloc(32, 7).toString('base64'),
      secret: SECRET,
      title: 'Acme Shop',
    });
    const { status, body } = await post({ link });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, joined: true });
    expect(joined).toEqual([SECRET]); // the EXACT secret string — topic derivation is verbatim
  });

  it('accepts a secret-only link (pubkey/title optional)', async () => {
    const { status } = await post({ link: formatHiveInviteLink({ secret: SECRET }) });
    expect(status).toBe(200);
    expect(joined).toEqual([SECRET]);
  });

  it.each([
    ['missing link', {}],
    ['empty link', { link: '' }],
    ['not a hive link', { link: 'papercusp://harness?topic=' + 'a'.repeat(64) }],
    ['bare secret, not an artifact', { link: SECRET }],
    ['extra param', { link: `papercusp://hive?secret=${SECRET}&evil=1` }],
    ['short secret', { link: 'papercusp://hive?secret=abcd' }],
  ])('400s a malformed body (%s) without touching the wiring', async (_label, body) => {
    const { status, body: out } = await post(body);
    expect(status).toBe(400);
    expect(out).toMatchObject({ code: 'invalid_link' });
    expect(joined).toEqual([]);
  });

  it('503s with directory_unavailable when the directory cannot wire (gh-unauthed box)', async () => {
    wiring = null;
    const { status, body } = await post({ link: formatHiveInviteLink({ secret: SECRET }) });
    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, code: 'directory_unavailable' });
  });

  it('500s with join_failed when the topic join throws (never an unhandled throw)', async () => {
    wiring = {
      joinInviteTopic: async () => {
        throw new Error('swarm closed');
      },
    };
    const { status, body } = await post({ link: formatHiveInviteLink({ secret: SECRET }) });
    expect(status).toBe(500);
    expect(body).toMatchObject({ ok: false, code: 'join_failed', error: 'swarm closed' });
  });
});
