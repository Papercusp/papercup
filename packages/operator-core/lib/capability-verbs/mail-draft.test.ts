import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { draftNewMail } from './mail';
import { allowAllMailboxProbe } from './deliverability';

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
    if (text.includes('FROM harness_shared.documents')) {
      return options.vaultRows ?? [{ asContact: false, asParticipant: false, inBody: false }];
    }
    if (text.includes('FROM harness_shared.data_sources')) return options.sources;
    return [];
  };
  return query as unknown as postgres.Sql;
}

const DEPS = {
  // Drafting, not deliverability, is this file's subject — but the rail runs on
  // every outbound verb, so it needs a probe or it would do live DNS.
  probeMailbox: allowAllMailboxProbe,
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
        probeMailbox: allowAllMailboxProbe,
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

/**
 * The defect these cover, measured 2026-09-16: 20 real Gmail drafts were created
 * whose composed records each DECLARED a resume PDF, while the encoder was
 * text/plain-only — so every one of them reached the owner's mailbox carrying no
 * attachment, and nothing in the mail client showed the omission. The contract is
 * therefore all-or-nothing: a declared file is carried, or the call fails loudly.
 */
describe('draftNewMail attachments', () => {
  const sqlFor = () => fakeSql({ sources: [source('s1', 'only@example.com')] });

  const base = {
    workspaceId: WORKSPACE,
    userId: USER,
    to: ['hiring@company.example'],
    subject: 'Senior Engineer',
    text: 'Hello.',
    provenance: { from: 'owner-instruction' as const },
  };

  it('carries a declared file as multipart, base64, with its basename as the filename', async () => {
    const createDraft = vi.fn(async () => ({ draftId: 'd', messageId: 'm', threadId: 't' }));
    const bytes = Buffer.from('%PDF-1.7 resume bytes');

    await draftNewMail(
      sqlFor(),
      { ...base, attachments: [{ path: '/tmp/downloads/Avraham_Weiss_SWE.pdf' }] },
      { ...DEPS, createDraft, readAttachment: async () => bytes },
    );

    const [, outbound] = createDraft.mock.calls[0] as unknown as [
      string,
      { attachments?: { filename: string; contentType: string; content: Buffer }[] },
    ];
    expect(outbound.attachments).toHaveLength(1);
    const [file] = outbound.attachments!;
    // The recipient sees the basename, never the owner's local directory layout.
    expect(file.filename).toBe('Avraham_Weiss_SWE.pdf');
    expect(file.filename).not.toContain('/');
    expect(file.contentType).toBe('application/pdf');
    expect(file.content.equals(bytes)).toBe(true);
  });

  it('omits the attachments key entirely when none are declared', async () => {
    const createDraft = vi.fn(async () => ({ draftId: 'd', messageId: 'm', threadId: 't' }));

    await draftNewMail(sqlFor(), base, { ...DEPS, createDraft });

    const [, outbound] = createDraft.mock.calls[0] as unknown as [string, Record<string, unknown>];
    // Absent rather than [] so the encoder's text/plain path stays byte-identical.
    expect('attachments' in outbound).toBe(false);
  });

  it('fails the whole draft when a declared file cannot be read, naming it', async () => {
    const createDraft = vi.fn(async () => ({ draftId: 'd', messageId: 'm', threadId: 't' }));

    await expect(
      draftNewMail(
        sqlFor(),
        { ...base, attachments: [{ path: '/tmp/gone.pdf' }] },
        {
          ...DEPS,
          createDraft,
          readAttachment: async () => {
            throw new Error('ENOENT');
          },
        },
      ),
    ).rejects.toThrow(/mail_attachment_unreadable:gone\.pdf/);

    // The point of all-or-nothing: no attachment-less draft is left behind.
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('refuses an empty file rather than attaching a zero-byte resume', async () => {
    const createDraft = vi.fn(async () => ({ draftId: 'd', messageId: 'm', threadId: 't' }));

    await expect(
      draftNewMail(
        sqlFor(),
        { ...base, attachments: [{ path: '/tmp/empty.pdf' }] },
        { ...DEPS, createDraft, readAttachment: async () => Buffer.alloc(0) },
      ),
    ).rejects.toThrow(/mail_attachment_empty:empty\.pdf/);
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('falls back to octet-stream for an unknown extension instead of guessing', async () => {
    const createDraft = vi.fn(async () => ({ draftId: 'd', messageId: 'm', threadId: 't' }));

    await draftNewMail(
      sqlFor(),
      { ...base, attachments: [{ path: '/tmp/portfolio.sketchfile' }] },
      { ...DEPS, createDraft, readAttachment: async () => Buffer.from('x') },
    );

    const [, outbound] = createDraft.mock.calls[0] as unknown as [
      string,
      { attachments: { contentType: string }[] },
    ];
    expect(outbound.attachments[0].contentType).toBe('application/octet-stream');
  });
});

/**
 * WI-10001658. Revising a draft had exactly one implementation before this —
 * delete it and create a replacement — which destroys the draft id and anything
 * the owner has typed into it since. These pin the PUT path, and pin that the
 * rails above apply to it unchanged rather than only to create.
 */
describe('draftNewMail revise', () => {
  const sqlFor = () => fakeSql({ sources: [source('s1', 'only@example.com')] });

  const base = {
    workspaceId: WORKSPACE,
    userId: USER,
    to: ['hiring@company.example'],
    subject: 'Senior Engineer',
    text: 'Hello.',
    provenance: { from: 'owner-instruction' as const },
  };

  const spies = () => ({
    createDraft: vi.fn(async () => ({ draftId: 'created', messageId: 'm', threadId: 't' })),
    updateDraft: vi.fn(async () => ({ draftId: 'draft-77', messageId: 'm2', threadId: 't2' })),
  });

  it('PUTs to the named draft and never creates a second one', async () => {
    const { createDraft, updateDraft } = spies();

    const result = await draftNewMail(
      sqlFor(),
      { ...base, draftId: 'draft-77' },
      { ...DEPS, createDraft, updateDraft },
    );

    expect(createDraft).not.toHaveBeenCalled();
    const [, draftId] = updateDraft.mock.calls[0] as unknown as [string, string, unknown, unknown];
    expect(draftId).toBe('draft-77');
    // The id SURVIVES the revise — that is the whole point over delete+recreate.
    expect(result.draftId).toBe('draft-77');
  });

  it('still creates when no draftId is given', async () => {
    // Control: without this, a branch inverted to always-update would pass every
    // other test in this block while silently breaking create for all callers.
    const { createDraft, updateDraft } = spies();

    await draftNewMail(sqlFor(), base, { ...DEPS, createDraft, updateDraft });

    expect(updateDraft).not.toHaveBeenCalled();
    expect(createDraft).toHaveBeenCalledTimes(1);
  });

  it('treats a blank draftId as create rather than PUTting an empty id', async () => {
    const { createDraft, updateDraft } = spies();

    await draftNewMail(sqlFor(), { ...base, draftId: '   ' }, { ...DEPS, createDraft, updateDraft });

    expect(updateDraft).not.toHaveBeenCalled();
    expect(createDraft).toHaveBeenCalledTimes(1);
  });

  it('carries attachments through the revise path', async () => {
    // The defect this closes: 20 job applications sat in the owner's mailbox
    // DECLARING a resume that the text/plain-only encoder had dropped. A revise
    // that silently lost the file again would reproduce it exactly.
    const { createDraft, updateDraft } = spies();
    const bytes = Buffer.from('%PDF-1.7 resume bytes');

    await draftNewMail(
      sqlFor(),
      { ...base, draftId: 'draft-77', attachments: [{ path: '/tmp/downloads/Avraham_Weiss_SWE.pdf' }] },
      { ...DEPS, createDraft, updateDraft, readAttachment: async () => bytes },
    );

    const [, , outbound] = updateDraft.mock.calls[0] as unknown as [
      string,
      string,
      { attachments?: { filename: string; content: Buffer }[] },
    ];
    expect(outbound.attachments).toHaveLength(1);
    expect(outbound.attachments![0].filename).toBe('Avraham_Weiss_SWE.pdf');
    expect(outbound.attachments![0].content.equals(bytes)).toBe(true);
  });

  it('refuses a body-only addressee on the revise path too', async () => {
    const { createDraft, updateDraft } = spies();
    const sql = fakeSql({
      sources: [source('s1', 'only@example.com')],
      vaultRows: [{ asContact: false, asParticipant: false, inBody: true }],
    });

    await expect(
      draftNewMail(
        sql,
        { ...base, to: ['injected@attacker.example'], draftId: 'draft-77' },
        { ...DEPS, createDraft, updateDraft },
      ),
    ).rejects.toMatchObject({ code: 'addressee_body_only' });
    // Revising an EXISTING draft is still outbound: the rail is not create-only.
    expect(updateDraft).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  });
});
