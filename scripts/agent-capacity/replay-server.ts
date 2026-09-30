/**
 * Fake model server for the agent-capacity load driver
 * (plan agent-capacity-and-cost-gcp-2026-09-30, P-003).
 *
 * Serves the responses recorded by `record-proxy.ts` back to real claude / codex CLIs, with
 * the recorded first-byte and inter-chunk delays, so N agents run their real tool commands on
 * a test VM without spending model quota. One server process serves any number of concurrent
 * replays:
 *
 *   base URL for one agent = http://<host>:<port>/r/<sessionId>/<instance>
 *     claude: ANTHROPIC_BASE_URL=<base>            (the CLI appends /v1/messages?beta=true)
 *     codex:  model_providers.<p>.base_url=<base>/v1
 *
 * `<sessionId>` names a directory under the corpus; `<instance>` is any token the driver picks,
 * so N agents can replay the SAME recording, each with its own consumption state.
 *
 * Matching. Request bodies were not recorded (they rebuild during replay), only a fingerprint.
 * Claude Code runs a subagent's requests concurrently with the main thread's, so arrival order
 * is not a reliable key. Each request takes the EARLIEST unconsumed recorded exchange at the
 * best tier available:
 *   exact — same method, path, model, message count and tool count
 *   shape — same method, path and model (the conversation diverged)
 *   path  — same method and path
 * When nothing is left the server answers 400 `replay_exhausted`: neither CLI retries a 400,
 * so a diverged replay ends at once instead of spinning in retry backoff. Every served request
 * is logged with its tier so the driver can reject a replay that diverged.
 *
 *   npx tsx scripts/agent-capacity/replay-server.ts --corpus <dir> [--port 18700] [--speed 1] \
 *     [--log <served.jsonl>]
 *
 * `--speed` divides every recorded delay (2 = twice as fast; 0 = no delays at all).
 */
import http from 'node:http';
import { createWriteStream, existsSync, readFileSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { decodeChunk, fingerprintRequest, type RecordedExchange, type RequestFingerprint } from './record-proxy';

export type MatchTier = 'exact' | 'shape' | 'path';

export interface IncomingRequest {
  method: string;
  /** Path relative to the replay base, e.g. `/v1/messages?beta=true`. */
  path: string;
  fp: RequestFingerprint;
}

export interface ReplayState {
  sessionId: string;
  instance: string;
  exchanges: readonly RecordedExchange[];
  consumed: boolean[];
  counts: Record<MatchTier | 'exhausted', number>;
}

export function newReplayState(sessionId: string, instance: string, exchanges: readonly RecordedExchange[]): ReplayState {
  return {
    sessionId,
    instance,
    exchanges,
    consumed: exchanges.map(() => false),
    counts: { exact: 0, shape: 0, path: 0, exhausted: 0 },
  };
}

function tierOf(ex: RecordedExchange, req: IncomingRequest): MatchTier | null {
  if (ex.method !== req.method || ex.path !== req.path) return null;
  if (ex.req.model !== req.fp.model) return 'path';
  if (ex.req.messages !== req.fp.messages || ex.req.tools !== req.fp.tools) return 'shape';
  return 'exact';
}

const RANK: Record<MatchTier, number> = { exact: 0, shape: 1, path: 2 };

/**
 * Pick (and consume) the recorded exchange this request should receive: the earliest
 * unconsumed one at the best tier. Returns null when nothing on this method+path is left.
 */
export function takeExchange(state: ReplayState, req: IncomingRequest): { exchange: RecordedExchange; tier: MatchTier } | null {
  let best = -1;
  let bestTier: MatchTier | null = null;
  for (let i = 0; i < state.exchanges.length; i++) {
    if (state.consumed[i]) continue;
    const tier = tierOf(state.exchanges[i], req);
    if (tier === null) continue;
    if (bestTier === null || RANK[tier] < RANK[bestTier]) {
      best = i;
      bestTier = tier;
      if (tier === 'exact') break;
    }
  }
  if (bestTier === null) {
    state.counts.exhausted++;
    return null;
  }
  state.consumed[best] = true;
  state.counts[bestTier]++;
  return { exchange: state.exchanges[best], tier: bestTier };
}

export function parseExchanges(jsonl: string): RecordedExchange[] {
  const out: RecordedExchange[] = [];
  for (const line of jsonl.split('\n')) if (line.trim()) out.push(JSON.parse(line) as RecordedExchange);
  // Recorded in COMPLETION order; replay ranks by request order.
  return out.sort((a, b) => a.seq - b.seq);
}

const TOKEN = /^[A-Za-z0-9._-]+$/;

/** Split `/r/<sessionId>/<instance>/<rest>`; null for anything else (or an unsafe token). */
export function parseReplayUrl(url: string): { sessionId: string; instance: string; rest: string } | null {
  const m = /^\/r\/([^/?]+)\/([^/?]+)(\/.*|\?.*)?$/.exec(url);
  if (!m || !TOKEN.test(m[1]) || !TOKEN.test(m[2]) || m[1].startsWith('.')) return null;
  const rest = m[3] ?? '/';
  return { sessionId: m[1], instance: m[2], rest: rest.startsWith('?') ? `/${rest}` : rest };
}

export interface ServedRecord {
  at: string;
  sessionId: string;
  instance: string;
  method: string;
  path: string;
  tier: MatchTier | 'exhausted';
  seq: number | null;
  status: number;
  reqBytes: number;
  recordedReqBytes: number | null;
  messages: number | null;
  recordedMessages: number | null;
  /** ms from request-body-complete to the last byte written. */
  servedMs: number;
  recordedMs: number | null;
}

export interface ReplayServerOptions {
  corpusDir: string;
  port?: number;
  host?: string;
  /** Delay divisor: 1 = recorded timing, 2 = twice as fast, 0 = no delays. */
  speed?: number;
  logFile?: string;
}

export interface ReplayServer {
  port: number;
  url: string;
  /** Replay base URL for one agent. */
  baseUrl(sessionId: string, instance: string): string;
  states(): ReplayState[];
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startReplayServer(opts: ReplayServerOptions): Promise<ReplayServer> {
  const speed = opts.speed ?? 1;
  const delayOf = (ms: number) => (speed > 0 ? ms / speed : 0);
  const recordings = new Map<string, RecordedExchange[]>();
  const states = new Map<string, ReplayState>();
  const log: WriteStream | null = opts.logFile ? createWriteStream(opts.logFile, { flags: 'a' }) : null;
  const inflight = new Set<Promise<void>>();

  const recording = (sessionId: string): RecordedExchange[] | null => {
    const hit = recordings.get(sessionId);
    if (hit) return hit;
    const file = path.join(opts.corpusDir, sessionId, 'exchanges.jsonl');
    if (!existsSync(file)) return null;
    const ex = parseExchanges(readFileSync(file, 'utf8'));
    recordings.set(sessionId, ex);
    return ex;
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/healthz') return json(res, 200, { ok: true, sessions: recordings.size, replays: states.size });
    if (url === '/stats') {
      return json(res, 200, {
        replays: [...states.values()].map((s) => ({
          sessionId: s.sessionId,
          instance: s.instance,
          recorded: s.exchanges.length,
          remaining: s.consumed.filter((c) => !c).length,
          counts: s.counts,
        })),
      });
    }
    const parsed = parseReplayUrl(url);
    if (!parsed) return json(res, 404, { error: { type: 'not_found', message: `not a replay url: ${url}` } });
    const exchanges = recording(parsed.sessionId);
    if (!exchanges) return json(res, 404, { error: { type: 'not_found', message: `no recording ${parsed.sessionId}` } });
    const key = `${parsed.sessionId}/${parsed.instance}`;
    let state = states.get(key);
    if (!state) {
      state = newReplayState(parsed.sessionId, parsed.instance, exchanges);
      states.set(key, state);
    }
    const st = state;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    const done = new Promise<void>((resolve) => {
      req.on('end', () => {
        const body = Buffer.concat(parts);
        const fp = fingerprintRequest(body);
        const method = req.method ?? 'GET';
        const t0 = performance.now();
        const picked = takeExchange(st, { method, path: parsed.rest, fp });
        const write = (r: Omit<ServedRecord, 'at' | 'sessionId' | 'instance' | 'method' | 'path' | 'reqBytes' | 'messages' | 'servedMs'>) => {
          const rec: ServedRecord = {
            at: new Date().toISOString(),
            sessionId: st.sessionId,
            instance: st.instance,
            method,
            path: parsed.rest,
            reqBytes: body.length,
            messages: fp.messages,
            servedMs: Math.round(performance.now() - t0),
            ...r,
          };
          log?.write(JSON.stringify(rec) + '\n');
          resolve();
        };
        if (!picked) {
          json(res, 400, {
            type: 'error',
            error: { type: 'invalid_request_error', message: `replay_exhausted: no recorded ${method} ${parsed.rest} left for ${key}` },
          });
          write({ tier: 'exhausted', seq: null, status: 400, recordedReqBytes: null, recordedMessages: null, recordedMs: null });
          return;
        }
        const { exchange: ex, tier } = picked;
        void (async () => {
          let aborted = false;
          res.on('close', () => {
            if (!res.writableFinished) aborted = true;
          });
          const first = ex.chunks[0];
          if (first) await sleep(delayOf(first.t));
          if (aborted) return write({ tier, seq: ex.seq, status: 499, recordedReqBytes: ex.req.bytes, recordedMessages: ex.req.messages, recordedMs: ex.totalMs });
          const headers: http.OutgoingHttpHeaders = {};
          if (ex.contentType) headers['content-type'] = ex.contentType;
          res.writeHead(ex.status, headers);
          let prevT = first?.t ?? 0;
          for (const c of ex.chunks) {
            const gap = c.t - prevT;
            if (gap > 0) await sleep(delayOf(gap));
            prevT = c.t;
            if (aborted) break;
            res.write(decodeChunk(c));
          }
          const tail = ex.totalMs - prevT;
          if (!aborted && tail > 0 && ex.chunks.length === 0) await sleep(delayOf(tail));
          res.end();
          write({ tier, seq: ex.seq, status: aborted ? 499 : ex.status, recordedReqBytes: ex.req.bytes, recordedMessages: ex.req.messages, recordedMs: ex.totalMs });
        })();
      });
    });
    inflight.add(done);
    void done.finally(() => inflight.delete(done));
  });

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  return {
    port,
    url,
    baseUrl: (sessionId, instance) => `${url}/r/${sessionId}/${instance}`,
    states: () => [...states.values()],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([...inflight]);
      if (log) await new Promise<void>((r) => log.end(r));
    },
  };
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const corpusDir = arg('corpus');
  if (!corpusDir) throw new Error('--corpus <dir> required');
  const srv = await startReplayServer({
    corpusDir,
    port: Number(arg('port', '18700')),
    host: arg('host', '127.0.0.1'),
    speed: Number(arg('speed', '1')),
    logFile: arg('log'),
  });
  console.log(`REPLAY_SERVER ${srv.url} corpus=${corpusDir}`);
  const stop = () => void srv.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && /replay-server\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
