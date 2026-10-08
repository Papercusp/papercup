import { describe, expect, it } from 'vitest';
import { dispatchProjectedTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import './read';

function context(overrides: Partial<UnifiedToolContext> = {}): UnifiedToolContext {
  return {
    log: () => {}, progress: () => {}, emit: () => {},
    signal: new AbortController().signal, role: 'operator', runId: 'content-read-fixture',
    workspaceId: 'content-read-private-fixture', uiClientId: 'su-content-read-fixture', isSuperuser: true,
    principal: { slug: 'content-reader', workspaceId: 'content-read-private-fixture', capabilities: new Set(['search:read']) },
    transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
    ...overrides,
  };
}
const projected = lookupByMcpName('documents:read');
if (!projected) throw new Error('documents:read must be registered');
const dispatch = (args: unknown, ctx = context()) => dispatchProjectedTool(projected, 'documents:read', args, ctx, {});

describe('documents:read projection and intake integration', () => {
  it('runs the real registry, input schema, identity and HTML reader together', async () => {
    const response = await dispatch({ content: { kind: 'html', html: '<title>Source title</title><p>FIRST</p><p>TAIL</p>', ref: 'already-read:article' } });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: true, text: 'FIRST\n\nTAIL', title: 'Source title', sourceRefs: ['already-read:article'], access: { workspaceId: 'content-read-private-fixture', readerId: 'su-content-read-fixture' }, coverage: { complete: true } });
  });
  it('validates source references as provenance without creating a source-fetch route', async () => {
    const response = await dispatch({ content: { kind: 'reference', ref: 'private:unread' } });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('invalid_input');
  });
  it('keeps role and capability denial ahead of the reader', async () => {
    const args = { content: { kind: 'text', text: 'private content' } };
    const roleDenied = await dispatch(args, context({ role: 'unapproved-role' }));
    expect(roleDenied.ok).toBe(false);
    expect(roleDenied.error?.code).toBe('role_not_allowed');
    const capabilityDenied = await dispatch(args, context({ principal: { slug: 'content-reader', workspaceId: 'content-read-private-fixture', capabilities: new Set() } }));
    expect(capabilityDenied.ok).toBe(false);
    expect(capabilityDenied.error?.code).toBe('missing_capability');
  });
  it('serializes incomplete coverage through the real result projection', async () => {
    const response = await dispatch({ content: { kind: 'selection', text: 'first\nlast', partial: true }, maxChars: 6 });
    expect(response.ok).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: true, text: 'first\n', coverage: { complete: false, warnings: ['source-partial', 'character-limit'] } });
  });
  it('accepts a bounded provided-source collection through the real tool schema', async () => {
    const response = await dispatch({ content: { kind: 'collection', sources: [
      { kind: 'text', text: 'FIRST', ref: 'provided:one' },
      { kind: 'html', html: '<p>FINAL</p>', ref: 'provided:two', partial: true },
    ] } });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ ok: true, text: 'FIRST\n\nFINAL', sourceRefs: ['provided:one', 'provided:two'], coverage: { complete: false, warnings: ['source-partial'] } });
    const denied = await dispatch({ content: { kind: 'collection', sources: [{ kind: 'reference', ref: 'private:unread' }] } });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('invalid_input');
  });
});
