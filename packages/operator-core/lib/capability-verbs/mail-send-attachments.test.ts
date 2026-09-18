import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { sendNewMail } from './mail';
import { allowAllMailboxProbe } from './deliverability';

/**
 * WI-10001671: `sendNewMail` could not attach a file until this change, while
 * `draftNewMail` could — even though both encode through the same
 * `buildGoogleGmailRawMessage`, which has emitted `multipart/mixed` for either
 * one since it was written. The gap was one parameter, and it read to a caller
 * as a missing capability rather than a withheld one.
 *
 * The ordering assertion below is the point of this file. Attachments are read
 * BEFORE the addressee rail and before any token work, so an unreadable path
 * fails while the message is still un-sent. Read them later and the failure
 * mode inverts: recipients cleared, token acquired, and a send either goes out
 * without the file or fails with the transport half-committed.
 */

const WORKSPACE = 'workspace';
const USER = '00000000-0000-4000-8000-000000000001';
const PDF = Buffer.from('%PDF-1.7 fake resume bytes');

function source(id: string, account: string) {
  return {
    id,
    workspaceId: WORKSPACE,
    kind: 'gmail',
    ownerUserId: USER,
    providerAccountId: account,
    credentialRef: `credential:${account}`,
    status: 'connected',
    config: {},
    cursor: {},
    lastError: null,
    lastConnectedAt: null,
    updatedAt: '2026-09-16T00:00:00.000Z',
  };
}

/**
 * `vaultRows` drives classifyAddressee; the default row is a clean address
 * (not body-only), so these tests exercise attachment handling rather than
 * re-testing the addressee rail.
 */
function fakeSql() {
  const query = async (parts: TemplateStringsArray) => {
    const text = parts.join(' ');
    if (text.includes('FROM harness_shared.personal_documents')) {
      return [{ asContact: false, asParticipant: false, inBody: false }];
    }
    if (text.includes('FROM harness_shared.trigger_sources')) return [source('s1', 'only@example.com')];
    return [];
  };
  return query as unknown as postgres.Sql;
}

const BASE = {
  workspaceId: WORKSPACE,
  userId: USER,
  to: ['hiring@company.example'],
  subject: 'Senior Engineer',
  text: 'Hello.',
  provenance: { from: 'owner-instruction' as const },
};

function deps(overrides: Record<string, unknown> = {}) {
  return {
    resolveAccessToken: async () => 'access-token',
    sendMessage: vi.fn(async () => ({ messageId: 'message-1', threadId: 'thread-1' })),
    readAttachment: vi.fn(async () => PDF),
    // Attachments, not deliverability, are this file's subject — but the rail
    // runs on every send, so it needs a probe or it would do live DNS.
    probeMailbox: allowAllMailboxProbe,
    ...overrides,
  };
}

describe('sendNewMail attachments', () => {
  it('passes a declared attachment through to the transport with its basename and type', async () => {
    const d = deps();

    await sendNewMail(
      fakeSql(),
      { ...BASE, attachments: [{ path: '/fixtures/resume/Avraham_Weiss_SWE.pdf' }] },
      d as never,
    );

    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    const outbound = (d.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      attachments?: { filename: string; contentType: string; content: Buffer }[];
    };
    expect(outbound.attachments).toHaveLength(1);
    expect(outbound.attachments?.[0].filename).toBe('Avraham_Weiss_SWE.pdf');
    expect(outbound.attachments?.[0].contentType).toBe('application/pdf');
    expect(outbound.attachments?.[0].content).toEqual(PDF);
  });

  it('omits the attachments key entirely when none are declared', async () => {
    const d = deps();

    await sendNewMail(fakeSql(), { ...BASE }, d as never);

    const outbound = (d.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    // Not merely empty — ABSENT, so a body-only send encodes as text/plain
    // exactly as it did before this parameter existed.
    expect('attachments' in outbound).toBe(false);
  });

  it('sends NOTHING when a declared attachment cannot be read', async () => {
    const d = deps({
      readAttachment: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
    });

    await expect(
      sendNewMail(fakeSql(), { ...BASE, attachments: [{ path: '/gone/resume.pdf' }] }, d as never),
    ).rejects.toThrow('mail_attachment_unreadable:resume.pdf');

    // The whole point: the failure happens before anything leaves. A send that
    // went out without the file would be strictly worse than this throw.
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it('sends NOTHING when a declared attachment is empty', async () => {
    const d = deps({ readAttachment: vi.fn(async () => Buffer.alloc(0)) });

    await expect(
      sendNewMail(fakeSql(), { ...BASE, attachments: [{ path: '/tmp/empty.pdf' }] }, d as never),
    ).rejects.toThrow('mail_attachment_empty:empty.pdf');

    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it('reads attachments before resolving a token, so a bad path cannot half-commit a send', async () => {
    const order: string[] = [];
    const d = deps({
      readAttachment: vi.fn(async () => {
        order.push('read');
        throw new Error('ENOENT');
      }),
      resolveAccessToken: async () => {
        order.push('token');
        return 'access-token';
      },
    });

    await expect(
      sendNewMail(fakeSql(), { ...BASE, attachments: [{ path: '/gone/resume.pdf' }] }, d as never),
    ).rejects.toThrow(/mail_attachment_unreadable/);

    expect(order).toEqual(['read']);
  });
});
