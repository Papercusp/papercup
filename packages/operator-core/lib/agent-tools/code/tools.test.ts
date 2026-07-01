import { describe, it, expect } from 'vitest';
import {
  listAllProjectedTools,
  generateToolFacadeTypes,
  listFacadeNamespaces,
} from '@papercusp/agent-mcp';
import type { ProjectedTool } from '@papercusp/agent-mcp';
import './tools'; // side-effect: registers code:tools

/**
 * B-CX-API: code:tools registers as a READ-effect, role-gated lookup, AND the signature
 * generators are reachable through the @papercusp/agent-mcp re-export the handler composes
 * (the wiring chain tooldef → agent-mcp → operator-core).
 */
describe('code:tools registration + wiring (B-CX-API)', () => {
  it('registers code:tools as a read-effect, role-gated tool', () => {
    const tool = listAllProjectedTools().find((t) => t.expose.mcp?.name === 'code:tools');
    expect(tool).toBeDefined();
    expect(tool?.effect).toBe('read');
    expect(tool?.agentRoles?.length ?? 0).toBeGreaterThan(0);
    // args schema accepts the on-demand selectors.
    const props = (tool?.inputSchema?.properties ?? {}) as Record<string, unknown>;
    expect(props).toHaveProperty('namespaces');
    expect(props).toHaveProperty('names');
  });

  it('the re-exported generators render typed signatures + the namespace index', () => {
    const mk = (name: string, inputSchema: Record<string, unknown>, description = ''): ProjectedTool =>
      ({ expose: { mcp: { name } }, description, inputSchema }) as unknown as ProjectedTool;
    const tools = [
      mk(
        'work_items:list',
        {
          type: 'object',
          properties: { status: { type: 'string', enum: ['open', 'closed'] } },
          required: [],
          additionalProperties: false,
        },
        'List work-items.',
      ),
    ];

    const dts = generateToolFacadeTypes(tools, { allowed: new Set(['work_items:list']) });
    expect(dts).toContain('declare const tools: {');
    // tooldef b7e2b32: facade namespaces render camelCased (`camelNamespace`) — the script
    // surface is `tools.workItems.list(...)`; the raw snake name survives only in toolNames.
    expect(dts).toContain('workItems: {');
    expect(dts).toContain('list(args?: { status?: "open" | "closed" }): Promise<unknown>;');
    expect(dts).toContain('call(toolName: string, args?: unknown): Promise<unknown>;');

    const idx = listFacadeNamespaces(tools, new Set(['work_items:list']));
    expect(idx).toEqual([{ ns: 'workItems', verbs: ['list'], toolNames: ['work_items:list'] }]);
  });
});
