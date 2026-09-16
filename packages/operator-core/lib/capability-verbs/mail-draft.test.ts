import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { draftNewMail } from './mail';

const WORKSPACE = 'workspace';
const USER = '00000000-0000-4000-8000-000000000001';

/**
 * These fixtures exercise the shape that create-shaped outbound could not take
 * before: no stored document, so no account to inherit and no thread to join.
 */
function source(id: string, account: string, status = 'connected') {
  return {
    id,
    workspaceId: WORKSPACE,
    kind: 'gmail',
    ownerUserId: USER,
    providerAccountId: account,
    credentialRef: `credential:${account}`,
    status,
    config: {},
    cursor: {},
    lastError: null,
    lastConnectedAt: null,
    updatedAt: '2026-09-16T00:00:00.000Z',
  };
}

/**
 * `vaultRows` drives classifyAddressee. An address is `body-only` when it is
 * present in a document's TEXT and absent from every participants[] — the
 * injected-addressee signature the rail exists to refuse.
 */
function fakeSql(options: {
  sources: ReturnType<typeof source>[];
  vaultRows?: Array<{ asContact: boolean; asParticipant: boolean; inBody: boolean }>;
}) {
  const query = async (parts: TemplateStringsArray) => {
    const text = parts.join(' ');
    if (text.includes('FROM harness_shared.personal_documents')) {
      return options.vaultRows ?? [{ asContact: false, asParticipant: false, inBody: false }];
    }
    if (text.includes('FROM harness_shared.trigger_sources')) return options.sources;
    return [];
  };
  return query as unknown as postgres.Sql;
}

const DEPS = {
  resolveAccessToken: async () => 'access-token',
  createDraft: vi.fn(async () => ({
    draftId: 'draft-1',
    messageId: 'message-1',
    threadId: 'thread-1',
  })),
};

describe('draftNewMail', () => {
  it('creates a draft with no threadId and returns the draft id', async () => {
    const createDraft = vi.fn(async () => ({ draftId: 'draft-1', messageId: 'message-1', threadId: 'thread-1' }));
    const sql = fakeSql({ sources: [source('s1', 'only@example.com')] });

    const result = await draftNewMail(
      sql,
      {
        workspaceId: WORKSPACE,
        userId: USER,
        to: ['hiring@company.example'],
        subject: 'Senior Engineer',
        text: 'Hello.',
        provenance: { from: 'owner-instruction' },
      },
      { ...DEPS, createDraft },
    );

    expect(result.mode).toBe('draft');
    expect(result.draftId).toBe('draft-1');
    expect(result.recipients.map((r) => r.address)).toEqual(['hiring@company.example']);
    // Create-shaped: the encoder must be handed no thread, so Gmail mints one.
    const [, outbound] = createDraft.mock.calls[0] as unknown as [string, { threadId?: string | null }];
    expect(outbound.threadId ?? null).toBeNull();
  });

  it('refuses a body-only addressee exactly as the send path does', async () => {
    const createDraft = vi.fn(async () => ({ draftId: 'd', messageId: 'm', threadId: 't' }));
    const sql = fakeSql({
      sources: [source('s1', 'only@example.com')],
      vaultRows: [{ asContact: false, asParticipant: false, inBody: true }],
    });

    await expect(
      draftNewMail(
        sql,
        {
          workspaceId: WORKSPACE,
          userId: USER,
          to: ['injected@attacker.example'],
          subject: 'Subject',
          text: 'Body',
          provenance: { from: 'owner-instruction' },
        },
        { ...DEPS, createDraft },
      ),
    ).rejects.toMatchObject({ code: 'addressee_body_only' });
    // A refused addressee must never reach the transport, draft or not.
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('refuses ambiguously when several accounts are connected, and names them', async () => {
    const sql = fakeSql({
      sources: [source('s1', 'personal@example.com', 'connecting'), source('s2', 'work@example.com')],
    });

    await expect(
      draftNewMail(
        sql,
        {
          workspaceId: WORKSPACE,
          userId: USER,
          to: ['hiring@company.example'],
          subject: 'Subject',
          text: 'Body',
          provenance: { from: 'owner-instruction' },
        },
        DEPS,
      ),
    ).rejects.toThrow(/outbound_source_ambiguous:gmail.*personal@example\.com.*work@example\.com/);
  });

  it('selects the account named by `from`, including one still backfilling', async () => {
    const createDraft = vi.fn(async () => ({ draftId: 'draft-2', messageId: 'message-2', threadId: 'thread-2' }));
    let usedCredential: string | null = null;
    const sql = fakeSql({
      sources: [source('s1', 'personal@example.com', 'connecting'), source('s2', 'work@example.com')],
    });

    const result = await draftNewMail(
      sql,
      {
        workspaceId: WORKSPACE,
        userId: USER,
        to: ['hiring@company.example'],
        subject: 'Subject',
        text: 'Body',
        provenance: { from: 'owner-instruction' },
        from: 'Personal@Example.com',
      },
      {
        resolveAccessToken: async (src: { credentialRef: string }) => {
          usedCredential = src.credentialRef;
          return 'access-token';
        },
        createDraft,
      } as unknown as Parameters<typeof draftNewMail>[2],
    );

    expect(result.draftId).toBe('draft-2');
    // Matched case-insensitively, and `connecting` is a usable account: a
    // mailbox mid-backfill can still be drafted in.
    expect(usedCredential).toBe('credential:personal@example.com');
  });

  it('names the connected accounts when `from` matches none of them', async () => {
    const sql = fakeSql({ sources: [source('s1', 'work@example.com')] });

    await expect(
      draftNewMail(
        sql,
        {
          workspaceId: WORKSPACE,
          userId: USER,
          to: ['hiring@company.example'],
          subject: 'Subject',
          text: 'Body',
          provenance: { from: 'owner-instruction' },
          from: 'typo@example.com',
        },
        DEPS,
      ),
    ).rejects.toThrow(/outbound_source_account_not_connected:gmail:typo@example\.com.*work@example\.com/);
  });
});
