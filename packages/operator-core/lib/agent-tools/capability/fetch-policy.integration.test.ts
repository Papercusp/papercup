import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CapabilityFetchSizeLimitError, readResponseBody } from './fetch';
import { fetchWithCapabilityPolicy } from './fetch-policy';

const trusted = { kind: 'trusted', reason: 'superuser' } as const;
const confined = { kind: 'confined', reason: 'autonomous-caller' } as const;

describe('capability fetch boundary — real socket', () => {
  let server: Server;
  let baseUrl = '';
  let effects = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      effects += 1;
      if (req.url === '/large') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('1234');
        res.write('5678');
        res.end('overflow');
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, authorization: req.headers.authorization, body }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('preserves an authenticated trusted local-model style POST', async () => {
    const request = await fetchWithCapabilityPolicy({
      url: `${baseUrl}/echo`,
      method: 'POST',
      headers: { authorization: 'Bearer local-integration', 'content-type': 'application/json' },
      body: '{"prompt":"hello"}',
      signal: new AbortController().signal,
      profile: trusted,
    });
    try {
      await expect(request.response.json()).resolves.toEqual({
        method: 'POST',
        authorization: 'Bearer local-integration',
        body: '{"prompt":"hello"}',
      });
    } finally {
      await request.release();
    }
  });

  it('rejects the same loopback destination for confined work before the server sees it', async () => {
    const before = effects;
    await expect(fetchWithCapabilityPolicy({
      url: `${baseUrl}/echo`,
      method: 'GET',
      signal: new AbortController().signal,
      profile: confined,
    })).rejects.toMatchObject({ code: 'confined_private_address' });
    expect(effects).toBe(before);
  });

  it('cancels a real chunked response once the total-download budget is crossed', async () => {
    const request = await fetchWithCapabilityPolicy({
      url: `${baseUrl}/large`,
      method: 'GET',
      signal: new AbortController().signal,
      profile: trusted,
    });
    try {
      await expect(readResponseBody(request.response, 4, undefined, 8)).rejects.toBeInstanceOf(
        CapabilityFetchSizeLimitError,
      );
    } finally {
      await request.release();
    }
  });
});
