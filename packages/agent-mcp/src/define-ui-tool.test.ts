/**
 * Unit tests for defineUITool — the convenience wrapper that turns a
 * `{ data, html?|externalUrl? }` handler result into a ToolResponse whose
 * `uiResources[]` carries a spec-shaped `ui://` UIResource.
 *
 * `@mcp-ui/server`'s createUIResource is mocked so the test stays pure and
 * we can assert exactly which options the wrapper passes it. The wrapped
 * `defineTool` self-registers, so we reset the catalog between cases and
 * call the returned tool's `.handler` directly (the wrapper passes `ctx`
 * straight through to the inner handler — it never reads it).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock createUIResource — return a sentinel tagged with the call options so
// the assertions can read back the exact uri/content/encoding/metadata the
// wrapper chose, without depending on @mcp-ui/server's real encoding.
const createUIResource = vi.fn((opts: Record<string, unknown>) => ({
  type: 'resource' as const,
  resource: { uri: opts.uri, mimeType: 'text/html', text: '<mock>' },
  _meta: { __opts: opts },
}));

vi.mock('@mcp-ui/server', () => ({
  createUIResource: (opts: Record<string, unknown>) => createUIResource(opts),
}));

import { defineUITool } from './define-ui-tool';
import { _resetCatalogForTests, type ToolResponse } from '@papercusp/tooldef';

/** Minimal ctx — the defineUITool wrapper never reads it. */
const CTX = {} as Parameters<
  Parameters<typeof defineUITool>[0]['handler']
>[1];

beforeEach(() => {
  _resetCatalogForTests();
  createUIResource.mockClear();
});

describe('defineUITool — html branch', () => {
  it('builds a rawHtml UIResource and attaches it to uiResources', async () => {
    const tool = defineUITool({
      name: 'dispatch:card',
      capability: 'tasks:read',
      args: (await import('zod')).z.object({}),
      async handler() {
        return {
          data: { ok: true },
          html: '<div>hi</div>',
          uri: 'ui://dispatch-card/fixed',
        };
      },
    });
    const res = (await tool.handler({}, CTX)) as ToolResponse;

    expect(createUIResource).toHaveBeenCalledTimes(1);
    const opts = createUIResource.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.uri).toBe('ui://dispatch-card/fixed');
    expect(opts.content).toEqual({ type: 'rawHtml', htmlString: '<div>hi</div>' });
    expect(opts.encoding).toBe('text');

    expect(res.data).toEqual({ ok: true });
    expect(res.uiResources).toHaveLength(1);
    expect(res.uiResources![0]!.resource.uri).toBe('ui://dispatch-card/fixed');
  });
});

describe('defineUITool — externalUrl branch', () => {
  it('builds an externalUrl UIResource (not rawHtml)', async () => {
    const tool = defineUITool({
      name: 'embed:frame',
      capability: 'tasks:read',
      args: (await import('zod')).z.object({}),
      async handler() {
        return {
          data: { ok: 1 },
          externalUrl: 'https://example.com/widget',
          uri: 'ui://embed-frame/fixed',
        };
      },
    });
    await tool.handler({}, CTX);

    const opts = createUIResource.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.content).toEqual({
      type: 'externalUrl',
      iframeUrl: 'https://example.com/widget',
    });
  });

  it('prefers html over externalUrl when both are present', async () => {
    const tool = defineUITool({
      name: 'embed:both',
      capability: 'tasks:read',
      args: (await import('zod')).z.object({}),
      async handler() {
        return {
          data: {},
          html: '<b>win</b>',
          externalUrl: 'https://example.com/loser',
          uri: 'ui://embed-both/fixed',
        };
      },
    });
    await tool.handler({}, CTX);
    const opts = createUIResource.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.content).toEqual({ type: 'rawHtml', htmlString: '<b>win</b>' });
  });
});

describe('defineUITool — default uri synthesis', () => {
  it('synthesizes ui://<name>/<rand> when uri is omitted', async () => {
    const tool = defineUITool({
      name: 'auto:uri',
      capability: 'tasks:read',
      args: (await import('zod')).z.object({}),
      async handler() {
        return { data: {}, html: '<i>x</i>' };
      },
    });
    const res = (await tool.handler({}, CTX)) as ToolResponse;
    const uri = (createUIResource.mock.calls[0]![0] as Record<string, unknown>)
      .uri as string;
    expect(uri).toMatch(/^ui:\/\/auto:uri\/[a-z0-9]+$/);
    expect(res.uiResources![0]!.resource.uri).toBe(uri);
  });

  it('produces distinct random suffixes across calls', async () => {
    const make = async (name: string) =>
      defineUITool({
        name,
        capability: 'tasks:read',
        args: (await import('zod')).z.object({}),
        async handler() {
          return { data: {}, html: '<i>x</i>' };
        },
      });
    const a = await make('rand:a');
    const b = await make('rand:b');
    await a.handler({}, CTX);
    await b.handler({}, CTX);
    const uriA = (createUIResource.mock.calls[0]![0] as Record<string, unknown>).uri;
    const uriB = (createUIResource.mock.calls[1]![0] as Record<string, unknown>).uri;
    expect(uriA).not.toBe(uriB);
  });
});

describe('defineUITool — no-UI path', () => {
  it('omits uiResources entirely when the handler returns only data', async () => {
    const tool = defineUITool({
      name: 'data:only',
      capability: 'tasks:read',
      args: (await import('zod')).z.object({}),
      async handler() {
        return { data: { rows: [1, 2, 3] } };
      },
    });
    const res = (await tool.handler({}, CTX)) as ToolResponse;
    expect(createUIResource).not.toHaveBeenCalled();
    expect(res.data).toEqual({ rows: [1, 2, 3] });
    expect(res.uiResources).toBeUndefined();
  });
});

describe('defineUITool — nextCursor passthrough', () => {
  it('forwards nextCursor onto the ToolResponse', async () => {
    const tool = defineUITool({
      name: 'cursor:through',
      capability: 'tasks:read',
      args: (await import('zod')).z.object({}),
      async handler() {
        return { data: { page: 1 }, nextCursor: 'cur_abc' };
      },
    });
    const res = (await tool.handler({}, CTX)) as ToolResponse;
    expect(res.nextCursor).toBe('cur_abc');
    // No UI fields → no uiResources.
    expect(res.uiResources).toBeUndefined();
  });

  it('omits nextCursor when the handler does not return one', async () => {
    const tool = defineUITool({
      name: 'cursor:absent',
      capability: 'tasks:read',
      args: (await import('zod')).z.object({}),
      async handler() {
        return { data: {}, html: '<p>x</p>', uri: 'ui://cursor-absent/fixed' };
      },
    });
    const res = (await tool.handler({}, CTX)) as ToolResponse;
    expect(res.nextCursor).toBeUndefined();
    expect(res.uiResources).toHaveLength(1);
  });
});

describe('defineUITool — metadata passthrough', () => {
  it('passes handler metadata into createUIResource', async () => {
    const tool = defineUITool({
      name: 'meta:through',
      capability: 'tasks:read',
      args: (await import('zod')).z.object({}),
      async handler() {
        return {
          data: {},
          html: '<p>x</p>',
          uri: 'ui://meta-through/fixed',
          metadata: { 'preferred-frame-size': ['400px', '300px'] },
        };
      },
    });
    await tool.handler({}, CTX);
    const opts = createUIResource.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.metadata).toEqual({ 'preferred-frame-size': ['400px', '300px'] });
  });
});
