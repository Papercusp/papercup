/**
 * Tests for the projected-tool registry.
 * Run with: npx vitest run packages/agent-mcp/src/tool-projection.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  registerProjectedTool,
  lookupByMcpName,
  lookupByHttpPath,
  listAllProjectedTools,
  listMcpProjections,
  classifyEventWire,
  ToolRegistrationError,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
} from './tool-projection';

const noop: ProjectedTool['fn'] = async () => ({
  content: [{ type: 'text', text: 'ok' }],
});

const baseTool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'test tool',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: { mcp: { name: 'fix.tool' } },
  fn: noop,
  ...over,
});

afterEach(() => _resetProjectionRegistryForTests());

describe('registerProjectedTool', () => {
  it('registers a tool with both http + mcp exposure', () => {
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'fix.both' }, http: { path: '/api/plugins/fix/both' } },
    }));
    expect(lookupByMcpName('fix.both')).toBeDefined();
    expect(lookupByHttpPath('/api/plugins/fix/both')).toBeDefined();
  });

  it('registers an mcp-only tool', () => {
    registerProjectedTool(baseTool({ expose: { mcp: { name: 'fix.only_mcp' } } }));
    expect(lookupByMcpName('fix.only_mcp')).toBeDefined();
    expect(lookupByHttpPath('/api/plugins/fix/only_mcp')).toBeUndefined();
  });

  it('registers an http-only tool (invisible to agents)', () => {
    registerProjectedTool(baseTool({ expose: { http: { path: '/api/plugins/fix/admin' } } }));
    expect(lookupByMcpName('fix.admin')).toBeUndefined();
    expect(lookupByHttpPath('/api/plugins/fix/admin')).toBeDefined();
  });

  it('rejects a tool with no exposure', () => {
    expect(() => registerProjectedTool(baseTool({ expose: {} }))).toThrow(ToolRegistrationError);
  });

  it('rejects a name without a namespace separator', () => {
    expect(() => registerProjectedTool(baseTool({ expose: { mcp: { name: 'noprefix' } } }))).toThrow(/namespace separator/);
  });

  it('accepts colon-separated names (legacy built-in convention)', () => {
    registerProjectedTool(baseTool({ expose: { mcp: { name: 'tasks:list' } } }));
    expect(lookupByMcpName('tasks:list')).toBeDefined();
  });

  it('rejects a non-absolute HTTP path', () => {
    expect(() => registerProjectedTool(baseTool({ expose: { http: { path: 'no/leading/slash' } } }))).toThrow(/must start with/);
  });

  it('rejects duplicate MCP names across plugins', () => {
    registerProjectedTool(baseTool({ pluginName: 'a', expose: { mcp: { name: 'dup.tool' } } }));
    expect(() => registerProjectedTool(baseTool({ pluginName: 'b', expose: { mcp: { name: 'dup.tool' } } }))).toThrow(/claimed by plugins "a" and "b"/);
  });

  it('rejects duplicate HTTP paths across plugins', () => {
    registerProjectedTool(baseTool({
      pluginName: 'a',
      expose: { mcp: { name: 'a.x' }, http: { path: '/api/dup' } },
    }));
    expect(() => registerProjectedTool(baseTool({
      pluginName: 'b',
      expose: { mcp: { name: 'b.x' }, http: { path: '/api/dup' } },
    }))).toThrow(/HTTP path "\/api\/dup" claimed by plugins "a" and "b"/);
  });
});

describe('listAllProjectedTools', () => {
  it('returns all registered tools regardless of exposure shape', () => {
    registerProjectedTool(baseTool({ expose: { mcp: { name: 'a.one' } } }));
    registerProjectedTool(baseTool({ expose: { http: { path: '/api/b' } } }));
    registerProjectedTool(baseTool({ expose: { mcp: { name: 'c.three' }, http: { path: '/api/c' } } }));
    expect(listAllProjectedTools()).toHaveLength(3);
  });
});

describe('listMcpProjections', () => {
  it('returns only tools with expose.mcp', () => {
    registerProjectedTool(baseTool({ expose: { mcp: { name: 'mcp.one' } } }));
    registerProjectedTool(baseTool({ expose: { http: { path: '/api/http-only' } } }));
    expect(listMcpProjections().map((t) => t.name)).toEqual(['mcp.one']);
  });

  it('filters by role allowlist when provided', () => {
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'a.worker' } }, roles: ['worker'],
    }));
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'b.architect' } }, roles: ['architect'],
    }));
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 'c.any' } }, // no roles -> visible to everyone
    }));
    const workerView = listMcpProjections('worker').map((t) => t.name).sort();
    expect(workerView).toEqual(['a.worker', 'c.any']);
  });

  it('exposes name + description + inputSchema only when events is absent', () => {
    registerProjectedTool(baseTool({
      description: 'desc x',
      inputSchema: { type: 'object', properties: { foo: { type: 'string' } } },
      capabilities: ['secrets:read:X'],
      expose: { mcp: { name: 'x.tool' } },
    }));
    const list = listMcpProjections();
    expect(list[0]).toEqual({
      name: 'x.tool',
      description: 'desc x',
      inputSchema: { type: 'object', properties: { foo: { type: 'string' } } },
    });
    // capabilities, roles, etc. NOT exposed in listing — agents see only the contract.
    expect((list[0] as Record<string, unknown>).capabilities).toBeUndefined();
    expect((list[0] as Record<string, unknown>).events).toBeUndefined();
  });

  it('surfaces events schemas as JSON-Schema when the tool declares them', () => {
    registerProjectedTool(baseTool({
      description: 'streamy tool',
      expose: { mcp: { name: 's.tool' } },
      events: {
        delta: z.object({ text: z.string() }),
        cost: z.object({ usd: z.number() }),
      },
    }));
    const list = listMcpProjections();
    expect(list[0]?.events).toBeDefined();
    expect(Object.keys(list[0]!.events!).sort()).toEqual(['cost', 'delta']);
    // JSON-Schema shape — each event has type:object + properties.
    expect(list[0]!.events!.delta).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
    });
    expect(list[0]!.events!.cost).toMatchObject({
      type: 'object',
      properties: { usd: { type: 'number' } },
    });
    // $schema is stripped — clients don't need the metadata.
    expect((list[0]!.events!.delta as Record<string, unknown>).$schema).toBeUndefined();
  });

  it('omits events field when declared schema is empty', () => {
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 's.empty' } },
      events: {}, // declared but empty
    }));
    const list = listMcpProjections();
    expect(list[0]?.events).toBeUndefined();
  });

  it('round-trips .describe() through to events JSON-Schema (content-type hint)', () => {
    // Tools can annotate an event payload's content-type (or any other
    // hint) via z.string().describe('...') / z.object({...}).describe('...').
    // Surfaced in tools/list as the JSON-Schema `description` field —
    // clients pick parsers / renderers off it.
    registerProjectedTool(baseTool({
      expose: { mcp: { name: 's.described' } },
      events: {
        diff_patch: z.string().describe('application/xml'),
        log_line:   z.string().describe('text/plain'),
        progress:   z.object({ pct: z.number() }).describe('Progress payload'),
      },
    }));
    const list = listMcpProjections();
    expect(list[0]?.events?.diff_patch).toMatchObject({
      type: 'string',
      description: 'application/xml',
    });
    expect(list[0]?.events?.log_line).toMatchObject({
      type: 'string',
      description: 'text/plain',
    });
    expect(list[0]?.events?.progress).toMatchObject({
      type: 'object',
      description: 'Progress payload',
    });
  });
});

describe('classifyEventWire', () => {
  it('returns "string" for z.string()', () => {
    expect(classifyEventWire(z.string())).toBe('string');
  });

  it('returns "string" for z.string() with describe()', () => {
    expect(classifyEventWire(z.string().describe('text/plain'))).toBe('string');
  });

  it('returns "json" for z.object({...})', () => {
    expect(classifyEventWire(z.object({ usd: z.number() }))).toBe('json');
  });

  it('returns "json" for z.number()', () => {
    expect(classifyEventWire(z.number())).toBe('json');
  });

  it('returns "binary" for z.instanceof(Uint8Array)', () => {
    expect(classifyEventWire(z.instanceof(Uint8Array))).toBe('binary');
  });

  it('binary classification survives a registerProjectedTool round-trip', () => {
    registerProjectedTool({
      pluginName: 'fixture',
      description: 'binary tool',
      inputSchema: { type: 'object' },
      capabilities: [],
      expose: { mcp: { name: 'bin.tool' } },
      events: {
        chunk: z.instanceof(Uint8Array),
        meta:  z.object({ size: z.number() }),
      },
      fn: noop,
    });
    const t = lookupByMcpName('bin.tool')!;
    expect(t.eventWireKinds?.chunk).toBe('binary');
    expect(t.eventWireKinds?.meta).toBe('json');
  });
});
