import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), canonical: vi.fn(), target: vi.fn(), invoke: vi.fn(), disclose: vi.fn(), search: vi.fn() }));
vi.mock('../../auth', () => ({ getSessionUserOrDefault: async () => ({ id: 'owner' }) }));
vi.mock('../../personal-vault/authorization', () => ({ authorizePersonalAccess: mocks.auth }));
vi.mock('../../personal-vault/disclosure-ledger', () => ({ discloseDocuments: mocks.disclose }));
vi.mock('../../personal-vault/store', () => ({ searchPersonalDocuments: mocks.search }));
vi.mock('../../personal-vault/embedding', () => ({ PERSONAL_EMBEDDER_MODE: 'gemma', buildPersonalQueryEmbedder: async () => async () => null }));
vi.mock('../../capability-verbs/resolve', () => ({ resolveCanonicalDocument: mocks.canonical }));
vi.mock('../../capability-verbs/provider-dispatch', () => ({ resolveCapabilitySource: mocks.target, invokeOutboundProvider: mocks.invoke }));
import tool from './search';

const sourceId = '11111111-1111-4111-8111-111111111111';
const messageId = 'original-message';
const context = { workspaceId: 'workspace', tx: {}, role: 'operator', uiClientId: 'agent' };
const args = { query: 'Inspect original debt schedule email', read: { sourceId, messageId } };
const doc = { id: '22222222-2222-4222-8222-222222222222', source: 'mail', sourceId,
  externalId: messageId, participants: ['sender@example.test'], payload: { from: 'sender@example.test' } };
const message = { id: messageId, from: 'sender@example.test', text: 'Full original body', attachments: [
  { attachmentId: 'excel', filename: 'Debt Schedule.xlsx', size: 4 },
] };
const call = (input = args) => tool.handler!(input as never, context as never) as Promise<{ data: Record<string, any> }>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ allowed: true, scopes: ['personal:mail'], principal: { type: 'agent-role', id: 'operator' } });
  mocks.canonical.mockResolvedValue(doc);
  mocks.target.mockResolvedValue({ source: { id: sourceId } });
  mocks.invoke.mockImplementation(async (_sql, _target, capability) => capability === 'mail.read'
    ? { message } : { messageId, attachmentId: 'excel', size: 4, contentBase64: 'UEsDBA==' });
  mocks.disclose.mockImplementation(async (_sql, p) => ({ documents: p.documents.map((d: object) => ({ ...d, privacy: null })), disclosed: 0, withheld: 0 }));
});

describe('personal:search original mail reads', () => {
  it('requires personal:mail even when the caller supplies other search scopes', async () => {
    mocks.auth.mockResolvedValue({ allowed: false, reason: 'no_live_grant', scopes: [] });
    const result = await call({ ...args, scopes: ['personal:calendar'] } as typeof args);
    expect(mocks.auth.mock.calls[0]![4]).toEqual(['personal:mail']);
    expect(result.data.allowed).toBe(false);
    expect(mocks.canonical).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('pins both canonical ownership and provider dispatch to the requested source', async () => {
    const result = await call();
    expect(mocks.canonical.mock.calls[0]![1]).toEqual({ workspaceId: 'workspace', userId: 'owner', source: 'mail', sourceId, externalId: messageId });
    expect(mocks.target.mock.calls[0]![1]).toMatchObject({ sourceId, userId: 'owner', capabilities: ['mail.read'] });
    expect(result.data.results[0].metadata).toEqual(message);
    expect(result.data.live).toBe(true);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('cannot fetch a message absent from the owner/source-scoped canonical store', async () => {
    mocks.canonical.mockRejectedValue(new Error('canonical_document_not_found'));
    await expect(call()).rejects.toThrow('canonical_document_not_found');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('refuses a canonical source mismatch before provider access', async () => {
    mocks.canonical.mockResolvedValue({ ...doc, sourceId: 'other-account' });
    await expect(call()).rejects.toThrow('personal_mail_source_mismatch');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('refuses a provider returning another message', async () => {
    mocks.invoke.mockResolvedValue({ message: { ...message, id: 'other-message' } });
    await expect(call()).rejects.toThrow('personal_mail_message_mismatch');
  });

  it('records disclosure from the full original before returning attachment bytes', async () => {
    const privacy = { level: 'sender-only', readerSet: ['sender@example.test'] };
    mocks.disclose.mockImplementation(async (_sql, p) => ({ documents: [{ ...p.documents[0], privacy }], disclosed: 1, withheld: 0 }));
    const result = await call({ ...args, read: { ...args.read, attachmentId: 'excel' } } as typeof args);
    expect(mocks.target.mock.calls[0]![1].capabilities).toEqual(['mail.read', 'mail.attachments']);
    expect(mocks.disclose.mock.calls[0]![1].documents[0]).toMatchObject({ id: doc.id, metadata: message });
    expect(mocks.disclose.mock.invocationCallOrder[0]).toBeLessThan(mocks.invoke.mock.invocationCallOrder[1]!);
    expect(result.data.results[0].privacy).toEqual(privacy);
    expect(result.data.attachment.contentBase64).toBe('UEsDBA==');
    expect(result.data.restrictedResults).toBe(1);
  });

  it('withholds the original and does not fetch binary content without disclosure identity', async () => {
    mocks.disclose.mockResolvedValue({ documents: [], disclosed: 0, withheld: 1 });
    const result = await call({ ...args, read: { ...args.read, attachmentId: 'excel' } } as typeof args);
    expect(result.data.results).toEqual([]);
    expect(result.data).not.toHaveProperty('attachment');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('downloads a previous reference when a fresh message read rotates the attachment token', async () => {
    mocks.invoke.mockImplementation(async (_sql, _target, capability, request) => capability === 'mail.read'
      ? { message: { ...message, attachments: [{ attachmentId: 'fresh-token', filename: 'Debt Schedule.xlsx' }] } }
      : { messageId, attachmentId: request.attachmentId, size: 4, contentBase64: 'UEsDBA==' });
    const result = await call({ ...args, read: { ...args.read, attachmentId: 'previous-token' } } as typeof args);
    expect(mocks.invoke.mock.calls[1]![3]).toEqual({ messageId, attachmentId: 'previous-token' });
    expect(result.data.attachment.contentBase64).toBe('UEsDBA==');
    expect(result.data.results[0].metadata.attachments[0].attachmentId).toBe('fresh-token');
  });

  it('propagates provider rejection of an invalid message-scoped attachment resource', async () => {
    mocks.invoke.mockImplementation(async (_sql, _target, capability) => {
      if (capability === 'mail.read') return { message };
      throw new Error('provider_attachment_resource_not_found');
    });
    await expect(call({ ...args, read: { ...args.read, attachmentId: 'unrelated' } } as typeof args))
      .rejects.toThrow('provider_attachment_resource_not_found');
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it.each([49, 50, 51])('preserves every attachment in an original with %i parts', async count => {
    const attachments = Array.from({ length: count }, (_, i) => ({ attachmentId: `part-${i}`, filename: `${i}.xlsx` }));
    mocks.invoke.mockResolvedValue({ message: { ...message, attachments } });
    const result = await call({ ...args, limit: 1 } as typeof args);
    expect(result.data.results[0].metadata.attachments).toEqual(attachments);
  });
});
