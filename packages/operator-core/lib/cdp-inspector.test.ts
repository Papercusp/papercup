// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { closeInspector, createCdpClient, redactDiagnosticUrl } from '../../../scripts/cdp-inspector.mjs';

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];

  readyState = 1;
  closed = false;
  sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  readonly url: string;
  readonly options: unknown;
  readonly responses: Map<string, unknown>;

  constructor(url: string, options: unknown, responses: Map<string, unknown>) {
    super();
    this.url = url;
    this.options = options;
    this.responses = responses;
    FakeWebSocket.instances.push(this);
  }

  send(payload: string) {
    const message = JSON.parse(payload);
    this.sent.push(message);
    const response = this.responses.get(message.method);
    if (response === 'close') {
      queueMicrotask(() => this.close());
      return;
    }
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
      id: message.id,
      result: response ?? {},
    }))));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }
}

function makeClient(responses: Map<string, unknown>, options: Record<string, unknown> = {}) {
  class TestWebSocket extends FakeWebSocket {
    constructor(url: string, socketOptions: unknown) {
      super(url, socketOptions, responses);
    }
  }
  return createCdpClient('ws://127.0.0.1:9229/devtools/page/test', {
    WebSocketImpl: TestWebSocket,
    requestTimeoutMs: 20,
    ...options,
  });
}

describe('CDP inspector seam', () => {
  it('redacts credentials, query strings, and fragments from diagnostic URLs', () => {
    const redacted = redactDiagnosticUrl(
      'wss://user:password@example.test:9229/devtools/page/id?access_token=short-lived&safe=yes#fragment',
    );

    expect(redacted).toBe('wss://example.test:9229/devtools/page/id');
    expect(redacted).not.toContain('access_token');
    expect(redacted).not.toContain('short-lived');
    expect(redacted).not.toContain('password');
  });

  it('does not echo an unparseable diagnostic URL', () => {
    expect(redactDiagnosticUrl('not a URL with token=secret')).toBe('<unparseable-url>');
  });

  it('surfaces Runtime.evaluate exceptionDetails as a failure', async () => {
    const client = makeClient(new Map([
      ['Runtime.evaluate', {
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'TypeError: dynamic import is unavailable' },
        },
      }],
    ]));
    await client.connect();

    await expect(client.evaluate('await import("node:inspector")'))
      .rejects.toMatchObject({
        name: 'CdpEvaluationError',
        message: expect.stringContaining('dynamic import is unavailable'),
      });
  });

  it('verifies the inspector port after the expected close-transport loss', async () => {
    const client = makeClient(new Map([['Runtime.evaluate', 'close']]));
    await client.connect();
    const urls: string[] = [];

    await expect(closeInspector(client, 9229, {
      fetchImpl: async (url: string) => {
        urls.push(url);
        throw new Error('ECONNREFUSED');
      },
      sleepImpl: async () => {},
      verifyTimeoutMs: 20,
      pollIntervalMs: 0,
    })).resolves.toEqual({ closed: true });

    expect(urls).toEqual(['http://127.0.0.1:9229/json/list']);
    expect(client.ws.closed).toBe(true);
  });

  it('rejects when the WebSocket closes but /json/list still responds', async () => {
    const client = makeClient(new Map([['Runtime.evaluate', 'close']]));
    await client.connect();

    await expect(closeInspector(client, 9229, {
      fetchImpl: async () => ({ ok: true, json: async () => [] }),
      sleepImpl: async () => {},
      verifyTimeoutMs: 0,
      pollIntervalMs: 0,
    })).rejects.toThrow('inspector still open on port 9229');
  });
});
