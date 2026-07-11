/**
 * Shared local embedding sidecar — HTTP server (P-002, plan
 * shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * ONE warm model per host instead of one per process: every operator process
 * that embeds locally (memories, backfill, agent-tools search) pays its own
 * model warm-load + worker thread today; this sidecar owns the warm pipeline
 * once and serves loopback HTTP per the plan's D-004 wire:
 *
 *   POST /embed   { model?, kind: 'query'|'document', texts: string[] }
 *              →  { vectors: number[][], dims, runtime, modelRev }
 *   GET  /healthz →  { ok, pid, uptimeMs, models: { '<model>:<kind>': state } }
 *
 * The SERVER owns the space-defining knobs (D-002): task prompts, MRL
 * truncation and ORT thread caps all live in the wrapped @papercusp/memory
 * builders (`buildGemmaEmbedder` / `buildLocalEmbedder`, WI-3792 caps included),
 * so sidecar vectors are BIT-IDENTICAL to in-process vectors — same model,
 * same runtime, same quantization ⇒ same embedding space, no re-embed on
 * adoption. Callers pass `kind`, never prompt text.
 *
 * Plain `node:http`, NOT hono: operator-core deliberately does not own hono
 * (endpoint-route: "the host owns Hono ... the package must not"), and the
 * spawner/substrate sidecar servers set the node-primitives precedent. Two
 * fixed routes don't need a router.
 *
 * It lives in operator-core (NOT the bin) so the SAME code starts two ways
 * without the esbuild trap an auto-running bin guard would spring (see
 * spawner-sidecar-server.ts):
 *   - DEV     : apps/operator/bin/embed-sidecar.ts (run via tsx) calls it.
 *   - PACKAGED: serve.ts / hono-host.ts divert under PAPERCUSP_EMBED_SIDECAR_MODE=1.
 *
 * No top-level side effects: importing this module never starts a server;
 * only runEmbedSidecarServer() does. Reached ONLY on hosts that opt in via
 * PAPERCUSP_EMBED_SIDECAR=1 (embed-sidecar-spawn.ts) or that run the bin
 * directly. Binds 127.0.0.1 ONLY — vectors of private text cross this wire.
 *
 * Availability contract (v2, WI-4021 — D-003 retired): hosts with a configured
 * sidecar REQUIRE it. The @papercusp/memory client seam (sidecar-embedder.ts)
 * retries briefly and then throws when this server is down — no in-process
 * failover. That makes THIS process's supervision the availability story:
 * run it under the papercup-embed-sidecar systemd unit (Restart=always,
 * resource limits, boot-warm via EMBED_SIDECAR_WARM_ENV), never ad-hoc.
 * Memory writes during an outage park in the write-ahead journal and
 * auto-recover (memory-write-journal-auto-recovery-2026-07-11).
 */
import * as http from 'node:http';
import {
  buildGemmaEmbedder,
  buildHarrierEmbedder,
  buildLocalEmbedder,
  GEMMA_MODEL,
  HARRIER_MODEL,
  LOCAL_EMBEDDER_MODEL,
  type GemmaEmbedKind,
} from '@papercusp/memory';

export const EMBED_SIDECAR_DEFAULT_PORT = 3384; // mnemonic: the 384-dim space it serves
export const EMBED_SIDECAR_PORT_ENV = 'PAPERCUSP_EMBED_SIDECAR_PORT';
/** Comma-separated models to warm at boot (e.g. "gemma,harrier"); default gemma.
 *  A host whose live embedder mode is harrier should warm it here too — under
 *  Restart=always supervision every restart otherwise lazy-loads the model on
 *  the first real request, which is what turns a clean restart into a visible
 *  first-embed timeout (WI-4021). */
export const EMBED_SIDECAR_WARM_ENV = 'PAPERCUSP_EMBED_SIDECAR_WARM';
/** Printed to stdout once listening — the spawn-side handshake line. */
export const EMBED_SIDECAR_READY_LINE = 'PAPERCUSP_EMBED_SIDECAR_READY';

/** Batch/size guards: a runaway caller must not OOM the shared sidecar. */
export const MAX_TEXTS_PER_CALL = 256;
export const MAX_TEXT_CHARS = 32_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

type EmbedFn = (text: string) => Promise<number[]>;

/** Models this sidecar serves. 'gemma' and 'harrier' are asymmetric (kind
 *  selects the task prompt — harrier prefixes queries only, docs are raw);
 *  'local' (BGE-small) is symmetric — kind is accepted and ignored. */
export const EMBED_SIDECAR_MODELS = ['gemma', 'local', 'harrier'] as const;
export type EmbedSidecarModel = (typeof EMBED_SIDECAR_MODELS)[number];

export interface EmbedRequest {
  model: EmbedSidecarModel;
  kind: GemmaEmbedKind;
  texts: string[];
}

export interface EmbedResponse {
  vectors: number[][];
  dims: number;
  runtime: string;
  modelRev: string;
}

/** transformers.js ONNX in a worker thread — the space-defining runtime tag. */
export const EMBED_SIDECAR_RUNTIME = 'node-onnx-worker';

const MODEL_REVS: Record<EmbedSidecarModel, string> = {
  gemma: GEMMA_MODEL,
  local: LOCAL_EMBEDDER_MODEL,
  harrier: HARRIER_MODEL,
};

/**
 * Pure request validation (unit-tested without a server). Returns the parsed
 * request or an error string suitable for a 400 body.
 */
export function validateEmbedRequest(body: unknown): EmbedRequest | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as { model?: unknown; kind?: unknown; texts?: unknown };
  const model = b.model === undefined ? 'gemma' : b.model;
  if (!EMBED_SIDECAR_MODELS.includes(model as EmbedSidecarModel)) {
    return { error: `unknown model '${String(model)}' — expected one of: ${EMBED_SIDECAR_MODELS.join(', ')}` };
  }
  if (b.kind !== 'query' && b.kind !== 'document') {
    return { error: `kind must be 'query' or 'document' (got '${String(b.kind)}')` };
  }
  if (!Array.isArray(b.texts) || b.texts.length === 0) {
    return { error: 'texts must be a non-empty array of strings' };
  }
  if (b.texts.length > MAX_TEXTS_PER_CALL) {
    return { error: `texts exceeds the ${MAX_TEXTS_PER_CALL}-per-call cap (got ${b.texts.length}) — split the batch` };
  }
  for (let i = 0; i < b.texts.length; i++) {
    const t = b.texts[i];
    if (typeof t !== 'string') return { error: `texts[${i}] is not a string` };
    if (t.length > MAX_TEXT_CHARS) {
      return { error: `texts[${i}] exceeds ${MAX_TEXT_CHARS} chars (got ${t.length}) — truncate before embedding` };
    }
  }
  return { model: model as EmbedSidecarModel, kind: b.kind, texts: b.texts as string[] };
}

type WarmState = 'cold' | 'warming' | 'warm' | 'failed';

/** The boot-warm model set: EMBED_SIDECAR_WARM_ENV comma-list filtered to known
 *  models (unknown names dropped), deduped; empty/unset ⇒ ['gemma']. Pure. */
export function resolveWarmModels(env: NodeJS.ProcessEnv = process.env): EmbedSidecarModel[] {
  const raw = env[EMBED_SIDECAR_WARM_ENV];
  if (!raw?.trim()) return ['gemma'];
  const known = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is EmbedSidecarModel => (EMBED_SIDECAR_MODELS as readonly string[]).includes(s));
  return known.length > 0 ? [...new Set(known)] : ['gemma'];
}

/** Builder seam — tests inject fakes so no unit test loads a real ONNX model. */
export type EmbedderBuilders = {
  [M in EmbedSidecarModel]: (kind: GemmaEmbedKind) => Promise<EmbedFn>;
};

const defaultBuilders: EmbedderBuilders = {
  gemma: (kind) => Promise.resolve(buildGemmaEmbedder({ kind })),
  // BGE is symmetric: one embedder serves both kinds (buildLocalEmbedder has
  // no kind knob), so both registry slots resolve to the same closure.
  local: () => buildLocalEmbedder(),
  // harrier-oss-0.6b @ native-1024 (P-014): pooling+normalize live in the
  // ONNX graph itself; kind picks the instruct-vs-raw prompt.
  harrier: (kind) => Promise.resolve(buildHarrierEmbedder({ kind })),
};

export interface EmbedSidecarOptions {
  port?: number;
  builders?: EmbedderBuilders;
  /** Skip the boot warm-up (tests). Production warms gemma at boot. */
  warmAtBoot?: boolean;
  log?: (line: string) => void;
}

export interface EmbedSidecarHandle {
  server: http.Server;
  /** Resolves once listening (port bound). */
  listening: Promise<number>;
  close: () => Promise<void>;
  /** Per-`model:kind` warm state — surfaced verbatim by /healthz. */
  warmStates: () => Record<string, WarmState>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Create (but do not process-wire) the sidecar server. `runEmbedSidecarServer`
 * adds signal handling + the READY handshake on top; tests drive this directly
 * on an ephemeral port with injected builders.
 */
export function createEmbedSidecarServer(opts: EmbedSidecarOptions = {}): EmbedSidecarHandle {
  const builders = opts.builders ?? defaultBuilders;
  const log = opts.log ?? ((line: string) => console.log(line));
  const port = opts.port ?? Number(process.env[EMBED_SIDECAR_PORT_ENV] ?? EMBED_SIDECAR_DEFAULT_PORT);
  const startedAt = Date.now();

  // One embedder per model:kind, built lazily and memoized. A failed build is
  // NOT memoized — the next request retries (a transient (dl/disk) fault must
  // not brick the slot for the process lifetime).
  const embedders = new Map<string, Promise<EmbedFn>>();
  const warm: Record<string, WarmState> = {};
  const getEmbedder = (model: EmbedSidecarModel, kind: GemmaEmbedKind): Promise<EmbedFn> => {
    const key = `${model}:${kind}`;
    let p = embedders.get(key);
    if (!p) {
      warm[key] = 'warming';
      p = builders[model](kind).then(
        (fn) => {
          warm[key] = 'warm';
          return fn;
        },
        (err) => {
          warm[key] = 'failed';
          embedders.delete(key);
          throw err;
        },
      );
      embedders.set(key, p);
    }
    return p;
  };

  // Single-flight FIFO: concurrent HTTP requests are serialized through one
  // chain so a burst can't interleave-flood the (one-at-a-time anyway) ONNX
  // worker — fair ordering, bounded memory, no starvation of small requests
  // stuck behind their own giant batch peers. Rejections are swallowed on the
  // chain (each caller gets its own rejection via `run`'s returned promise).
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => undefined);
    return run;
  };

  const handleEmbed = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (e) {
      json(res, 400, { error: `invalid JSON body: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const v = validateEmbedRequest(parsed);
    if ('error' in v) {
      json(res, 400, { error: v.error });
      return;
    }
    try {
      const vectors = await enqueue(async () => {
        const embed = await getEmbedder(v.model, v.kind);
        const out: number[][] = [];
        for (const text of v.texts) out.push(await embed(text));
        return out;
      });
      const body: EmbedResponse = {
        vectors,
        dims: vectors[0]?.length ?? 0,
        runtime: EMBED_SIDECAR_RUNTIME,
        modelRev: MODEL_REVS[v.model],
      };
      json(res, 200, body);
    } catch (e) {
      json(res, 500, { error: `embed_failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && url === '/healthz') {
      json(res, 200, {
        ok: true,
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        runtime: EMBED_SIDECAR_RUNTIME,
        models: { ...warm },
      });
      return;
    }
    if (req.method === 'POST' && url === '/embed') {
      void handleEmbed(req, res);
      return;
    }
    json(res, 404, { error: `no route ${req.method} ${url}` });
  });

  const listening = new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 ONLY — never 0.0.0.0; embedded text crosses this wire.
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    });
  });

  if (opts.warmAtBoot !== false) {
    // Warm the configured models (EMBED_SIDECAR_WARM_ENV, default gemma) in the
    // background AFTER listen is queued: the READY handshake must not wait out
    // a model load (can be 10s+ cold), and a request that races the warm-up
    // simply awaits the same promise.
    void listening.then(() => {
      for (const model of resolveWarmModels()) {
        for (const kind of ['document', 'query'] as const) {
          getEmbedder(model, kind)
            .then((embed) => embed('warm-up'))
            .then(() => log(`[embed-sidecar] ${model}:${kind} warm`))
            .catch((e) => log(`[embed-sidecar] ${model}:${kind} warm-up failed: ${e instanceof Error ? e.message : e}`));
        }
      }
    });
  }

  return {
    server,
    listening,
    warmStates: () => ({ ...warm }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Start the sidecar and own the process lifecycle (SIGTERM/SIGINT → close).
 * Prints the PAPERCUSP_EMBED_SIDECAR_READY handshake once listening so the
 * parent spawnEmbedSidecar() handshake completes.
 */
export function runEmbedSidecarServer(): void {
  const handle = createEmbedSidecarServer();
  handle.listening.then(
    (port) => {
      console.log(`[embed-sidecar] listening on http://127.0.0.1:${port}`);
      console.log(`${EMBED_SIDECAR_READY_LINE} port=${port}`);
    },
    (err) => {
      console.error('[embed-sidecar] failed to listen:', err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
  const shutdown = (signal: string): void => {
    console.log(`[embed-sidecar] ${signal} received, shutting down gracefully`);
    void handle.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
