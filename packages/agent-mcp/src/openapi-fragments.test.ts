import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  standardResponseComponents,
  toolToOpenApiFragment,
} from './openapi-fragments';
import type { ProjectedTool } from './tool-projection';

const makeTool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'fixture tool',
  inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
  capabilities: [],
  expose: { mcp: { name: 'fix.tool' } },
  fn: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  ...over,
});

describe('toolToOpenApiFragment — path + operation', () => {
  it('puts the tool name verbatim into the path (colon preserved)', () => {
    const frag = toolToOpenApiFragment('operator:scan', makeTool());
    expect(frag.path).toBe('/api/operator:scan');
  });

  it('uses a custom pathPrefix when provided', () => {
    const frag = toolToOpenApiFragment('t', makeTool(), { pathPrefix: '/custom' });
    expect(frag.path).toBe('/custom/t');
  });

  it('emits operationId = toolName + description', () => {
    const frag = toolToOpenApiFragment('hi.tool', makeTool({ description: 'hi desc' }));
    expect(frag.operation.operationId).toBe('hi.tool');
    expect(frag.operation.description).toBe('hi desc');
  });

  it('emits requestBody pointing at #/components/schemas/<tool>.Input', () => {
    const frag = toolToOpenApiFragment('t', makeTool());
    const rb = frag.operation.requestBody as { content: { 'application/json': { schema: { $ref: string } } } };
    expect(rb.content['application/json'].schema.$ref).toBe('#/components/schemas/t.Input');
  });

  it('emits both text/event-stream + application/json under 200', () => {
    const frag = toolToOpenApiFragment('t', makeTool());
    const res200 = (frag.operation.responses as Record<string, { content: Record<string, unknown> }>)['200'];
    expect(res200.content['text/event-stream']).toBeDefined();
    expect(res200.content['application/json']).toBeDefined();
  });

  it('emits 400/401/403/408/429/500 as $refs', () => {
    const frag = toolToOpenApiFragment('t', makeTool());
    const responses = frag.operation.responses as Record<string, unknown>;
    for (const code of ['400', '401', '403', '408', '429', '500']) {
      expect((responses[code] as { $ref?: string }).$ref).toMatch(/^#\/components\/responses\//);
    }
  });
});

describe('toolToOpenApiFragment — events + state', () => {
  it('emits per-event schemas with discriminator on `event`', () => {
    const frag = toolToOpenApiFragment('t', makeTool({
      events: {
        progress: z.object({ done: z.number(), total: z.number() }),
        finding: z.object({ severity: z.enum(['info', 'warn']), text: z.string() }),
      },
    }));
    expect(frag.schemas['t.Event.progress']).toBeDefined();
    expect(frag.schemas['t.Event.finding']).toBeDefined();
    const sse = (
      (frag.operation.responses as Record<string, { content: Record<string, { schema: { oneOf: unknown[]; discriminator: { propertyName: string; mapping: Record<string, string> } } }> }>)
        ['200'].content['text/event-stream'].schema
    );
    expect(sse.discriminator.propertyName).toBe('event');
    expect(sse.discriminator.mapping.progress).toBe('#/components/schemas/t.Event.progress');
  });

  it('always adds done + chunk to the event schemas', () => {
    const frag = toolToOpenApiFragment('t', makeTool());
    expect(frag.schemas['t.Event.done']).toBeDefined();
    expect(frag.schemas['t.Event.chunk']).toBeDefined();
  });

  it('adds Event.state when the tool declares a state schema', () => {
    const frag = toolToOpenApiFragment('t', makeTool({
      state: z.object({ status: z.string() }),
    }));
    expect(frag.schemas['t.Event.state']).toBeDefined();
  });

  it("doesn't add Event.state when no state declared", () => {
    const frag = toolToOpenApiFragment('t', makeTool());
    expect(frag.schemas['t.Event.state']).toBeUndefined();
  });

  it('event wrappers include `event` as a string-literal enum + `data`', () => {
    const frag = toolToOpenApiFragment('t', makeTool({
      events: { tick: z.object({ n: z.number() }) },
    }));
    const tick = frag.schemas['t.Event.tick'] as {
      properties: { event: { enum: string[] }; data: unknown };
      required: string[];
    };
    expect(tick.properties.event.enum).toEqual(['tick']);
    expect(tick.required).toContain('event');
    expect(tick.required).toContain('data');
  });

  it('falls back to a description on unrepresentable Zod schemas', () => {
    const frag = toolToOpenApiFragment('t', makeTool({
      events: { binary: z.instanceof(Uint8Array) },
    }));
    const binary = frag.schemas['t.Event.binary'] as { properties: { data: { description?: string } } };
    expect(binary.properties.data.description).toMatch(/not representable/i);
  });
});

describe('toolToOpenApiFragment — security + vendor extensions', () => {
  it('security includes the capability list', () => {
    const frag = toolToOpenApiFragment('t', makeTool({ capabilities: ['tasks:read', 'tasks:write'] }));
    const security = frag.operation.security as Array<Record<string, unknown>>;
    expect(security[0].bearerAuth).toEqual(['tasks:read', 'tasks:write']);
  });

  it('security is empty array when no capabilities', () => {
    const frag = toolToOpenApiFragment('t', makeTool({ capabilities: [] }));
    const security = frag.operation.security as Array<Record<string, unknown>>;
    expect(security[0].bearerAuth).toEqual([]);
  });

  it('emits vendor extensions for roles / timeouts / replayBuffer / modality / plugin', () => {
    const frag = toolToOpenApiFragment('t', makeTool({
      pluginName: 'fixture',
      roles: ['architect', 'scoper'],
      timeoutSec: 120,
      idleTimeoutSec: 30,
      replayBufferSize: 64,
      modality: ['text', 'voice'],
    }));
    expect(frag.operation['x-papercusp-roles']).toEqual(['architect', 'scoper']);
    expect(frag.operation['x-papercusp-timeoutSec']).toBe(120);
    expect(frag.operation['x-papercusp-idleTimeoutSec']).toBe(30);
    expect(frag.operation['x-papercusp-replayBufferSize']).toBe(64);
    expect(frag.operation['x-papercusp-modality']).toEqual(['text', 'voice']);
    expect(frag.operation['x-papercusp-plugin']).toBe('fixture');
  });

  it('omits vendor extensions when no value is set', () => {
    const frag = toolToOpenApiFragment('t', makeTool());
    expect(frag.operation['x-papercusp-roles']).toBeUndefined();
    expect(frag.operation['x-papercusp-idleTimeoutSec']).toBeUndefined();
    expect(frag.operation['x-papercusp-replayBufferSize']).toBeUndefined();
  });
});

describe('standardResponseComponents', () => {
  it('returns all 7 named response components', () => {
    const r = standardResponseComponents();
    for (const name of [
      'InvalidInput',
      'Unauthorized',
      'RoleOrCapabilityDenied',
      'Timeout',
      'QuotaExceeded',
      'HandlerError',
      'UnknownTool',
    ]) {
      expect(r[name]).toBeDefined();
    }
  });

  it('every component carries the same error envelope shape', () => {
    const r = standardResponseComponents();
    for (const [, comp] of Object.entries(r)) {
      const schema = (comp as { content: { 'application/json': { schema: unknown } } }).content['application/json'].schema as Record<string, unknown>;
      expect(schema).toMatchObject({
        type: 'object',
        required: ['error'],
      });
    }
  });
});
