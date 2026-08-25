/**
 * Standalone tests for the MCP bridge primitives — import ONLY @papercusp/tooldef
 * + this package (no agent-mcp, no operator, no mcp-handler).
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProjectedTool, UnifiedToolContext } from '@papercusp/tooldef';
import {
  bearerFromExtra,
  urlFromExtra,
  headersFromExtra,
  dispatchProjectedToolToMcp,
} from './index';

const ctx = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  ...over,
});

const tool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'fixture',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: { mcp: { name: 'fix.tool' } },
  fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  ...over,
});

describe('RequestHandlerExtra extractors', () => {
  it('bearerFromExtra strips the Bearer prefix', () => {
    expect(bearerFromExtra({ requestInfo: { headers: { authorization: 'Bearer xyz' } } })).toBe('xyz');
    expect(bearerFromExtra({ requestInfo: { headers: { authorization: ['Bearer abc'] } } })).toBe('abc');
    expect(bearerFromExtra({})).toBe('');
  });
  it('urlFromExtra parses the request URL', () => {
    expect(urlFromExtra({ requestInfo: { url: 'http://h/p?role=worker' } })?.searchParams.get('role')).toBe('worker');
    expect(urlFromExtra({})).toBeNull();
    expect(urlFromExtra({ requestInfo: { url: 'not a url' } })).toBeNull();
  });
  it('headersFromExtra builds a Headers (arrays joined)', () => {
    const h = headersFromExtra({ requestInfo: { headers: { 'x-a': '1', 'x-b': ['2', '3'] } } });
    expect(h.get('x-a')).toBe('1');
    expect(h.get('x-b')).toBe('2, 3');
  });
});

describe('dispatchProjectedToolToMcp', () => {
  it('maps a successful dispatch to { content }', async () => {
    const r = await dispatchProjectedToolToMcp(tool(), 'fix.tool', {}, ctx(), {});
    expect(r.isError).toBeUndefined();
    expect(r.content[0]).toEqual({ type: 'text', text: 'ok' });
  });
  it('maps a gate denial to { isError, content:"<code>: <msg>" }', async () => {
    const r = await dispatchProjectedToolToMcp(tool({ agentRoles: ['architect'] }), 'fix.tool', {}, ctx({ role: 'worker' }), {});
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/^role_not_allowed: /);
  });
});
