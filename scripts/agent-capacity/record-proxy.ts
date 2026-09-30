/**
 * Recording reverse proxy for the agent-capacity workload corpus
 * (plan agent-capacity-and-cost-gcp-2026-09-30, P-002).
 *
 * A claude or codex CLI is pointed at this proxy (ANTHROPIC_BASE_URL, or a codex
 * `model_provider` base_url). Every request is forwarded unchanged to the upstream
 * (the local inference gateway, which injects the pooled account's credentials), and
 * the response is streamed back while each chunk is recorded with its offset from the
 * moment the request body finished arriving. The resulting exchanges.jsonl is what the
 * P-003 fake model server replays — same bytes, same delays — so real CLIs and real tool
 * commands run on a test VM without spending model quota.
 *
 * Request bodies are NOT stored: they carry whole conversations and the CLI rebuilds
 * them during replay. A fingerprint (bytes, sha256, model, message/tool counts) is kept
 * so the replay server can check it is feeding the right session in the right order.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { performance } from 'node:perf_hooks';

/** One recorded response chunk: `t` = ms after the request body completed. */
export interface RecordedChunk {
  t: number;
  /** utf8 text of the chunk, when it decodes losslessly. */
  d?: string;
  /** base64 of the chunk otherwise (binary, or a chunk that splits a utf8 sequence). */
  b64?: string;
}

export interface RequestFingerprint {
  bytes: number;
  sha256: string;
  model: string | null;
  stream: boolean;
  /** `messages.length` (Anthropic) or `input.length` (OpenAI Responses); null if neither. */
  messages: number | null;
  tools: number | null;
}

export interface RecordedExchange {
  seq: number;
  sessionId: string;
  startedAt: string;
  method: string;
  path: string;
  req: RequestFingerprint;
  status: number;
  contentType: string | null;
  /** ms from request-body-complete to the first response byte; null if none arrived. */
  ttfbMs: number | null;
  totalMs: number;
  resBytes: number;
  chunks: RecordedChunk[];
  error?: string;
}

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'proxy-connection',
  'upgrade',
  'te',
  'trailer',
]);

export function fingerprintRequest(body: Buffer): RequestFingerprint {
  const fp: RequestFingerprint = {
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    model: null,
    stream: false,
    messages: null,
    tools: null,
  };
  if (body.length === 0) return fp;
  try {
    const j = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    if (typeof j.model === 'string') fp.model = j.model;
    fp.stream = j.stream === true;
    if (Array.isArray(j.messages)) fp.messages = j.messages.length;
    else if (Array.isArray(j.input)) fp.messages = j.input.length;
    if (Array.isArray(j.tools)) fp.tools = j.tools.length;
  } catch {
    // Non-JSON body: bytes + sha256 are still a usable fingerprint.
  }
  return fp;
}

/** Encode a chunk as utf8 text when that round-trips exactly, else base64. */
export function encodeChunk(t: number, chunk: Buffer): RecordedChunk {
  const text = chunk.toString('utf8');
  if (!text.includes('�') && Buffer.byteLength(text, 'utf8') === chunk.length) return { t, d: text };
  return { t, b64: chunk.toString('base64') };
}

export function decodeChunk(c: RecordedChunk): Buffer {
  return c.b64 !== undefined ? Buffer.from(c.b64, 'base64') : Buffer.from(c.d ?? '', 'utf8');
}

export interface RecordProxyOptions {
  /** e.g. http://127.0.0.1:8788 — request paths are appended verbatim. */
  upstream: string;
  /** exchanges.jsonl path (appended). */
  outFile: string;
  sessionId: string;
  /** 0 = pick a free port. */
  port?: number;
}

export interface RecordProxy {
  port: number;
  url: string;
  /** Exchanges recorded so far (in completion order). */
  count(): number;
  close(): Promise<void>;
}

export async function startRecordProxy(opts: RecordProxyOptions): Promise<RecordProxy> {
  const upstream = new URL(opts.upstream);
  const out = createWriteStream(opts.outFile, { flags: 'a' });
  let seq = 0;
  let written = 0;
  const inflight = new Set<Promise<void>>();

  const server = http.createServer((req, res) => {
    const mySeq = seq++;
    const startedAt = new Date().toISOString();
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    const done = new Promise<void>((resolve) => {
      req.on('end', () => {
        const body = Buffer.concat(parts);
        const t0 = performance.now();
        const chunks: RecordedChunk[] = [];
        let resBytes = 0;
        let ttfb: number | null = null;
        const rec = (status: number, contentType: string | null, error?: string) => {
          const ex: RecordedExchange = {
            seq: mySeq,
            sessionId: opts.sessionId,
            startedAt,
            method: req.method ?? 'GET',
            path: req.url ?? '/',
            req: fingerprintRequest(body),
            status,
            contentType,
            ttfbMs: ttfb,
            totalMs: Math.round(performance.now() - t0),
            resBytes,
            chunks,
            ...(error ? { error } : {}),
          };
          out.write(JSON.stringify(ex) + '\n');
          written++;
          resolve();
        };

        const headers: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
        }
        // Record plain bytes, never a compressed stream the replay would have to re-frame.
        headers['accept-encoding'] = 'identity';
        headers['content-length'] = String(body.length);

        const up = http.request(
          {
            protocol: upstream.protocol,
            hostname: upstream.hostname,
            port: upstream.port,
            method: req.method,
            path: upstream.pathname.replace(/\/$/, '') + (req.url ?? '/'),
            headers,
          },
          (upRes) => {
            const resHeaders: http.OutgoingHttpHeaders = {};
            for (const [k, v] of Object.entries(upRes.headers)) {
              if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) resHeaders[k] = v;
            }
            res.writeHead(upRes.statusCode ?? 502, resHeaders);
            upRes.on('data', (c: Buffer) => {
              const t = Math.round(performance.now() - t0);
              if (ttfb === null) ttfb = t;
              resBytes += c.length;
              chunks.push(encodeChunk(t, c));
              res.write(c);
            });
            upRes.on('end', () => {
              res.end();
              rec(upRes.statusCode ?? 0, (upRes.headers['content-type'] as string | undefined) ?? null);
            });
            upRes.on('error', (e) => {
              res.destroy(e);
              rec(upRes.statusCode ?? 0, null, `upstream-response: ${e.message}`);
            });
          },
        );
        up.on('error', (e) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'record_proxy_upstream_error', message: e.message } }));
          } else {
            res.destroy(e);
          }
          rec(502, 'application/json', `upstream-request: ${e.message}`);
        });
        up.end(body);
      });
    });
    inflight.add(done);
    void done.finally(() => inflight.delete(done));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    count: () => written,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([...inflight]);
      await new Promise<void>((resolve) => out.end(resolve));
    },
  };
}
