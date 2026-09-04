import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readResponseBody } from './fetch';

function responseFrom(chunks: string[]): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(chunks[index++]));
    },
  });
  return new Response(stream);
}

describe('readResponseBody', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('keeps a response at or below the cap in memory without creating a spill', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-fetch-body-'));
    roots.push(root);

    const result = await readResponseBody(responseFrom(['hello', ' world']), 11, root);

    expect(result).toEqual({ body: 'hello world', truncated: false });
  });

  it('streams an oversized response to disk while retaining only the bounded prefix inline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-fetch-body-'));
    roots.push(root);

    const result = await readResponseBody(responseFrom(['0123', '456789']), 5, root);

    expect(result.truncated).toBe(true);
    expect(result.body).toBe('01234');
    expect(result.logPath).toBeDefined();
    expect(readFileSync(result.logPath!, 'utf8')).toBe('0123456789');
  });

  it('does not call Response.text, so the cap is enforced by the stream reader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-fetch-body-'));
    roots.push(root);
    const response = responseFrom(['streamed']);
    Object.defineProperty(response, 'text', { value: () => { throw new Error('text() must not be used'); } });

    await expect(readResponseBody(response, 32, root)).resolves.toEqual({ body: 'streamed', truncated: false });
  });
});
