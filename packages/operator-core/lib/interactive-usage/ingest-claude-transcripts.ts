/**
 * Interactive-session usage ingester (token-usage-reduction-audit-2026-06-09 P-001).
 *
 * The 2026-06-09 audit found interactive Claude Code / psu sessions are the DOMINANT
 * token consumer (~235 MTok cache-read + ~170 MTok cache-write per week on this box)
 * yet wrote NO telemetry — `agent_usage_samples` only saw orchestrator spawns +
 * meridian calls. This module tails the local Claude Code transcripts
 * (`~/.claude/projects`, recursive `*.jsonl`), sums each file's assistant-message `usage`
 * deltas, and persists one sample per (file-delta × model) with
 * `source='interactive'`, so the spend rollups and the weekly token report see the
 * whole picture.
 *
 * Idempotency: a per-file BYTE WATERMARK (`harness_shared.interactive_usage_files`,
 * migration 210) marks the end of the last fully-parsed JSONL line; each tick reads
 * only the delta. Sample INSERT + watermark advance run in one transaction, so a
 * failed insert is retried next tick rather than silently dropped. A file smaller
 * than its watermark (recreated transcript) re-ingests from 0 — transcripts are
 * append-only, so that is the only rotation case.
 *
 * Subscription honesty: interactive sessions bill to the seat, not per-token. The
 * estimated $ (cost_source='estimated', list price) quantifies RATE-LIMIT-HEADROOM
 * consumption — the budget the fleet competes with — not real dollars.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costFromTokens } from '@papercusp/model-pricing';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

export interface TranscriptDelta {
  /** Assistant turns (API calls) parsed in this delta. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ParsedChunk {
  /** Per-model accumulated usage for every fully-parsed line. */
  perModel: Map<string, TranscriptDelta>;
  /** Byte length of the consumed prefix (complete lines only) — the watermark advance. */
  consumedBytes: number;
}

const emptyDelta = (): TranscriptDelta => ({
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

/** Model string → bucket class (mirrors usage-sample-pg's modelClassForRun for anthropic). */
export function modelClassForModel(model: string): string {
  const m = model.toLowerCase();
  if (/opus/.test(m)) return 'opus';
  if (/sonnet/.test(m)) return 'sonnet';
  if (/haiku/.test(m)) return 'haiku';
  return 'default';
}

interface UsageLine {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Parse a transcript chunk (raw bytes read from the watermark onward, utf8-decoded).
 * Only COMPLETE lines (newline-terminated, or the final line of a chunk that ends at
 * EOF mid-write is left for the next tick) are consumed; `consumedBytes` is what the
 * watermark advances by. Unparseable lines are consumed but contribute nothing.
 *
 * Dedupe: a single API call (one `message.id`) is written as MULTIPLE assistant lines
 * (one per content block), each repeating the message's `usage` — counting every line
 * inflates ~1.3×. One message = one turn: usage is max-merged per `message.id` within
 * the chunk (max also absorbs a streaming usage that grows across the lines). An
 * id-less line counts individually. A message split across two chunk reads (watermark
 * landing mid-message) double-counts once — rare enough to accept.
 */
export function parseTranscriptChunk(chunk: string): ParsedChunk {
  const perModel = new Map<string, TranscriptDelta>();
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline === -1) return { perModel, consumedBytes: 0 };
  const consumed = chunk.slice(0, lastNewline + 1);
  // msgId → { model, max-merged usage } for this chunk; id-less lines flushed directly.
  const byMsg = new Map<string, { model: string; u: Required<UsageLine> }>();
  let anonSeq = 0;
  for (const line of consumed.split('\n')) {
    if (!line.trim()) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue; // torn/garbage line — consumed, contributes nothing
    }
    const evt = j as { type?: string; message?: { id?: string; model?: string; usage?: UsageLine } };
    if (evt?.type !== 'assistant') continue;
    const model = evt.message?.model;
    const u = evt.message?.usage;
    // `<synthetic>` rows are harness-injected error placeholders, not API calls.
    if (!model || model.startsWith('<') || !u) continue;
    const key = evt.message?.id ?? `anon-${anonSeq++}`;
    const acc = byMsg.get(key) ?? { model, u: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    acc.u.input_tokens = Math.max(acc.u.input_tokens, u.input_tokens ?? 0);
    acc.u.output_tokens = Math.max(acc.u.output_tokens, u.output_tokens ?? 0);
    acc.u.cache_read_input_tokens = Math.max(acc.u.cache_read_input_tokens, u.cache_read_input_tokens ?? 0);
    acc.u.cache_creation_input_tokens = Math.max(acc.u.cache_creation_input_tokens, u.cache_creation_input_tokens ?? 0);
    byMsg.set(key, acc);
  }
  for (const { model, u } of byMsg.values()) {
    const acc = perModel.get(model) ?? emptyDelta();
    acc.turns += 1;
    acc.inputTokens += u.input_tokens;
    acc.outputTokens += u.output_tokens;
    acc.cacheReadTokens += u.cache_read_input_tokens;
    acc.cacheCreationTokens += u.cache_creation_input_tokens;
    perModel.set(model, acc);
  }
  return { perModel, consumedBytes: Buffer.byteLength(consumed, 'utf8') };
}

/** Read `[offset, min(size, offset+cap))` of a file as a utf8 string. */
export async function readFileDelta(filePath: string, offset: number, capBytes: number): Promise<string> {
  const fh = await fs.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(Math.max(0, size - offset), capBytes);
    if (len === 0) return '';
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

export interface IngestOptions {
  /** Transcript root. Default `~/.claude/projects`. */
  root?: string;
  /** Per-tick file cap (safety bound; the rest catch up next tick). Default 5000. */
  maxFilesPerTick?: number;
  /** Per-file read cap per tick (memory bound). Default 32 MiB. */
  maxBytesPerFile?: number;
}

export interface IngestResult {
  root: string;
  scannedFiles: number;
  ingestedFiles: number;
  samples: number;
  skippedUnchanged: number;
  totals: TranscriptDelta;
  errors: Array<{ file: string; error: string }>;
}

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_BYTES_PER_FILE = 32 * 1024 * 1024;

/**
 * One ingest tick: walk the transcript root, read each file's delta past its
 * watermark, and persist one `source='interactive'` usage sample per
 * (file-delta × model). Safe to re-run (the system-actions contract).
 */
export async function ingestInteractiveUsage(opts: IngestOptions = {}): Promise<IngestResult> {
  const root = opts.root ?? path.join(os.homedir(), '.claude', 'projects');
  const maxFiles = opts.maxFilesPerTick ?? DEFAULT_MAX_FILES;
  const capBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();

  const result: IngestResult = {
    root,
    scannedFiles: 0,
    ingestedFiles: 0,
    samples: 0,
    skippedUnchanged: 0,
    totals: emptyDelta(),
    errors: [],
  };

  let entries: Array<{ parentPath?: string; path?: string; name: string; isFile(): boolean }>;
  try {
    entries = (await fs.readdir(root, { withFileTypes: true, recursive: true })) as never;
  } catch {
    return result; // no transcript root on this machine — nothing to ingest
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join((e.parentPath ?? e.path ?? root) as string, e.name))
    .slice(0, maxFiles);

  const wmRows = await sql<Array<{ file_path: string; byte_offset: string }>>`
    SELECT file_path, byte_offset FROM harness_shared.interactive_usage_files
     WHERE workspace_id = ${ws}
  `;
  const watermarks = new Map(wmRows.map((r) => [r.file_path, Number(r.byte_offset)]));

  for (const file of files) {
    result.scannedFiles += 1;
    try {
      const { size } = await fs.stat(file);
      let offset = watermarks.get(file) ?? 0;
      if (size < offset) offset = 0; // recreated transcript — re-ingest from the top
      if (size === offset) {
        result.skippedUnchanged += 1;
        continue;
      }
      const chunk = await readFileDelta(file, offset, capBytes);
      const { perModel, consumedBytes } = parseTranscriptChunk(chunk);
      if (consumedBytes === 0) continue; // no complete line yet — retry next tick
      const sessionId = path.basename(file, '.jsonl');

      await sql.begin(async (tx) => {
        for (const [model, d] of perModel) {
          if (d.turns === 0) continue;
          const modelClass = modelClassForModel(model);
          const est = costFromTokens(model, d);
          await tx`
            INSERT INTO harness_shared.agent_usage_samples
              (workspace_id, ts, bucket_key, provider, model_class, source,
               input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
               model, cost_source, run_id, role)
            VALUES (
              ${ws}, ${Date.now()}, ${`anthropic:${modelClass}`}, ${'anthropic'}, ${modelClass}, ${'interactive'},
              ${d.inputTokens}, ${d.outputTokens}, ${d.cacheReadTokens}, ${d.cacheCreationTokens},
              ${est.priced ? est.usd : null}, ${model}, ${est.priced ? 'estimated' : null},
              ${sessionId}, ${'interactive'}
            )
          `;
          result.samples += 1;
          result.totals.turns += d.turns;
          result.totals.inputTokens += d.inputTokens;
          result.totals.outputTokens += d.outputTokens;
          result.totals.cacheReadTokens += d.cacheReadTokens;
          result.totals.cacheCreationTokens += d.cacheCreationTokens;
        }
        await tx`
          INSERT INTO harness_shared.interactive_usage_files (workspace_id, file_path, byte_offset, updated_at)
          VALUES (${ws}, ${file}, ${offset + consumedBytes}, now())
          ON CONFLICT (workspace_id, file_path)
          DO UPDATE SET byte_offset = EXCLUDED.byte_offset, updated_at = now()
        `;
      });
      result.ingestedFiles += 1;
    } catch (e) {
      result.errors.push({ file, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
