/**
 * Live in-process tests for the agent-tools catch-all SSE route.
 *
 * Covers:
 *   - 406 Not Acceptable on Accept: text/event-stream against a tool
 *     that doesn't stream (no events, no streaming flag).
 *   - 200 + SSE wire on streaming tools.
 *   - 200 + JSON on non-streaming tools with Accept: application/json.
 *
 * Catches the strict-streamable opt-in path the audit flagged as
 * untested.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  registerProjectedTool,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
} from '@papercusp/agent-mcp';

import { GET, POST } from './route';

const handlerOK: ProjectedTool['fn'] = async () => ({
  content: [{ type: 'text', text: 'ok' }],
});

function makeStreamingTool(): ProjectedTool {
  return {
    pluginName: 'fixture',
    description: 'streaming fixture',
    inputSchema: { type: 'object' },
    capabilities: [],
    requiresPrincipal: false,
    args: z.object({}),
    events: { delta: z.object({ text: z.string() }) },
    eventWireKinds: { delta: 'json' },
    expose: {
      http: { path: '/api/agent-tools/fix/stream', methods: ['POST'] },
      mcp: { name: 'fix:stream' },
    },
    fn: async (_input, ctx) => {
      ctx.emit?.('delta', { text: 'hi' });
      return { content: [{ type: 'text', text: 'done' }] };
    },
  };
}

function makeNonStreamingTool(): ProjectedTool {
  return {
    pluginName: 'fixture',
    description: 'plain JSON fixture',
    inputSchema: { type: 'object' },
    capabilities: [],
    requiresPrincipal: false,
    args: z.object({}),
    expose: {
      http: { path: '/api/agent-tools/fix/plain', methods: ['GET', 'POST'] },
      mcp: { name: 'fix:plain' },
    },
    fn: handlerOK,
  };
}

beforeEach(() => {
  _resetProjectionRegistryForTests();
});

afterEach(() => {
  _resetProjectionRegistryForTests();
});

describe('catch-all route strict-streamable behavior', () => {
  it('returns 406 when Accept: text/event-stream against a non-streaming tool', async () => {
    registerProjectedTool(makeNonStreamingTool());
    const req = new Request('http://x.test/api/agent-tools/fix/plain', {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: '{}',
    });
    const res = await POST(req);
    expect(res.status).toBe(406);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_acceptable');
  });

  it('returns 200 SSE when Accept: text/event-stream against a streaming tool', async () => {
    registerProjectedTool(makeStreamingTool());
    const req = new Request('http://x.test/api/agent-tools/fix/stream', {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
      body: '{}',
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // Drain the body — should contain at least 'event: delta' and 'event: done'.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let payload = '';
    let safety = 50;
    while (safety-- > 0) {
      const { value, done } = await reader.read();
      if (done) break;
      payload += decoder.decode(value, { stream: true });
      if (payload.includes('event: done')) break;
    }
    expect(payload).toContain('event: delta');
    expect(payload).toContain('event: done');
    await reader.cancel().catch(() => { /* already done */ });
  });

  it('returns 200 JSON when Accept defaults (no event-stream) on a streaming tool', async () => {
    registerProjectedTool(makeStreamingTool());
    const req = new Request('http://x.test/api/agent-tools/fix/stream', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}',
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('GET also dispatches (legacy compat)', async () => {
    registerProjectedTool(makeNonStreamingTool());
    const req = new Request('http://x.test/api/agent-tools/fix/plain', { method: 'GET' });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  describe('runId + replay headers (Phase 4 T2.2)', () => {
    it('sets X-Papercusp-Run-Id response header on streaming response', async () => {
      registerProjectedTool(makeStreamingTool());
      const req = new Request('http://x.test/api/agent-tools/fix/stream', {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        body: '{}',
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const runId = res.headers.get('X-Papercusp-Run-Id');
      expect(runId).toBeTruthy();
      // Format: UUID-ish (8-4-4-4-12 hex) — crypto.randomUUID() shape.
      expect(runId!).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('echoes the client-provided X-Papercusp-Run-Id on response (for resume)', async () => {
      registerProjectedTool(makeStreamingTool());
      const clientRunId = 'fa11b6c7-aaaa-bbbb-cccc-ddeeff001122';
      const req = new Request('http://x.test/api/agent-tools/fix/stream', {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'X-Papercusp-Run-Id': clientRunId,
        },
        body: '{}',
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Papercusp-Run-Id')).toBe(clientRunId);
    });
  });
});
