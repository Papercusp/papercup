import { beforeEach, describe, expect, it, vi } from 'vitest';
const identity = vi.hoisted(() => ({ subject: vi.fn(() => 'reader-one') }));
vi.mock('../_disclosure-subject', () => ({ disclosureSubject: identity.subject }));
import tool from './read';
const ctx = { workspaceId: 'workspace-one' } as never;

beforeEach(() => identity.subject.mockReturnValue('reader-one'));
describe('documents:read entry path', () => {
  it('returns original text and provenance through the registered tool handler', async () => {
    expect(tool.name).toBe('documents:read');
    const content = { kind: 'text' as const, text: 'Original\n' + 'x'.repeat(4500) + '\nTAIL', ref: 'source:one' };
    const result = await tool.handler({ content, maxChars: 6000 }, ctx);
    expect(result).toMatchObject({ data: { ok: true, text: content.text, sourceRefs: ['source:one'], access: { readerId: 'reader-one', workspaceId: 'workspace-one' }, coverage: { complete: true } } });
  });
  it('flags the default response boundary and upstream partial input', async () => {
    const result = await tool.handler({ content: { kind: 'text', text: 'x'.repeat(5000), partial: true } }, ctx);
    expect(result).toMatchObject({ data: { ok: true, text: 'x'.repeat(4000), coverage: { complete: false, warnings: ['source-partial', 'character-limit'] } } });
  });
  it('extracts selected HTML without following its links or source ref', async () => {
    const result = await tool.handler({ content: { kind: 'html', html: '<p>one</p><p>two</p>', ref: 'https://private.example.test' } }, ctx);
    expect(result).toMatchObject({ data: { ok: true, text: 'one\n\ntwo', sourceRefs: ['https://private.example.test'], coverage: { complete: true } } });
  });
  it('refuses an unresolved identity or workspace before content processing', async () => {
    identity.subject.mockReturnValue('');
    expect(await tool.handler({ content: { kind: 'text', text: 'secret' } }, ctx)).toMatchObject({ data: { ok: false, error: 'unauthorized' } });
    identity.subject.mockReturnValue('reader-one');
    expect(await tool.handler({ content: { kind: 'text', text: 'secret' } }, { workspaceId: '*' } as never)).toMatchObject({ data: { ok: false, error: 'unauthorized' } });
  });
  it('rejects reference-only requests and malformed PDF encoding at the schema boundary', () => {
    expect(tool.args.safeParse({ content: { kind: 'reference', ref: 'private:other' } }).success).toBe(false);
    expect(tool.args.safeParse({ content: { kind: 'pdf', base64: 'not base64!!' } }).success).toBe(false);
  });
  it('exposes unreadable input and request cancellation as honest failures', async () => {
    expect(await tool.handler({ content: { kind: 'html', html: '<script>no text</script>' } }, ctx)).toMatchObject({ data: { ok: false, error: 'unreadable' } });
    const controller = new AbortController(); controller.abort();
    expect(await tool.handler({ content: { kind: 'text', text: 'source' } }, { workspaceId: 'workspace-one', signal: controller.signal } as never)).toMatchObject({ data: { ok: false, error: 'cancelled' } });
  });
});
