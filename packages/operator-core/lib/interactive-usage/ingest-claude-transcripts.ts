/**
 * Interactive-session usage ingester (token-usage-reduction-audit-2026-06-09 P-001).
 *
 * The 2026-06-09 audit found interactive Claude Code / psu sessions are the DOMINANT
 * token consumer (~235 MTok cache-read + ~170 MTok cache-write per week on this box)
 * yet wrote NO telemetry — `agent_usage_samples` only saw orchestrator spawns +
 * stateless anthropic-direct calls. This module tails the local Claude Code transcripts
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
import path from 'node:path';
import { costFromTokens } from '@papercusp/model-pricing';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { TranscriptAdapter } from './ingest-adapters';

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
  if (/gpt|codex|^o\d/.test(m)) return 'gpt';
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
  /** Claude transcript root override. Default `~/.claude/projects`. (When
   *  `adapters` is supplied this is ignored — pass roots on the adapters.) */
  root?: string;
  /** Per-tick file cap (safety bound; the rest catch up next tick). Default 5000.
   *  Applies per adapter root. */
  maxFilesPerTick?: number;
  /** Per-file read cap per tick (memory bound). Default 32 MiB. */
  maxBytesPerFile?: number;
  /** Adapter set to ingest (P-015). Default: claude + codex + OMP
   *  (`defaultAdapters()` from ingest-adapters.ts). */
  adapters?: TranscriptAdapter[];
  /** Also sweep each per-session Claude isolation root
   *  (`~/.papercusp/session-claude/<owner>/projects`) in addition to the
   *  global `~/.claude/projects` claude adapter. Default true; only applies
   *  on the true default path (`adapters` not supplied — a caller passing
   *  its own `adapters` array, e.g. every existing test, opts out by
   *  construction). Set false to restrict to the single global root. */
  includeIsolationRoots?: boolean;
  /** Isolation base override for the isolation-root sweep — the parent dir
   *  holding one subdir per owner (default `~/.papercusp/session-claude`,
   *  same default as `claudeProjectsRoots()`). Test seam only. */
  isolationBase?: string;
  /** Codex isolation base override for the per-session `CODEX_HOME` sweep —
   *  the parent dir holding one `session-<advId>/` home per psu-launched codex
   *  session (default `~/.papercusp/su-codex-homes`, same default as
   *  `codexSessionRoots()`). Swept under the same `includeIsolationRoots`
   *  switch as the Claude isolation roots. Test seam only. */
  codexIsolationBase?: string;
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
 * One ingest tick: walk every adapter's transcript root (P-015: claude +
 * codex + OMP by default), read each file's delta past its watermark, and
 * persist one `source='interactive'` usage sample per (file-delta × model).
 * Safe to re-run (the system-actions contract). All adapters share the one
 * watermark table — file paths are absolute, so roots can't collide.
 *
 * EI-19964643447670242: `defaultAdapters()`'s claude entry only ever swept the
 * GLOBAL `~/.claude/projects` root. Every psu-launched agent (su fleet
 * members, queen/overwatch/bee, and every other psu console role) runs under
 * an ISOLATED per-owner `CLAUDE_CONFIG_DIR` and writes its transcript to
 * `~/.papercusp/session-claude/<ownerId>/projects/**` instead — a root this
 * ingester never scanned, so the ENTIRE fleet's interactive usage was
 * structurally invisible to `agent_usage_samples`: not merely "not yet
 * ingested" but never ingested at all. Two real consumers silently no-op'd on
 * this: `loop-cost-cap.ts`'s `readLoopSpendCents` (owner → adv_sessions.
 * session_id → agent_usage_samples.session_id → SUM(cost_usd)) always found 0
 * for a warm psu/loop session and the cost-cap guardrail never bound, and any
 * attempt to read a psu session's own spend via that same join came back
 * empty. Sweeping the isolation roots too (below, default on) closes the gap
 * with NO schema change — the existing session_id-keyed join already works
 * once the source rows exist. (A residual, DISTINCT bug remains for a
 * cold-loop-respawned session whose `adv_sessions.session_id` was never
 * re-anchored to its live successor transcript — filed separately.)
 */
export async function ingestInteractiveUsage(opts: IngestOptions = {}): Promise<IngestResult> {
  const maxFiles = opts.maxFilesPerTick ?? DEFAULT_MAX_FILES;
  const capBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();

  // Lazy import avoids a require cycle (ingest-adapters imports this module's
  // parseTranscriptChunk for the claude adapter).
  const { defaultAdapters, providerForModel } = await import('./ingest-adapters');
  let adapters = opts.adapters ?? defaultAdapters();
  if (opts.root) {
    // Back-compat: a `root` override re-points the claude adapter (the
    // routine's `trigger_config.root` knob predates the adapter set).
    adapters = adapters.map((a) => (a.name === 'claude' ? { ...a, root: opts.root! } : a));
  }
  // Default ON only when the caller took the true default path (no `adapters`
  // supplied) — every existing test passes its own `adapters` array and so
  // opts out by construction, with zero risk of sweeping the real $HOME
  // isolation tree into a test's temp DB. `includeIsolationRoots: true`
  // explicitly overrides that opt-out (paired with `isolationBase` below) so
  // the sweep itself stays test-injectable rather than reachable only via the
  // real machine's `~/.papercusp/session-claude`.
  const wantIsolationRoots = opts.includeIsolationRoots ?? !opts.adapters;
  if (wantIsolationRoots) {
    // Distinct adapter names so the `root` back-compat remap above (which
    // matches name==='claude' only) can't collide two adapters onto the same
    // directory and double-ingest a tick.
    const { claudeProjectsRoots, defaultClaudeProjectsRoot } = await import('../claude-sessions');
    const { codexSessionRoots, parseCodexChunk, codexSessionIdForFile, advSessionIdFromCodexHome } =
      await import('./ingest-adapters');
    const globalRoot = defaultClaudeProjectsRoot();
    const isoRoots = (await claudeProjectsRoots(globalRoot, opts.isolationBase)).filter((r) => r !== globalRoot);
    // WI-2140701 (a): psu-launched codex sessions run under a per-session
    // CODEX_HOME (`~/.papercusp/su-codex-homes/session-<advId>/`) and write
    // their rollouts under `<home>/sessions/**` — EI-19964643447670242's
    // isolation-root blindness on the codex lane. The default `codex` adapter
    // only ever swept the global `~/.codex/sessions`, so every psu codex agent
    // (the codex everything-goal holder included) had ZERO usage samples and
    // its goal's spend rollup could not see the holder's own cost.
    // EI-22389989368696048: isolation must be SYMMETRIC. `codexSessionRoots()` defaults to
    // the machine's REAL per-session codex homes, so a caller that pinned `isolationBase`
    // (the documented test seam) but not `codexIsolationBase` silently swept that entire
    // corpus — 149 homes / 4,329 rollouts / 28GB on this box — into its own DB, hanging the
    // call and contaminating a test database with live agent transcripts. That broke the
    // "zero risk of sweeping the real $HOME isolation tree into a test's temp DB" guarantee
    // promised above, on the codex half only. Pinning EITHER seam now means "injected tree";
    // the real base is reached only when NEITHER is pinned, so production is unchanged.
    const codexIsoRoots =
      opts.codexIsolationBase === undefined && opts.isolationBase !== undefined
        ? []
        : await codexSessionRoots(opts.codexIsolationBase);
    adapters = [
      ...adapters,
      // WI-2144763: an isolation root is `<base>/<coord-owner-id>/projects`, so the
      // owner is the parent directory name — carry it so the INSERT can stamp
      // harness_slug without a join. Derived from `root` (not the transcript path)
      // because claudeProjectsRoots built that root from the owner dir itself.
      ...isoRoots.map((root, i) => ({
        name: `claude-iso-${i}`,
        root,
        parse: parseTranscriptChunk,
        ownerId: path.basename(path.dirname(root)),
      })),
      // WI-2144763 (migration 1120): a per-session CODEX_HOME is
      // `<base>/session-<advId>/sessions`, so the parent directory name carries
      // `adv_sessions.id` — the PRIMARY KEY — and the INSERT can stamp
      // harness_slug from it with no join, exactly as the claude isolation roots
      // do with their owner id. Without this every psu-launched codex session
      // fell through to the session route, which cannot find them: their sample
      // `session_id` is the rollout uuid, and only 10 of 63 measured unstamped
      // sessions were present in adv_sessions under it. codex-iso was ~92% of
      // the whole post-1119 attribution gap.
      ...codexIsoRoots.map((root, i) => ({
        name: `codex-iso-${i}`,
        root,
        parse: parseCodexChunk,
        sessionIdForFile: codexSessionIdForFile,
        advSessionId: advSessionIdFromCodexHome(root),
      })),
    ];
  }

  const result: IngestResult = {
    root: adapters.map((a) => a.root).join(', '),
    scannedFiles: 0,
    ingestedFiles: 0,
    samples: 0,
    skippedUnchanged: 0,
    totals: emptyDelta(),
    errors: [],
  };

  const wmRows = await sql<Array<{ file_path: string; byte_offset: string }>>`
    SELECT file_path, byte_offset FROM harness_shared.interactive_usage_files
     WHERE workspace_id = ${ws}
  `;
  const watermarks = new Map(wmRows.map((r) => [r.file_path, Number(r.byte_offset)]));

  for (const adapter of adapters) {
    let entries: Array<{ parentPath?: string; path?: string; name: string; isFile(): boolean }>;
    try {
      entries = (await fs.readdir(adapter.root, { withFileTypes: true, recursive: true })) as never;
    } catch {
      continue; // no transcript root for this backend on this machine
    }
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => path.join((e.parentPath ?? e.path ?? adapter.root) as string, e.name))
      .slice(0, maxFiles);

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
        const { perModel, consumedBytes } = adapter.parse(chunk);
        if (consumedBytes === 0) continue; // no complete line yet — retry next tick
        // The value every spend join keys on (= adv_sessions.session_id); codex
        // rollouts need the adapter's extractor, see TranscriptAdapter.sessionIdForFile.
        const sessionId = adapter.sessionIdForFile ? adapter.sessionIdForFile(file) : path.basename(file, '.jsonl');

        await sql.begin(async (tx) => {
          for (const [model, d] of perModel) {
            if (d.turns === 0) continue;
            const modelClass = modelClassForModel(model);
            const provider = providerForModel(model);
            const est = costFromTokens(model, d);
            // Both attribution stamps below take the CODEX_HOME-derived adv_sessions PK
            // as their strongest key. harness_slug: migration 1120 (WI-2144763).
            // goal_id: migration 1121 (WI-2145149) — the 3-arg overload, same defect,
            // because both routes of the 2-arg form join adv_sessions on session_id,
            // which a psu codex row (whose sample carries the rollout uuid there) can
            // never match. The goal ceiling is small and deliberately honest: 0 -> 3 of
            // 134 codex sessions, which is 100% of the achievable set. The other 131
            // owners have no goal recorded at all — workspace-wide only 1.55% of
            // adv_sessions resolve a goal by ANY route — so a NULL goal_id here is
            // absent goal data, NOT a resolver failure (EI-22391659152296045).
            await tx`
              INSERT INTO harness_shared.agent_usage_samples
                (workspace_id, ts, bucket_key, provider, model_class, source,
                 input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
                 model, cost_source, harness_slug, run_id, role, session_id, goal_id)
              VALUES (
                ${ws}, ${Date.now()}, ${`${provider}:${modelClass}`}, ${provider}, ${modelClass}, ${'interactive'},
                ${d.inputTokens}, ${d.outputTokens}, ${d.cacheReadTokens}, ${d.cacheCreationTokens},
                ${est.priced ? est.usd : null}, ${model}, ${est.priced ? 'estimated' : null},
                (SELECT harness_shared.harness_slug_for_usage_attribution(
                   ${ws}, ${adapter.ownerId ?? null}, ${sessionId}, ${adapter.advSessionId ?? null})),
                ${sessionId}, ${'interactive'}, ${sessionId},
                (SELECT harness_shared.goal_id_for_usage_session(
                   ${ws}, ${sessionId}, ${adapter.advSessionId ?? null}))
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
  }
  return result;
}
