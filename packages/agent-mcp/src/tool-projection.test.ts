/**
 * Tests for the projected-tool registry.
 * Run with: npx vitest run packages/agent-mcp/src/tool-projection.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerProjectedTool,
  lookupByMcpName,
  lookupByHttpPath,
  listAllProjectedTools,
  listMcpProjections,
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

  it('exposes name + description + inputSchema only', () => {
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
  });
});
