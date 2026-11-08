import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import {
  readPendingSessionEndWitness,
  reportSessionEnded,
  reportSessionResumed,
  reportSessionResumeFinalized,
  reportSessionResumeReleased,
} from '../scripts/psu-launcher.mjs';

type LifecycleOptions = NonNullable<Parameters<typeof reportSessionEnded>[2]>
  & NonNullable<Parameters<typeof reportSessionResumed>[1]>
  & NonNullable<Parameters<typeof reportSessionResumeFinalized>[2]>;

describe('keyed PSU lifecycle response-body recovery', () => {
  const cases = [
    { name: 'end', field: 'reported', report: (options: LifecycleOptions) => reportSessionEnded(42, 0, options) },
    { name: 'acquire', field: 'claimed', report: (options: LifecycleOptions) => reportSessionResumed(42, options) },
    { name: 'finalize', field: 'finalized', report: (options: LifecycleOptions) => reportSessionResumeFinalized(42, 'same-key', options) },
    { name: 'release', field: 'released', report: (options: LifecycleOptions) => reportSessionResumeReleased(42, 'same-key', options) },
  ];

  it.each(cases)('$name replays a body reset after commit with the same exact request', async ({ report, field }) => {
    const home = mkdtempSync(join(tmpdir(), 'psu-body-replay-'));
    const requests: string[] = [];
    const committed = new Set<string>();
    const fetchImpl = async (_url: unknown, options?: RequestInit) => {
      const body = String(options?.body);
      requests.push(body);
      committed.add(body);
      if (requests.length === 1) {
        return {
          ok: true, status: 200,
          json: async () => { throw new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }); },
        };
      }
      return Response.json({ ok: true, status: 'acquired', acquired: true,
        finalized: true, released: true, resumeClaimKey: 'same-key' });
    };
    try {
      const result = await report({ home, fetchImpl, token: 'test', operatorUrl: 'http://operator.test',
        endAttemptKey: 'same-key', resumeClaimKey: 'same-key', launchArgv: ['psu', '--resume=42'],
        connectBudgetMs: 1000, timeoutRetries: 1, sleep: async () => {}, onNotice: () => {} });
      expect(result).toMatchObject({ [field]: true });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe(requests[0]);
      expect(committed.size).toBe(1);
      expect(readPendingSessionEndWitness(42, home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(cases)('$name retains an unknown body-timeout outcome when replay is exhausted', async ({ report, field }) => {
    const home = mkdtempSync(join(tmpdir(), 'psu-body-timeout-'));
    let attempts = 0;
    try {
      const result = await report({ home, token: 'test', operatorUrl: 'http://operator.test',
        endAttemptKey: 'same-key', resumeClaimKey: 'same-key', connectBudgetMs: 0, timeoutRetries: 0,
        fetchImpl: async () => {
          attempts++;
          return { ok: true, status: 200, json: async () => { throw new DOMException('body deadline', 'TimeoutError'); } };
        } });
      expect(result).toMatchObject({ [field]: false, reason: 'transport', phase: 'response-body' });
      expect(attempts).toBe(1);
      if (field === 'reported') expect(readPendingSessionEndWitness(42, home)).toMatchObject({ endAttemptKey: 'same-key' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps a malformed acknowledgement as HTTP failure without replaying it', async () => {
    let attempts = 0;
    const result = await reportSessionResumeFinalized(42, 'same-key', {
      token: 'test', operatorUrl: 'http://operator.test', connectBudgetMs: 0, timeoutRetries: 0,
      fetchImpl: async () => {
        attempts++;
        return { ok: true, status: 200, json: async () => { throw new SyntaxError('invalid JSON'); } };
      },
    });
    expect(result).toMatchObject({ finalized: false, reason: 'http' });
    expect(attempts).toBe(1);
  });

  it('recovers a native HTTP body reset after headers without a second logical finalize', async () => {
    const bodies: string[] = [];
    const committed = new Set<string>();
    let pending: ServerResponse | undefined;
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      bodies.push(body);
      committed.add(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      if (bodies.length === 1) {
        pending = response;
        response.write('{"ok":');
      } else {
        response.end(JSON.stringify({ ok: true, finalized: true, resumeClaimKey: 'native-key' }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    let headersReceived = 0;
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test listener missing');
      const result = await reportSessionResumeFinalized(42, 'native-key', {
        operatorUrl: `http://127.0.0.1:${address.port}`, token: 'test',
        connectBudgetMs: 1000, timeoutMs: 1000, timeoutRetries: 1,
        sleep: async () => {}, onNotice: () => {},
        fetchImpl: async (input, init) => {
          const response = await fetch(input, init);
          // Guarantee the failure is after fetch resolves, while JSON is incomplete.
          if (++headersReceived === 1) pending?.destroy();
          return response;
        },
      });
      expect(result).toMatchObject({ finalized: true });
      expect(headersReceived).toBe(2);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(committed.size).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
