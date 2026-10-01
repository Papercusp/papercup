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
import {
  decodeChunk,
  encodeChunk,
  fingerprintRequest,
  reportedExecSessions,
  type ExecSessionReport,
  type RecordedChunk,
  type RecordedExchange,
  type RequestFingerprint,
} from './record-proxy';

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

// ---------------------------------------------------------------------------------------------
// Work-dir rewriting.
//
// A recording's tool calls name ABSOLUTE paths inside the checkout it ran in
// (`~/.cache/agent-capacity/work/<sessionId>`). Served unchanged, a replay's Write lands outside
// its own checkout and the next Bash fails, so the tool work no longer follows the recording
// even while every request matches `exact`. Each instance therefore gets the recorded work dir
// rewritten to its own.
//
// The path is rarely whole inside one SSE event: tool input streams as `input_json_delta`
// (Anthropic) or `*.delta` (OpenAI Responses) fragments that split it anywhere. So the rewrite
// reassembles each delta stream, replaces across the fragment boundaries, and redistributes
// the result over the same events; non-delta events get a recursive string replace.
// ---------------------------------------------------------------------------------------------

export interface PathRewrite {
  from: string;
  to: string;
}

/**
 * Replace `from` with `to` in the concatenation of `pieces`, then cut the result back into the
 * same number of pieces at the mapped boundaries. A boundary that fell inside a match moves to
 * the end of its replacement. Returns `pieces` itself when nothing matched.
 */
export function replaceAcross(pieces: readonly string[], from: string, to: string): readonly string[] {
  const s = pieces.join('');
  if (!from || from === to || !s.includes(from)) return pieces;
  const edits: Edit[] = [];
  for (let i = s.indexOf(from); i >= 0; i = s.indexOf(from, i + from.length)) edits.push({ start: i, end: i + from.length, to });
  return spliceAcross(pieces, edits);
}

/** One replacement in the concatenation of a piece list: `[start, end)` becomes `to`. */
export interface Edit {
  start: number;
  end: number;
  to: string;
}

/**
 * Apply sorted, non-overlapping `edits` to the concatenation of `pieces`, then cut the result
 * back into the same number of pieces at the mapped boundaries. A boundary that fell inside an
 * edited span moves to the end of its replacement. Returns `pieces` itself when no edit changes
 * anything.
 */
export function spliceAcross(pieces: readonly string[], edits: readonly Edit[]): readonly string[] {
  const s = pieces.join('');
  const real = edits.filter((e) => s.slice(e.start, e.end) !== e.to);
  if (real.length === 0) return pieces;
  let out = '';
  let at = 0;
  for (const e of real) {
    out += s.slice(at, e.start) + e.to;
    at = e.end;
  }
  out += s.slice(at);
  const mapCut = (cut: number): number => {
    let shift = 0;
    for (const e of real) {
      if (e.end <= cut) shift += e.to.length - (e.end - e.start);
      else if (e.start < cut) return e.start + shift + e.to.length;
      else break;
    }
    return cut + shift;
  };
  const res: string[] = [];
  let oldEnd = 0;
  let newStart = 0;
  for (let k = 0; k < pieces.length; k++) {
    oldEnd += pieces[k].length;
    const newEnd = k === pieces.length - 1 ? out.length : mapCut(oldEnd);
    res.push(out.slice(newStart, newEnd));
    newStart = newEnd;
  }
  return res;
}

/** Both spellings a path can take: raw (text, already-parsed JSON) and JSON-escaped (partial_json source). */
function variants(rw: PathRewrite): PathRewrite[] {
  const esc = (s: string) => JSON.stringify(s).slice(1, -1);
  const out = [rw];
  if (esc(rw.from) !== rw.from) out.push({ from: esc(rw.from), to: esc(rw.to) });
  return out;
}

/**
 * Rewrites the concatenation of a piece list and hands back the same number of pieces (see
 * `spliceAcross`), or the input array itself when nothing changed.
 */
export type PieceRewriter = (pieces: readonly string[]) => readonly string[];

function pathRewriter(rw: PathRewrite): PieceRewriter {
  return (pieces) => {
    let cur = pieces;
    for (const v of variants(rw)) cur = replaceAcross(cur, v.from, v.to);
    return cur;
  };
}

/** Recursive string rewrite; returns the input itself when nothing changed. */
function deepReplace(v: unknown, fn: PieceRewriter): unknown {
  if (typeof v === 'string') {
    const [r] = fn([v]);
    return r;
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = deepReplace(x, fn);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  if (v && typeof v === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const y = deepReplace(x, fn);
      if (y !== x) changed = true;
      out[k] = y;
    }
    return changed ? out : v;
  }
  return v;
}

interface SseEvent {
  /** Raw event text including its blank-line terminator (or the unterminated tail). */
  text: string;
  /** Recorded time of the chunk that completed this event. */
  t: number;
  data: Record<string, unknown> | null;
  modified: boolean;
}

/** Split recorded chunks into SSE events, each stamped with the time its last byte arrived. */
export function sseEvents(chunks: readonly RecordedChunk[]): SseEvent[] {
  const bufs = chunks.map(decodeChunk);
  const body = Buffer.concat(bufs);
  const ends: number[] = [];
  let acc = 0;
  for (const b of bufs) ends.push((acc += b.length));
  const tAt = (byte: number): number => {
    for (let i = 0; i < ends.length; i++) if (byte < ends[i]) return chunks[i].t;
    return chunks.at(-1)?.t ?? 0;
  };
  const events: SseEvent[] = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== 0x0a) continue;
    const blank = (i >= 1 && body[i - 1] === 0x0a) || (i >= 2 && body[i - 1] === 0x0d && body[i - 2] === 0x0a);
    if (!blank) continue;
    events.push(parseEvent(body.subarray(start, i + 1).toString('utf8'), tAt(i)));
    start = i + 1;
  }
  if (start < body.length) events.push(parseEvent(body.subarray(start).toString('utf8'), tAt(body.length - 1)));
  return events;
}

function parseEvent(text: string, t: number): SseEvent {
  const lines = text.split(/\r?\n/);
  const dataLines = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
  let data: Record<string, unknown> | null = null;
  if (dataLines.length) {
    try {
      const j = JSON.parse(dataLines.join('\n'));
      if (j && typeof j === 'object' && !Array.isArray(j)) data = j as Record<string, unknown>;
    } catch {
      // `[DONE]` and other non-JSON payloads pass through untouched.
    }
  }
  return { text, t, data, modified: false };
}

function serializeEvent(e: SseEvent): string {
  if (!e.modified || !e.data) return e.text;
  const nl = e.text.includes('\r\n') ? '\r\n' : '\n';
  const body = e.text.replace(/\r?\n\r?\n$/, '');
  const out: string[] = [];
  let wroteData = false;
  for (const l of body.split(/\r?\n/)) {
    if (!l.startsWith('data:')) out.push(l);
    else if (!wroteData) {
      out.push(`data: ${JSON.stringify(e.data)}`);
      wroteData = true;
    }
  }
  return out.join(nl) + nl + nl;
}

/** The string-valued field of a streamed delta event, and the stream it belongs to. */
function deltaSlot(d: Record<string, unknown>): { key: string; get: () => string; set: (s: string) => void } | null {
  const type = typeof d.type === 'string' ? d.type : '';
  if (type === 'content_block_delta' && d.delta && typeof d.delta === 'object') {
    const delta = d.delta as Record<string, unknown>;
    const field = delta.type === 'input_json_delta' ? 'partial_json' : delta.type === 'text_delta' ? 'text' : null;
    if (!field || typeof delta[field] !== 'string') return null;
    return { key: `cb:${String(d.index)}:${field}`, get: () => delta[field] as string, set: (s) => (delta[field] = s) };
  }
  if (type.endsWith('.delta') && typeof d.delta === 'string') {
    const key = [type, d.item_id, d.output_index, d.content_index, d.summary_index].map((x) => String(x ?? '')).join('|');
    return { key, get: () => d.delta as string, set: (s) => (d.delta = s) };
  }
  return null;
}

/**
 * The exchange with every occurrence of `rw.from` in its response replaced by `rw.to`, or the
 * same object when nothing referenced it. Rewritten SSE responses are re-chunked one chunk per
 * set of events completed at the same recorded time, so a client sees each event when the
 * recording delivered its last byte.
 */
export function rewriteExchange(ex: RecordedExchange, rewrite: PathRewrite | PieceRewriter): RecordedExchange {
  if (typeof rewrite !== 'function' && (!rewrite.from || rewrite.from === rewrite.to)) return ex;
  if (ex.chunks.length === 0) return ex;
  const rw = typeof rewrite === 'function' ? rewrite : pathRewriter(rewrite);
  if (!(ex.contentType ?? '').includes('event-stream')) {
    const body = Buffer.concat(ex.chunks.map(decodeChunk)).toString('utf8');
    const [out] = rw([body]);
    if (out === body) return ex;
    return { ...ex, chunks: [encodeChunk(ex.chunks.at(-1)!.t, Buffer.from(out, 'utf8'))] };
  }
  const events = sseEvents(ex.chunks);
  const streams = new Map<string, { events: SseEvent[]; slots: NonNullable<ReturnType<typeof deltaSlot>>[] }>();
  for (const e of events) {
    if (!e.data) continue;
    const slot = deltaSlot(e.data);
    if (slot) {
      const s = streams.get(slot.key) ?? { events: [], slots: [] };
      s.events.push(e);
      s.slots.push(slot);
      streams.set(slot.key, s);
      continue;
    }
    const next = deepReplace(e.data, rw);
    if (next !== e.data) {
      e.data = next as Record<string, unknown>;
      e.modified = true;
    }
  }
  for (const s of streams.values()) {
    const before = s.slots.map((x) => x.get());
    const after = rw(before);
    if (after === before) continue;
    after.forEach((piece, i) => {
      if (piece === before[i]) return;
      s.slots[i].set(piece);
      s.events[i].modified = true;
    });
  }
  if (!events.some((e) => e.modified)) return ex;
  const chunks: RecordedChunk[] = [];
  let pending = '';
  let pendingT: number | null = null;
  for (const e of events) {
    if (pendingT !== null && e.t !== pendingT) {
      chunks.push(encodeChunk(pendingT, Buffer.from(pending, 'utf8')));
      pending = '';
    }
    pending += serializeEvent(e);
    pendingT = e.t;
  }
  if (pendingT !== null) chunks.push(encodeChunk(pendingT, Buffer.from(pending, 'utf8')));
  return { ...ex, chunks };
}

// ---------------------------------------------------------------------------------------------
// Exec-session id rewriting (Codex unified exec).
//
// A Codex command still running when its tool call yields comes back to the model as
// `session_id: <n>`, and the model polls or interrupts it later with
// `tools.write_stdin({session_id:<n>, ...})`. The CLI picks <n> at random, so a replay's ids
// differ from the recording's and every served poll named a process that did not exist:
// `write_stdin failed: Unknown process id`. The polls fail fast, the first run is never read
// or interrupted, and the replay's tool work (and its CPU and memory) stops following the
// recording while every request still matches `exact`.
//
// EXACT pairing (recordings whose request fingerprints carry `execSessions`): the recording
// says which call_id reported each recorded id, and the replay's own tool output for that same
// call_id (served from the recording, so the call_ids agree) reports the replay id. A recorded
// id whose call has not reported a replay process stays UNMAPPED rather than borrowing one, so
// a command that finished inside its yield in the replay is never paired with another process.
//
// ORDER pairing (the 2026-09-30 corpus, recorded before fingerprints kept `execSessions`): a
// recorded id is visible only where the model names it (served responses), and a replay id
// only where the CLI reports it. Each instance pairs them in order of first appearance: the
// i-th distinct recorded id the model names maps to the i-th distinct id the replay reported.
// That is exact when the model first polls its processes in the order it started them. It
// drifts when the model first polls a later process, or when a command still running in the
// replay had already finished in the recording. (In that corpus, 11 Codex recordings poll
// processes and 4 of them alternate between several.) Each served record logs the map it
// applied, the mode, and any named id left unmapped, so a drifted replay is visible.
// ---------------------------------------------------------------------------------------------

/** The id in a model-written `session_id:<n>` (JS argument or JSON, raw or JSON-escaped). */
const NAMED_SESSION_ID = /(session_id\\*"?\s*:\s*)(\d+)/g;

/** Distinct exec-session ids the model names in this exchange's response, in order. */
export function namedExecSessionIds(ex: RecordedExchange): string[] {
  const body = Buffer.concat(ex.chunks.map(decodeChunk)).toString('utf8');
  const out: string[] = [];
  for (const m of body.matchAll(NAMED_SESSION_ID)) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

/** A rewriter that replaces each mapped id in `session_id:<n>`; ids sharing a prefix are safe. */
export function execSessionRewriter(map: ReadonlyMap<string, string>): PieceRewriter {
  return (pieces) => {
    if (map.size === 0) return pieces;
    const s = pieces.join('');
    const edits: Edit[] = [];
    for (const m of s.matchAll(NAMED_SESSION_ID)) {
      const to = map.get(m[2]);
      if (to === undefined) continue;
      const start = m.index + m[1].length;
      edits.push({ start, end: start + m[2].length, to });
    }
    return spliceAcross(pieces, edits);
  };
}

/**
 * Distinct exec-session ids the CLI reported in the tool outputs of an OpenAI Responses
 * request (`input[]` items whose type ends in `_output`), in conversation order. Model-written
 * items are skipped, so a served recorded id is never mistaken for a replay one.
 */
export function reportedExecSessionIds(body: Buffer): string[] {
  let input: unknown;
  try {
    input = (JSON.parse(body.toString('utf8')) as { input?: unknown }).input;
  } catch {
    return [];
  }
  return reportedExecSessions(input).map((r) => r.id);
}

/**
 * Recorded exec-session id -> the call_id whose output first reported it, from the request
 * fingerprints of a recording. Null when the recording predates `execSessions` (no exchange
 * carries the field), which selects order pairing.
 */
export function recordedExecCalls(exchanges: readonly RecordedExchange[]): Map<string, string> | null {
  let any = false;
  const out = new Map<string, string>();
  for (const ex of exchanges) {
    const reports = ex.req.execSessions;
    if (!reports) continue;
    any = true;
    for (const r of reports) if (r.callId && !out.has(r.id)) out.set(r.id, r.callId);
  }
  return any ? out : null;
}

/** Per-instance pairing of recorded exec-session ids with the replay's own. */
export interface ExecSessionIds {
  /** Recorded ids in the order the served responses first named them. */
  recorded: string[];
  /** Replay ids in the order the instance's tool outputs first reported them. */
  replay: string[];
  /** call_id -> the replay id its output reported (exact pairing). */
  replayByCall?: Map<string, string>;
}

/** Record ids (and, when known, the call_id each answered) newly reported by an incoming request. */
export function learnReplayIds(ids: ExecSessionIds, reported: readonly (string | ExecSessionReport)[]): void {
  for (const r of reported) {
    const { id, callId } = typeof r === 'string' ? { id: r, callId: '' } : r;
    if (!ids.replay.includes(id)) ids.replay.push(id);
    if (callId) {
      ids.replayByCall ??= new Map();
      if (!ids.replayByCall.has(callId)) ids.replayByCall.set(callId, id);
    }
  }
}

/**
 * The recorded->replay map for the ids this response names, registering ids named for the
 * first time, plus the named ids that have no replay id yet. With `recordedCalls` (the
 * recording's id -> call_id map) an id the recording attributes to a call is paired through
 * that call only; an id it does not attribute falls back to order pairing.
 */
export function pairFor(
  ids: ExecSessionIds,
  named: readonly string[],
  recordedCalls?: ReadonlyMap<string, string> | null,
): { map: Map<string, string>; unmapped: string[]; by: 'call_id' | 'order' } {
  const map = new Map<string, string>();
  const unmapped: string[] = [];
  let byOrder = false;
  for (const id of named) {
    if (!ids.recorded.includes(id)) ids.recorded.push(id);
    const callId = recordedCalls?.get(id);
    let replay: string | undefined;
    if (callId !== undefined) replay = ids.replayByCall?.get(callId);
    else {
      byOrder = true;
      replay = ids.replay[ids.recorded.indexOf(id)];
    }
    if (replay === undefined) unmapped.push(id);
    else map.set(id, replay);
  }
  return { map, unmapped, by: byOrder ? 'order' : 'call_id' };
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
  /** True when the instance's work-dir rewrite changed this response. */
  rewritten?: boolean;
  /** Recorded->replay exec-session ids rewritten in this response (Codex `write_stdin`). */
  execSessionIds?: Record<string, string>;
  /** Exec-session ids this response names that the replay never reported (served unchanged). */
  execSessionUnmapped?: string[];
  /** How the named ids were paired: through the recorded call_id (exact) or by order. */
  execSessionPairing?: 'call_id' | 'order';
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
  /** Serve this instance its recording with `rw.from` (the recorded work dir) rewritten to `rw.to`. */
  rewritePaths(sessionId: string, instance: string, rw: PathRewrite): void;
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
  const rewrites = new Map<string, PathRewrite>();
  // Exchanges already found not to mention a given `from`: every later instance skips the parse.
  const untouched = new WeakMap<RecordedExchange, string>();
  const served = (ex: RecordedExchange, rw: PathRewrite | undefined): RecordedExchange => {
    if (!rw || untouched.get(ex) === rw.from) return ex;
    const out = rewriteExchange(ex, rw);
    if (out === ex) untouched.set(ex, rw.from);
    return out;
  };
  const execIds = new Map<string, ExecSessionIds>();
  const execCalls = new WeakMap<readonly RecordedExchange[], Map<string, string> | null>();
  const execCallsOf = (exchanges: readonly RecordedExchange[]): Map<string, string> | null => {
    if (!execCalls.has(exchanges)) execCalls.set(exchanges, recordedExecCalls(exchanges));
    return execCalls.get(exchanges) ?? null;
  };
  const named = new WeakMap<RecordedExchange, string[]>();
  const namedIn = (ex: RecordedExchange): string[] => {
    let hit = named.get(ex);
    if (!hit) named.set(ex, (hit = namedExecSessionIds(ex)));
    return hit;
  };

  const recording =(sessionId: string): RecordedExchange[] | null => {
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
        // The fingerprint parses the body once and lifts the CLI's exec-session reports (with
        // the call_id each answered) out of an OpenAI Responses request.
        const fp = fingerprintRequest(body);
        if (fp.execSessions && fp.execSessions.length > 0) {
          const ids = execIds.get(key) ?? { recorded: [], replay: [] };
          execIds.set(key, ids);
          learnReplayIds(ids, fp.execSessions);
        }
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
        const { tier } = picked;
        let ex = served(picked.exchange, rewrites.get(key));
        const rewritten = ex !== picked.exchange;
        let sessions: Pick<ServedRecord, 'execSessionIds' | 'execSessionUnmapped' | 'execSessionPairing'> = {};
        const names = namedIn(picked.exchange);
        if (names.length > 0) {
          const ids = execIds.get(key) ?? { recorded: [], replay: [] };
          execIds.set(key, ids);
          const { map, unmapped, by } = pairFor(ids, names, execCallsOf(exchanges));
          if (map.size > 0) ex = rewriteExchange(ex, execSessionRewriter(map));
          sessions = {
            ...(map.size > 0 ? { execSessionIds: Object.fromEntries(map) } : {}),
            ...(unmapped.length > 0 ? { execSessionUnmapped: unmapped } : {}),
            execSessionPairing: by,
          };
        }
        void (async () => {
          let aborted = false;
          res.on('close', () => {
            if (!res.writableFinished) aborted = true;
          });
          const first = ex.chunks[0];
          if (first) await sleep(delayOf(first.t));
          if (aborted) return write({ tier, seq: ex.seq, status: 499, recordedReqBytes: ex.req.bytes, recordedMessages: ex.req.messages, recordedMs: ex.totalMs, rewritten, ...sessions });
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
          write({ tier, seq: ex.seq, status: aborted ? 499 : ex.status, recordedReqBytes: ex.req.bytes, recordedMessages: ex.req.messages, recordedMs: ex.totalMs, rewritten, ...sessions });
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
    rewritePaths: (sessionId, instance, rw) => void rewrites.set(`${sessionId}/${instance}`, rw),
    states:() => [...states.values()],
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
