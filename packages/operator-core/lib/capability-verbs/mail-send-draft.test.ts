import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { sendMailDraft } from './mail';

const WORKSPACE = 'workspace';
const USER = '00000000-0000-4000-8000-000000000001';

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
 * `vaultRows` drives classifyAddressee: an address present in a document's TEXT
 * and absent from every participants[] is `body-only` — the injected-addressee
 * signature the D-020 rail refuses.
 */
function fakeSql(options: {
  vaultRows?: Array<{ asContact: boolean; asParticipant: boolean; inBody: boolean }>;
}) {
  const query = async (parts: TemplateStringsArray) => {
    const text = parts.join(' ');
    if (text.includes('FROM harness_shared.personal_documents')) {
      return options.vaultRows ?? [{ asContact: false, asParticipant: false, inBody: false }];
    }
    if (text.includes('FROM harness_shared.trigger_sources')) return [source('s1', 'avi@example.com')];
    return [];
  };
  return query as unknown as postgres.Sql;
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    resolveAccessToken: async () => 'access-token',
    readDraftRecipients: vi.fn(async () => ({
      to: ['hiring@company.example'],
      cc: [] as string[],
      subject: 'Senior Engineer',
    })),
    sendDraft: vi.fn(async () => ({ messageId: 'message-1', threadId: 'thread-1' })),
    ...overrides,
  };
}

const BASE = {
  workspaceId: WORKSPACE,
  userId: USER,
  draftId: 'draft-1',
  provenance: 'owner-directed' as const,
};

describe('sendMailDraft', () => {
  it('sends the draft by id when the live recipients match what the caller declared', async () => {
    const d = deps();

    const result = await sendMailDraft(
      fakeSql({}),
      { ...BASE, expectedTo: ['hiring@company.example'] },
      d as never,
    );

    expect(d.sendDraft).toHaveBeenCalledWith('access-token', 'draft-1', expect.anything());
    expect(result.mode).toBe('send');
    expect(result.messageId).toBe('message-1');
    expect(result.draftId).toBe('draft-1');
    // Echoes what SHIPPED, read from Gmail — not what the caller hoped.
    expect(result.sentTo).toEqual(['hiring@company.example']);
    expect(result.subject).toBe('Senior Engineer');
  });

  it('REFUSES — and does not send — when the draft was re-addressed under the caller', async () => {
    // The property this verb exists for. `drafts/send` ships what Gmail holds,
    // so a draft edited between review and send would otherwise go to an
    // address nobody approved, irreversibly.
    const d = deps({
      readDraftRecipients: vi.fn(async () => ({
        to: ['someone-else@elsewhere.example'],
        cc: [] as string[],
        subject: 'Senior Engineer',
      })),
    });

    await expect(
      sendMailDraft(fakeSql({}), { ...BASE, expectedTo: ['hiring@company.example'] }, d as never),
    ).rejects.toThrow(/mail_send_draft_recipients_changed/);

    expect(d.sendDraft).not.toHaveBeenCalled();
  });

  it('names BOTH sides in the mismatch so the caller can adjudicate it', async () => {
    // "They differ" is not actionable; deciding whether the draft was
    // legitimately edited or tampered with requires seeing both sets.
    const d = deps({
      readDraftRecipients: vi.fn(async () => ({
        to: ['someone-else@elsewhere.example'],
        cc: [] as string[],
        subject: null,
      })),
    });

    await expect(
      sendMailDraft(fakeSql({}), { ...BASE, expectedTo: ['hiring@company.example'] }, d as never),
    ).rejects.toThrow(/expected=hiring@company\.example.*actual=someone-else@elsewhere\.example/);
  });

  it('re-runs the D-020 rail against the LIVE recipients, not the declared ones', async () => {
    // The clearance done at DRAFT time judged bytes that may no longer exist.
    // Here the live address carries the injected signature; the caller declared
    // that same address, so the MATCH passes and only the rail can catch it.
    const d = deps({
      readDraftRecipients: vi.fn(async () => ({
        to: ['injected@attacker.example'],
        cc: [] as string[],
        subject: null,
      })),
    });

    await expect(
      sendMailDraft(
        fakeSql({ vaultRows: [{ asContact: false, asParticipant: false, inBody: true }] }),
        { ...BASE, expectedTo: ['injected@attacker.example'] },
        d as never,
      ),
    ).rejects.toThrow();

    expect(d.sendDraft).not.toHaveBeenCalled();
  });

  it('reports the RAIL failure, not the mismatch, when a draft is re-addressed to a hostile recipient', async () => {
    // Both checks fail here. The security-relevant one is the informative one.
    const d = deps({
      readDraftRecipients: vi.fn(async () => ({
        to: ['injected@attacker.example'],
        cc: [] as string[],
        subject: null,
      })),
    });

    await expect(
      sendMailDraft(
        fakeSql({ vaultRows: [{ asContact: false, asParticipant: false, inBody: true }] }),
        { ...BASE, expectedTo: ['hiring@company.example'] },
        d as never,
      ),
    ).rejects.toThrow(/^(?!.*mail_send_draft_recipients_changed).*$/s);

    expect(d.sendDraft).not.toHaveBeenCalled();
  });

  it('refuses a draft addressed to nobody rather than letting the provider decide', async () => {
    const d = deps({
      readDraftRecipients: vi.fn(async () => ({ to: [] as string[], cc: [] as string[], subject: null })),
    });

    await expect(
      sendMailDraft(fakeSql({}), { ...BASE, expectedTo: ['hiring@company.example'] }, d as never),
    ).rejects.toThrow('mail_send_draft_no_recipients');

    expect(d.sendDraft).not.toHaveBeenCalled();
  });

  it('matches recipients order- and case-insensitively', async () => {
    const d = deps({
      readDraftRecipients: vi.fn(async () => ({
        to: ['b@example.com', 'a@example.com'],
        cc: [] as string[],
        subject: null,
      })),
    });

    await sendMailDraft(
      fakeSql({}),
      { ...BASE, expectedTo: ['A@Example.com', ' b@example.com '] },
      d as never,
    );

    expect(d.sendDraft).toHaveBeenCalled();
  });

  it('REFUSES when the cc list changed even though the To list matches', async () => {
    // A silently-added cc is an unapproved recipient exactly like a changed to.
    const d = deps({
      readDraftRecipients: vi.fn(async () => ({
        to: ['hiring@company.example'],
        cc: ['watcher@elsewhere.example'],
        subject: null,
      })),
    });

    await expect(
      sendMailDraft(fakeSql({}), { ...BASE, expectedTo: ['hiring@company.example'] }, d as never),
    ).rejects.toThrow(/mail_send_draft_recipients_changed/);

    expect(d.sendDraft).not.toHaveBeenCalled();
  });

  it('REFUSES when the draft dropped a recipient the caller expected', async () => {
    const d = deps({
      readDraftRecipients: vi.fn(async () => ({
        to: ['hiring@company.example'],
        cc: [] as string[],
        subject: null,
      })),
    });

    await expect(
      sendMailDraft(
        fakeSql({}),
        { ...BASE, expectedTo: ['hiring@company.example', 'second@company.example'] },
        d as never,
      ),
    ).rejects.toThrow(/mail_send_draft_recipients_changed/);

    expect(d.sendDraft).not.toHaveBeenCalled();
  });

  it('requires a draft id and a declared addressee', async () => {
    const d = deps();

    await expect(
      sendMailDraft(fakeSql({}), { ...BASE, draftId: '  ', expectedTo: ['a@b.example'] }, d as never),
    ).rejects.toThrow('mail_send_draft_id_required');

    await expect(
      sendMailDraft(fakeSql({}), { ...BASE, expectedTo: [] }, d as never),
    ).rejects.toThrow('mail_send_draft_expected_to_required');

    // Neither the read nor the send may be attempted on a malformed request.
    expect(d.readDraftRecipients).not.toHaveBeenCalled();
    expect(d.sendDraft).not.toHaveBeenCalled();
  });

  it('never re-encodes: no message body is composed anywhere on this path', async () => {
    // The whole point of sending BY DRAFT ID is that the reviewed bytes ship.
    // If this verb ever grew a subject/text parameter it would be composing a
    // new message, and the artifact the human approved would no longer be the
    // artifact sent.
    const d = deps();

    await sendMailDraft(fakeSql({}), { ...BASE, expectedTo: ['hiring@company.example'] }, d as never);

    expect(d.sendDraft).toHaveBeenCalledWith('access-token', 'draft-1', expect.anything());
    const args = vi.mocked(d.sendDraft).mock.calls[0];
    expect(args).toHaveLength(3);
    expect(JSON.stringify(args[2])).not.toContain('raw');
  });
});
