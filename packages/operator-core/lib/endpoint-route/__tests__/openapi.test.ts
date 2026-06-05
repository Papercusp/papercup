/**
 * Route → OpenAPI fragment emitter (R3).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { routeToOpenApiFragment, allRouteFragments } from '../openapi';

describe('routeToOpenApiFragment', () => {
  it('emits the path under /api with the route method', () => {
    const f = routeToOpenApiFragment(
      defineTool({ method: 'GET', path: '/desktop/version', auth: 'public', handler: () => new Response() }),
    );
    expect(f.path).toBe('/api/desktop/version');
    expect(f.httpMethod).toBe('get');
  });

  it('converts Hono path params to OpenAPI {brace} form + emits path parameters', () => {
    const f = routeToOpenApiFragment(
      defineTool({ method: 'GET', path: '/harness/:slug/file', auth: 'public', handler: () => new Response() }),
    );
    expect(f.path).toBe('/api/harness/{slug}/file');
    const params = f.operation.parameters as Array<{ name: string; in: string; required: boolean }>;
    expect(params).toContainEqual(expect.objectContaining({ name: 'slug', in: 'path', required: true }));
  });

  it('public route → empty security; gated route → bearerAuth', () => {
    const pub = routeToOpenApiFragment(
      defineTool({ method: 'GET', path: '/p', auth: 'public', handler: () => new Response() }),
    );
    expect(pub.operation.security).toEqual([]);
    const gated = routeToOpenApiFragment(
      defineTool({ method: 'GET', path: '/g', auth: { trust: ['trusted'] }, handler: () => new Response() }),
    );
    expect(gated.operation.security).toEqual([{ bearerAuth: [] }]);
  });

  it('POST with input → requestBody + a components schema', () => {
    const f = routeToOpenApiFragment(
      defineTool({
        method: 'POST', path: '/echo', auth: 'public',
        input: z.object({ n: z.number() }),
        handler: () => new Response(),
      }),
    );
    expect(f.operation.requestBody).toBeDefined();
    expect(Object.keys(f.schemas).length).toBe(1);
  });

  it('GET with input → query parameters, no requestBody', () => {
    const f = routeToOpenApiFragment(
      defineTool({
        method: 'GET', path: '/q', auth: 'public',
        input: z.object({ limit: z.coerce.number() }),
        handler: () => new Response(),
      }),
    );
    expect(f.operation.requestBody).toBeUndefined();
    const params = f.operation.parameters as Array<{ name: string; in: string }>;
    expect(params).toContainEqual(expect.objectContaining({ name: 'limit', in: 'query' }));
  });

  it('tags the operation x-papercusp-projection: route', () => {
    const f = routeToOpenApiFragment(
      defineTool({ method: 'GET', path: '/x', auth: 'public', handler: () => new Response() }),
    );
    expect(f.operation['x-papercusp-projection']).toBe('route');
  });

  it('emits the standard error responses', () => {
    const f = routeToOpenApiFragment(
      defineTool({ method: 'GET', path: '/x', auth: 'public', handler: () => new Response() }),
    );
    const responses = f.operation.responses as Record<string, unknown>;
    for (const code of ['400', '401', '403', '408', '500']) {
      expect((responses[code] as { $ref?: string }).$ref).toMatch(/^#\/components\/responses\//);
    }
  });
});

describe('allRouteFragments', () => {
  it('emits one fragment per registered route', () => {
    const frags = allRouteFragments();
    expect(frags.length).toBeGreaterThan(0);
    for (const f of frags) {
      expect(f.path.startsWith('/api/')).toBe(true);
      expect(f.httpMethod).toBeDefined();
    }
  });

  it('every operationId is unique', () => {
    const ids = allRouteFragments().map((f) => f.operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('device tagging (E10)', () => {
  it('tags a device-authed route with papercusp:device', () => {
    const f = routeToOpenApiFragment(
      defineTool({
        method: 'GET',
        path: '/device/thing',
        auth: { kind: ['device'] },
        handler: () => new Response(),
      }),
    );
    expect(f.operation.tags).toEqual(['papercusp:device']);
  });

  it('omits the tag on a route that admits no device principal', () => {
    const f = routeToOpenApiFragment(
      defineTool({ method: 'GET', path: '/desktop/thing', auth: 'public', handler: () => new Response() }),
    );
    expect(f.operation.tags).toBeUndefined();
  });

  it('the device-authed /api/device/* routes carry papercusp:device', () => {
    // The device-JWT routes gate on `auth: { kind: ['device'] }` and are
    // tagged. Public handshakes (`/pair`, `/desktop/mint-pair-token`) and
    // the loopback `/qr.svg` admit no device principal, so they are
    // deliberately untagged — the tag marks the device-authed surface,
    // not "about mobile".
    const mobileFrags = allRouteFragments().filter((f) => f.path.startsWith('/api/device/'));
    const tagged = mobileFrags.filter((f) =>
      ((f.operation.tags as string[] | undefined) ?? []).includes('papercusp:device'),
    );
    expect(tagged.length).toBeGreaterThan(10);
    const pair = mobileFrags.find((f) => f.path === '/api/device/pair');
    expect(pair, '/api/device/pair fragment exists').toBeTruthy();
    expect((pair!.operation.tags as string[] | undefined) ?? []).not.toContain('papercusp:device');
  });
});
