import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { replyToCanonicalMail } from './mail';

const WORKSPACE = 'workspace';
const USER = '00000000-0000-4000-8000-000000000001';
const FIRST = '00000000-0000-4000-8000-000000000101';
const SECOND = '00000000-0000-4000-8000-000000000102';

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
    updatedAt: '2026-08-31T00:00:00.000Z',
  };
}

function document(sourceId: string, account: string, sender: string) {
  return {
    id: sourceId,
    source: 'gmail',
    sourceId,
    providerAccountId: account,
    kind: 'message',
    externalId: 'shared-message',
    occurredAt: '2026-08-31T00:00:00.000Z',
    participants: [sender, account],
    title: 'Shared provider id',
    text: 'Body',
    metadata: {
      direction: 'inbound',
      from: sender,
      subject: 'Shared provider id',
      threadId: 'shared-thread',
      messageId: 'shared-message',
    },
  };
}

function fakeSql(options: { singleAccount?: boolean } = {}) {
  const allDocuments = [
    document(FIRST, 'first@example.com', 'First sender <first-sender@example.com>'),
    document(SECOND, 'second@example.com', 'Second sender <second-sender@example.com>'),
  ];
  const allSources = [source(FIRST, 'first@example.com'), source(SECOND, 'second@example.com')];
  const documents = options.singleAccount ? allDocuments.slice(0, 1) : allDocuments;
  const sources = options.singleAccount ? allSources.slice(0, 1) : allSources;
  const query = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join(' ');
    if (text.includes('FROM harness_shared.personal_documents')) {
      const requestedSourceId = typeof values[4] === 'string' ? values[4] : null;
      return requestedSourceId
        ? documents.filter((row) => row.sourceId === requestedSourceId)
        : documents;
    }
    if (text.includes('FROM harness_shared.data_sources')) return sources;
    throw new Error(`unexpected_query:${text}`);
  };
  return query as unknown as postgres.Sql;
}

describe('mail reply account routing', () => {
  it('uses the credential owned by the selected canonical source', async () => {
    const tokenSources: string[] = [];
    const draftTokens: string[] = [];
    const result = await replyToCanonicalMail(fakeSql(), {
      workspaceId: WORKSPACE,
      userId: USER,
      agentOwnerId: null,
      messageId: 'shared-message',
      sourceId: SECOND,
      text: 'Account-safe draft',
      mode: 'draft',
    }, {
      resolveAccessToken: async (selected) => {
        tokenSources.push(selected.id);
        return `token:${selected.id}`;
      },
      createDraft: async (token, input) => {
        draftTokens.push(token);
        // The draft seam now also accepts create-shaped input, where threadId is
        // absent. This is the REPLY path, so a missing thread is a real defect —
        // assert it rather than coercing, which would quietly stop testing the
        // threading contract this fixture exists for.
        if (!input.threadId) throw new Error('fixture_expected_reply_thread_id');
        return { draftId: 'draft-2', messageId: 'out-2', threadId: input.threadId };
      },
    });

    expect(tokenSources).toEqual([SECOND]);
    expect(draftTokens).toEqual([`token:${SECOND}`]);
    expect(result).toMatchObject({ to: 'Second sender <second-sender@example.com>', draftId: 'draft-2' });
  });

  it('fails closed when a legacy provider-only id matches more than one account', async () => {
    await expect(replyToCanonicalMail(fakeSql(), {
      workspaceId: WORKSPACE,
      userId: USER,
      agentOwnerId: null,
      messageId: 'shared-message',
      text: 'Must not guess',
      mode: 'draft',
    })).rejects.toThrow('canonical_document_ambiguous:gmail:shared-message');
  });

  it('keeps provider-only legacy calls compatible when exactly one account owns the message', async () => {
    const selectedSources: string[] = [];
    const result = await replyToCanonicalMail(fakeSql({ singleAccount: true }), {
      workspaceId: WORKSPACE,
      userId: USER,
      agentOwnerId: null,
      messageId: 'shared-message',
      text: 'Legacy single-account draft',
      mode: 'draft',
    }, {
      resolveAccessToken: async (selected) => {
        selectedSources.push(selected.id);
        return `token:${selected.id}`;
      },
      createDraft: async (_token, input) => {
        // Same reply-path assertion as above: create-shaped input is legal at
        // the seam now, but never on this path.
        if (!input.threadId) throw new Error('fixture_expected_reply_thread_id');
        return { draftId: 'draft-legacy', messageId: 'out-legacy', threadId: input.threadId };
      },
    });

    expect(selectedSources).toEqual([FIRST]);
    expect(result).toMatchObject({
      to: 'First sender <first-sender@example.com>',
      draftId: 'draft-legacy',
    });
  });
});
