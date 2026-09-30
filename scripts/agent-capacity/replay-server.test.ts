import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeChunk, fingerprintRequest, type RecordedExchange } from './record-proxy';
import {
  newReplayState,
  parseExchanges,
  parseReplayUrl,
  startReplayServer,
  takeExchange,
  type ReplayServer,
  type ServedRecord,
} from './replay-server';

const MSG = '/v1/messages?beta=true';

function ex(seq: number, over: Partial<RecordedExchange> & { model?: string; messages?: number; tools?: number; body?: string[] } = {}): RecordedExchange {
  const body = over.body ?? [`event: message_start\ndata: {"seq":${seq}}\n\n`, 'event: message_stop\ndata: {}\n\n'];
  return {
    seq,
    sessionId: 's1',
    startedAt: '2026-09-30T00:00:00.000Z',
    method: over.method ?? 'POST',
    path: over.path ?? MSG,
    req: { bytes: 10, sha256: 'x', model: over.model ?? 'm', stream: true, messages: over.messages ?? 2, tools: over.tools ?? 20 },
    status: over.status ?? 200,
    contentType: over.contentType === undefined ? 'text/event-stream; charset=utf-8' : over.contentType,
    ttfbMs: 0,
    totalMs: over.totalMs ?? 0,
    resBytes: 0,
    chunks: over.chunks ?? body.map((b, i) => encodeChunk(i * 5, Buffer.from(b))),
  };
}

const req = (model: string | null, messages: number | null, tools: number | null, p = MSG, method = 'POST') => ({
  method,
  path: p,
  fp: { bytes: 1, sha256: 'y', model, stream: true, messages, tools },
});

describe('takeExchange', () => {
  it('prefers an exact fingerprint over an earlier shape-only match', () => {
    // Main thread (20 tools) and a subagent (14 tools) interleave; the subagent request
    // arrives first but must not steal the main thread's recorded reply.
    const st = newReplayState('s1', 'a', [ex(0, { messages: 2, tools: 20 }), ex(1, { messages: 2, tools: 14 })]);
    expect(takeExchange(st, req('m', 2, 14))).toMatchObject({ tier: 'exact', exchange: { seq: 1 } });
    expect(takeExchange(st, req('m', 2, 20))).toMatchObject({ tier: 'exact', exchange: { seq: 0 } });
    expect(st.counts).toEqual({ exact: 2, shape: 0, path: 0, exhausted: 0 });
  });

  it('serves the earliest unconsumed exact match, so a recorded 502 then its retry replay in order', () => {
    const st = newReplayState('s1', 'a', [ex(0, { status: 502, messages: 10 }), ex(1, { status: 200, messages: 10 })]);
    expect(takeExchange(st, req('m', 10, 20))?.exchange.status).toBe(502);
    expect(takeExchange(st, req('m', 10, 20))?.exchange.status).toBe(200);
  });

  it('falls back to shape, then path, then reports exhaustion', () => {
    const st = newReplayState('s1', 'a', [ex(0, { model: 'm', messages: 4 }), ex(1, { model: 'other', messages: 9 })]);
    expect(takeExchange(st, req('m', 99, 20))?.tier).toBe('shape');
    expect(takeExchange(st, req('m', 99, 20))?.tier).toBe('path');
    expect(takeExchange(st, req('m', 99, 20))).toBeNull();
    expect(takeExchange(st, req('m', 2, 20, '/v1/other'))).toBeNull();
    expect(st.counts).toEqual({ exact: 0, shape: 1, path: 1, exhausted: 2 });
  });

  it('never matches across method or path', () => {
    const st = newReplayState('s1', 'a', [ex(0, { method: 'HEAD', path: '/api/hello' })]);
    expect(takeExchange(st, req(null, null, null, '/api/hello', 'GET'))).toBeNull();
    expect(takeExchange(st, req(null, null, null, '/api/hello', 'HEAD'))?.exchange.seq).toBe(0);
  });
});

describe('parseReplayUrl / parseExchanges', () => {
  it('splits base, instance and the CLI-appended path', () => {
    expect(parseReplayUrl('/r/claude-exc-1-2026/a7/v1/messages?beta=true')).toEqual({ sessionId: 'claude-exc-1-2026', instance: 'a7', rest: MSG });
    expect(parseReplayUrl('/r/s1/a7')).toEqual({ sessionId: 's1', instance: 'a7', rest: '/' });
    expect(parseReplayUrl('/r/s1/a7?x=1')).toEqual({ sessionId: 's1', instance: 'a7', rest: '/?x=1' });
  });

  it('rejects traversal and non-replay urls', () => {
    expect(parseReplayUrl('/r/../a7/v1/messages')).toBeNull();
    expect(parseReplayUrl('/r/..%2Fetc/a7/x')).toBeNull();
    expect(parseReplayUrl('/v1/messages')).toBeNull();
  });

  it('orders exchanges by request seq, not completion order', () => {
    const jsonl = [ex(2), ex(0), ex(1)].map((e) => JSON.stringify(e)).join('\n') + '\n';
    expect(parseExchanges(jsonl).map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

describe('startReplayServer', () => {
  let corpus: string;
  let srv: ReplayServer;
  const logFile = () => path.join(corpus, 'served.jsonl');

  const post = (url: string, body: unknown, method = 'POST') =>
    new Promise<{ status: number; type: string | undefined; body: Buffer; ms: number }>((resolve, reject) => {
      const t0 = Date.now();
      const data = Buffer.from(JSON.stringify(body));
      const r = http.request(url, { method, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body: Buffer.concat(parts), ms: Date.now() - t0 }));
      });
      r.on('error', reject);
      r.end(data);
    });

  const writeSession = (id: string, exchanges: RecordedExchange[]) => {
    mkdirSync(path.join(corpus, id), { recursive: true });
    writeFileSync(path.join(corpus, id, 'exchanges.jsonl'), exchanges.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };

  beforeEach(() => {
    corpus = mkdtempSync(path.join(tmpdir(), 'replay-server-'));
  });
  afterEach(async () => {
    await srv?.close();
    rmSync(corpus, { recursive: true, force: true });
  });

  it('replays recorded bytes, status and content type; answers 400 once the recording is used up', async () => {
    const utf8Split = Buffer.from('data: {"t":"é"}\n\n');
    const chunks = [encodeChunk(0, Buffer.from('event: a\n')), encodeChunk(1, utf8Split.subarray(0, 13)), encodeChunk(2, utf8Split.subarray(13))];
    expect(chunks[1].b64).toBeDefined(); // the split utf8 sequence was recorded as base64
    writeSession('s1', [ex(0, { chunks, messages: 1, tools: 3 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 0, logFile: logFile() });
    const body = { model: 'm', stream: true, messages: [{}], tools: [{}, {}, {}] };
    const r1 = await post(`${srv.baseUrl('s1', 'a')}${MSG}`, body);
    expect(r1.status).toBe(200);
    expect(r1.type).toBe('text/event-stream; charset=utf-8');
    expect(r1.body.toString('utf8')).toBe('event: a\ndata: {"t":"é"}\n\n');

    const r2 = await post(`${srv.baseUrl('s1', 'a')}${MSG}`, body);
    expect(r2.status).toBe(400);
    expect(JSON.parse(r2.body.toString('utf8')).error.message).toMatch(/replay_exhausted/);

    await srv.close();
    const served = readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServedRecord);
    expect(served.map((s) => [s.tier, s.status, s.seq])).toEqual([
      ['exact', 200, 0],
      ['exhausted', 400, null],
    ]);
    expect(served[0].reqBytes).toBe(fingerprintRequest(Buffer.from(JSON.stringify(body))).bytes);
  });

  it('keeps separate consumption state per instance of the same recording', async () => {
    writeSession('s1', [ex(0, { messages: 1, tools: 0 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 0 });
    const body = { model: 'm', messages: [{}], tools: [] };
    const [a, b] = await Promise.all([post(`${srv.baseUrl('s1', 'a')}${MSG}`, body), post(`${srv.baseUrl('s1', 'b')}${MSG}`, body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(srv.states().map((s) => s.counts.exact).sort()).toEqual([1, 1]);
  });

  it('honours recorded delays scaled by speed', async () => {
    const chunks = [encodeChunk(60, Buffer.from('a')), encodeChunk(180, Buffer.from('b'))];
    writeSession('slow', [ex(0, { chunks, messages: 1, tools: 0 }), ex(1, { chunks, messages: 1, tools: 0 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 1 });
    const body = { model: 'm', messages: [{}], tools: [] };
    const real = await post(`${srv.baseUrl('slow', 'a')}${MSG}`, body);
    expect(real.body.toString()).toBe('ab');
    expect(real.ms).toBeGreaterThanOrEqual(170);
    await srv.close();
    srv = await startReplayServer({ corpusDir: corpus, speed: 0 });
    const fast = await post(`${srv.baseUrl('slow', 'a')}${MSG}`, body);
    expect(fast.body.toString()).toBe('ab');
    expect(fast.ms).toBeLessThan(120);
  });

  it('returns 404 for an unknown recording or a non-replay path', async () => {
    srv = await startReplayServer({ corpusDir: corpus, speed: 0 });
    expect((await post(`${srv.url}/r/nope/a${MSG}`, {})).status).toBe(404);
    expect((await post(`${srv.url}/v1/messages`, {})).status).toBe(404);
  });
});
