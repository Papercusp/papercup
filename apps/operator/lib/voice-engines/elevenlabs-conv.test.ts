/**
 * askOperatorViaSse — voice path covering the state-snapshot
 * fallbackText surfacing added by the bespoke-card-improvements arc.
 *
 * Plan §6.3 (voice modality) + §4.8 (file scope).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { askOperatorViaSse } from './elevenlabs-conv';

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
