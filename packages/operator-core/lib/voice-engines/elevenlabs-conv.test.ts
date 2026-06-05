/**
 * askOperatorViaSse — voice path covering the state-snapshot
 * fallbackText surfacing added by the bespoke-card-improvements arc.
 *
 * Plan §6.3 (voice modality) + §4.8 (file scope).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Registry mock drives buildClientTools / buildClientToolCatalog. The
// askOperatorViaSse suite below doesn't touch the registry, so mocking it is
// inert there. `../commands/defs` (a side-effect import in the SUT that would
// register real defs) is stubbed empty so only our mock defs exist.
const runCommand = vi.fn(async () => ({ ok: true, ran: 'cmd' }));
const runQuery = vi.fn(async () => ({ ok: true, ran: 'query' }));
// Only consumed by startElevenLabsConv (not under test). Stub it so the SUT
// module graph resolves cleanly under the mock pipeline.
vi.mock('../browser-workspace', () => ({ wsLocalKey: (k: string) => k }));
vi.mock('../commands/defs', () => ({}));
vi.mock('../commands/registry', () => ({
  list: vi.fn((sel: { kind: string; browser?: string[] }) => {
    if (sel.kind === 'command') {
      // Only browser:'required' (reflexive) commands are exposed as in-page
      // client tools; server-side commands are wired as EL webhook tools and
      // must NOT appear here.
      return sel.browser?.includes('required')
        ? [{ id: 'panel.toggle', description: 'Toggle', promptDescription: 'Toggle the panel', schema: {} }]
        : [];
    }
    return [{ id: 'status.summary', description: 'Status summary', schema: {} }];
  }),
  runCommand: (...a: unknown[]) => runCommand(...(a as [])),
  runQuery: (...a: unknown[]) => runQuery(...(a as [])),
}));

import { askOperatorViaSse, buildClientTools, buildClientToolCatalog } from './elevenlabs-conv';
import { list } from '../commands/registry';

/** Build a Response whose body is an SSE stream of the given lines. */
function sseResponse(lines: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of lines) {
        controller.enqueue(enc.encode(block));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  // First call: history fetch. Return empty turns.
  // Subsequent calls: the operator-converse SSE.
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  // Default history response — overridden per test if needed.
  fetchSpy.mockImplementation((url: string) => {
    if (url.startsWith('/api/operator/conversations?')) {
      return Promise.resolve(
        new Response(JSON.stringify({ turns: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
});

afterEach(() => fetchSpy.mockReset());

describe('askOperatorViaSse — state-snapshot fallbackText surfacing', () => {
  it('plain delta path: returns the <say>-wrapped body', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ turns: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          'event: delta\ndata: {"text":"<say>"}\n\n',
          'event: delta\ndata: {"text":"hello there"}\n\n',
          'event: delta\ndata: {"text":"</say>"}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    );
    const out = await askOperatorViaSse({ text: 'hi' });
    expect(out).toBe('hello there');
  });

  it('state-snapshot with fallbackText appears in the spoken response', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ turns: [] }), { status: 200 }),
      ),
    );
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          'event: delta\ndata: {"text":"<say>checking the docs</say>"}\n\n',
          [
            'event: state-snapshot',
            'data: ' +
              JSON.stringify({
                runId: 'r-1',
                version: 1,
                snapshot: {
                  openCards: [
                    {
                      correlationId: 'cid-1',
                      prompt: 'Confirm details',
                      dataSchemaJson: {},
                      fallbackText: 'Pick: yes or no',
                      createdAt: 0,
                    },
                  ],
                },
              }),
            '',
            '',
          ].join('\n'),
          'event: done\ndata: {}\n\n',
        ]),
      ),
    );
    const out = await askOperatorViaSse({ text: 'hi' });
    expect(out).toContain('checking the docs');
    expect(out).toContain('Pick: yes or no');
  });

  it('state-snapshot without fallbackText falls back to prompt', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ turns: [] }), { status: 200 }),
      ),
    );
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          'event: delta\ndata: {"text":"<say>here</say>"}\n\n',
          [
            'event: state-snapshot',
            'data: ' +
              JSON.stringify({
                runId: 'r',
                version: 1,
                snapshot: {
                  openCards: [
                    {
                      correlationId: 'cid',
                      prompt: 'Which option?',
                      dataSchemaJson: {},
                      createdAt: 0,
                    },
                  ],
                },
              }),
            '',
            '',
          ].join('\n'),
          'event: done\ndata: {}\n\n',
        ]),
      ),
    );
    const out = await askOperatorViaSse({ text: 'hi' });
    expect(out).toContain('Which option?');
  });

  it('deduplicates the same card across multiple state-snapshot events (versioned republishes)', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ turns: [] }), { status: 200 }),
      ),
    );
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          'event: delta\ndata: {"text":"<say>OK</say>"}\n\n',
          [
            'event: state-snapshot',
            'data: ' +
              JSON.stringify({
                runId: 'r',
                version: 1,
                snapshot: {
                  openCards: [
                    { correlationId: 'c1', prompt: '', dataSchemaJson: {}, fallbackText: 'Pick A or B', createdAt: 0 },
                  ],
                },
              }),
            '',
            '',
          ].join('\n'),
          // Same card republished (e.g. version bumped for another mutation).
          [
            'event: state-snapshot',
            'data: ' +
              JSON.stringify({
                runId: 'r',
                version: 2,
                snapshot: {
                  openCards: [
                    { correlationId: 'c1', prompt: '', dataSchemaJson: {}, fallbackText: 'Pick A or B', createdAt: 0 },
                  ],
                },
              }),
            '',
            '',
          ].join('\n'),
          'event: done\ndata: {}\n\n',
        ]),
      ),
    );
    const out = await askOperatorViaSse({ text: 'hi' });
    // 'Pick A or B' appears only once even though state-snapshot was emitted twice.
    const occurrences = out.split('Pick A or B').length - 1;
    expect(occurrences).toBe(1);
  });

  it('state-snapshot ignored when openCards is empty (resolved-card case)', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ turns: [] }), { status: 200 }),
      ),
    );
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          'event: delta\ndata: {"text":"<say>OK</say>"}\n\n',
          [
            'event: state-snapshot',
            'data: ' +
              JSON.stringify({
                runId: 'r',
                version: 1,
                snapshot: { openCards: [] },
              }),
            '',
            '',
          ].join('\n'),
          'event: done\ndata: {}\n\n',
        ]),
      ),
    );
    const out = await askOperatorViaSse({ text: 'hi' });
    expect(out).toBe('OK');
  });

  it('malformed state-snapshot payload is ignored (defensive)', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ turns: [] }), { status: 200 }),
      ),
    );
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          'event: delta\ndata: {"text":"<say>OK</say>"}\n\n',
          'event: state-snapshot\ndata: this-is-not-json\n\n',
          'event: state-snapshot\ndata: {"snapshot": null}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    );
    // No crash; voiceCards stays empty; spoken response unchanged.
    const out = await askOperatorViaSse({ text: 'hi' });
    expect(out).toBe('OK');
  });
});

describe('buildClientTools — reflexive client-tool dispatch', () => {
  const endSession = vi.fn(async () => {});

  beforeEach(() => {
    runCommand.mockClear();
    runQuery.mockClear();
    endSession.mockClear();
    vi.mocked(list).mockClear();
  });

  const tools = () => buildClientTools({ workspace: 'ws-1', tabId: 'tab-9', endSession });

  it('exposes end_conversation, ask_operator, reflexive commands + queries (dotted ids normalized)', () => {
    expect(Object.keys(tools()).sort()).toEqual([
      'ask_operator',
      'end_conversation',
      'panel_toggle',
      'status_summary',
    ]);
  });

  it('a reflexive command handler routes to runCommand with the browser ctx and returns JSON', async () => {
    const out = await tools().panel_toggle({ open: true });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][0]).toBe('panel.toggle');
    expect(runCommand.mock.calls[0][1]).toEqual({ open: true });
    expect(runCommand.mock.calls[0][2]).toMatchObject({
      agent: 'operator',
      workspace: 'ws-1',
      sessionId: 'tab-9',
    });
    expect(out).toBe(JSON.stringify({ ok: true, ran: 'cmd' }));
  });

  it('a query handler routes to runQuery and returns JSON', async () => {
    const out = await tools().status_summary({});
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery.mock.calls[0][0]).toBe('status.summary');
    expect(out).toBe(JSON.stringify({ ok: true, ran: 'query' }));
  });

  it('end_conversation triggers teardown and acks ok', async () => {
    const out = await tools().end_conversation({});
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(out).toBe(JSON.stringify({ ok: true }));
  });

  it('only browser:required commands become client tools (server-side stay webhook tools)', () => {
    tools();
    const cmdCall = vi.mocked(list).mock.calls.find(
      (c) => (c[0] as { kind: string }).kind === 'command',
    );
    expect((cmdCall![0] as { browser?: string[] }).browser).toEqual(['required']);
  });
});

describe('buildClientToolCatalog — EL agent tool-sync catalog', () => {
  it('normalizes names, applies the description fallback, sets expects_response, excludes server-side commands', () => {
    const catalog = buildClientToolCatalog();
    const byName = Object.fromEntries(catalog.map((c) => [c.name, c]));
    // reflexive command → promptDescription wins
    expect(byName.panel_toggle).toMatchObject({ description: 'Toggle the panel', expects_response: true });
    // query without promptDescription → falls back to description
    expect(byName.status_summary).toMatchObject({ description: 'Status summary', expects_response: true });
    // EL tool names are simple identifiers — no dots or dashes
    for (const c of catalog) expect(c.name).not.toMatch(/[.-]/);
  });
});
