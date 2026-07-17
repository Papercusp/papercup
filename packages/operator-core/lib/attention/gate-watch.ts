/**
 * gate-watch.ts — the client-agnostic transcript watcher half of the
 * owner-gate tracker (owner-inbox-single-pane-2026-07-17 P-002).
 *
 * Detects a session BLOCKED ON THE OWNER purely from its transcript, with no
 * hook cooperation required: an `AskUserQuestion` / `ExitPlanMode` tool_use
 * with no later `tool_result` in the file = the session is waiting on a human
 * answer. When the matching tool_result eventually lands, the gate closes.
 * This is the fallback that works even for clients with no turn-end hook
 * (Codex today — plan D-002/Background).
 *
 * Same byte-watermark tailing discipline as
 * `interactive-usage/ingest-claude-transcripts.ts` (this module deliberately
 * mirrors its shape): `parseGateChunk` is a pure, unit-testable function over
 * a raw chunk of JSONL; `tickGateWatch` is the stateful outer loop that reads
 * each file's delta past its watermark and persists via gate-store.ts.
 * Watermarks live in their OWN table (`session_gate_watcher_files`, migration
 * 619) rather than sharing `interactive_usage_files` — a different
 * producer/consumer, kept decoupled.
 *
 * "Claude transcripts first" (plan Background) — this tick only walks
 * `~/.claude/projects`; codex/OMP roots are a straightforward follow-on (same
 * shape as `interactive-usage/ingest-adapters.ts`) once each adapter's
 * tool_use/tool_result line shape is confirmed, left for a later plan item.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { readFileDelta } from '../interactive-usage/ingest-claude-transcripts';
import { closeGateByToolUseId, listPendingGates, openOrTouchGate } from './gate-store';

/** Tool names whose unanswered tool_use means "blocked on the owner". */
const GATE_TOOL_NAMES = new Set(['AskUserQuestion', 'ExitPlanMode']);
const QUESTION_MAX_CHARS = 500;

export interface GateOpenEvent {
  toolUseId: string;
  toolName: string;
  question: string;
  options: Array<{ label: string; description?: string }> | null;
}

export interface GateCloseEvent {
  toolUseId: string;
}

export interface ParsedGateChunk {
  opens: GateOpenEvent[];
  closes: GateCloseEvent[];
  consumedBytes: number;
}

interface AskUserQuestionInput {
  questions?: Array<{
    question?: string;
    header?: string;
    options?: Array<{ label?: string; description?: string }>;
  }>;
}

/** Best-effort human-readable question + flattened options for a gate tool_use. */
export function extractGateQuestion(
  toolName: string,
  input: unknown,
): { question: string; options: Array<{ label: string; description?: string }> | null } {
  if (toolName === 'AskUserQuestion') {
    const inp = (input ?? {}) as AskUserQuestionInput;
    const qs = Array.isArray(inp.questions) ? inp.questions : [];
    const question =
      qs
        .map((q) => (typeof q?.question === 'string' ? q.question : ''))
        .filter(Boolean)
        .join(' / ')
        .slice(0, QUESTION_MAX_CHARS) || 'AskUserQuestion';
    const options = qs
      .flatMap((q) => (Array.isArray(q?.options) ? q.options : []))
      .filter((o): o is { label: string; description?: string } => typeof o?.label === 'string')
      .map((o) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : undefined }))
      .slice(0, 20);
    return { question, options: options.length ? options : null };
  }
  // ExitPlanMode (and any future gate-shaped tool): best-effort text only.
  const inp = (input ?? {}) as { plan?: string };
  const plan = typeof inp.plan === 'string' ? inp.plan : '';
  const question = plan
    ? `Exit plan mode — approve this plan?\n\n${plan}`.slice(0, QUESTION_MAX_CHARS)
    : 'Exit plan mode — approve?';
  return { question, options: null };
}

/**
 * Parse one incremental chunk (bytes read from the watermark onward) of a
 * Claude Code transcript. Only complete lines are consumed (the trailing
 * partial line is left for next tick, same discipline as
 * `parseTranscriptChunk`). An ask resolved WITHIN the same chunk (tool_use +
 * its tool_result both land in this delta) cancels out — it was never
 * observably open, so it never surfaces as a gate. A tool_result whose
 * tool_use lives in a PRIOR chunk is reported as a close candidate; the
 * caller intersects that against what's actually open in the store (a
 * tool_result for a non-gate tool is a harmless, ignorable candidate).
 */
export function parseGateChunk(chunk: string): ParsedGateChunk {
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline === -1) return { opens: [], closes: [], consumedBytes: 0 };
  const consumed = chunk.slice(0, lastNewline + 1);
  const stillOpen = new Map<string, GateOpenEvent>();
  const closes: GateCloseEvent[] = [];

  for (const line of consumed.split('\n')) {
    if (!line.trim()) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue; // torn/garbage line — consumed, contributes nothing
    }
    const evt = j as { type?: string; message?: { content?: unknown } };
    const content = evt?.message?.content;
    if (!Array.isArray(content)) continue;

    if (evt.type === 'assistant') {
      for (const part of content) {
        const p = part as { type?: string; id?: string; name?: string; input?: unknown };
        if (p?.type !== 'tool_use' || !p.id || !p.name || !GATE_TOOL_NAMES.has(p.name)) continue;
        const { question, options } = extractGateQuestion(p.name, p.input);
        stillOpen.set(p.id, { toolUseId: p.id, toolName: p.name, question, options });
      }
    } else if (evt.type === 'user') {
      for (const part of content) {
        const p = part as { type?: string; tool_use_id?: string };
        if (p?.type !== 'tool_result' || !p.tool_use_id) continue;
        if (stillOpen.has(p.tool_use_id)) {
          stillOpen.delete(p.tool_use_id); // resolved inside this same window
        } else {
          closes.push({ toolUseId: p.tool_use_id });
        }
      }
    }
  }
  return { opens: [...stillOpen.values()], closes, consumedBytes: Buffer.byteLength(consumed, 'utf8') };
}

export interface GateWatchOptions {
  root?: string;
  maxFilesPerTick?: number;
  maxBytesPerFile?: number;
}

export interface GateWatchResult {
  root: string;
  scannedFiles: number;
  opened: number;
  alreadyOpen: number;
  closed: number;
  errors: Array<{ file: string; error: string }>;
}

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_BYTES_PER_FILE = 32 * 1024 * 1024;

/**
 * One watcher tick: walk the Claude transcript root, read each file's delta
 * past its watermark, and upsert opens/closes into session_pending_gates.
 * Safe to re-run (the system-actions contract) — every file delta is fenced
 * by its own byte watermark.
 */
export async function tickGateWatch(opts: GateWatchOptions = {}): Promise<GateWatchResult> {
  const root = opts.root ?? path.join(os.homedir(), '.claude', 'projects');
  const maxFiles = opts.maxFilesPerTick ?? DEFAULT_MAX_FILES;
  const capBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();

  const result: GateWatchResult = { root, scannedFiles: 0, opened: 0, alreadyOpen: 0, closed: 0, errors: [] };

  let entries: Array<{ parentPath?: string; path?: string; name: string; isFile(): boolean }>;
  try {
    entries = (await fs.readdir(root, { withFileTypes: true, recursive: true })) as never;
  } catch {
    return result; // no Claude transcript root on this box
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join((e.parentPath ?? e.path ?? root) as string, e.name))
    .slice(0, maxFiles);

  const wmRows = await sql<Array<{ file_path: string; byte_offset: string }>>`
    SELECT file_path, byte_offset FROM harness_shared.session_gate_watcher_files WHERE workspace_id = ${ws}
  `;
  const watermarks = new Map(wmRows.map((r) => [r.file_path, Number(r.byte_offset)]));

  // Batch-fetch the currently-open ref ids ONCE per tick so a close candidate
  // for an ordinary (non-gate) tool_result never costs a write — we only ever
  // call closeGateByToolUseId for a ref this tick's opens-so-far confirm.
  const openNow = await listPendingGates({ workspaceId: ws, includeClosed: false, limit: 200 });
  const openRefsBySession = new Map<string, Set<string>>();
  for (const g of openNow) {
    const set = openRefsBySession.get(g.session_id) ?? new Set<string>();
    set.add(g.ref_id);
    openRefsBySession.set(g.session_id, set);
  }

  for (const file of files) {
    result.scannedFiles += 1;
    try {
      const { size } = await fs.stat(file);
      let offset = watermarks.get(file) ?? 0;
      if (size < offset) offset = 0; // recreated transcript — re-ingest from the top
      if (size === offset) continue;
      const chunk = await readFileDelta(file, offset, capBytes);
      const { opens, closes, consumedBytes } = parseGateChunk(chunk);
      if (consumedBytes === 0) continue; // no complete line yet — retry next tick
      const sessionId = path.basename(file, '.jsonl');

      for (const open of opens) {
        const { outcome } = await openOrTouchGate({
          workspaceId: ws,
          sessionId,
          client: 'claude',
          kind: 'ask',
          refId: open.toolUseId,
          question: open.question,
          options: open.options,
          source: 'watcher',
          rawRef: file,
        });
        if (outcome === 'opened') result.opened += 1;
        else result.alreadyOpen += 1;
        const set = openRefsBySession.get(sessionId) ?? new Set<string>();
        set.add(open.toolUseId);
        openRefsBySession.set(sessionId, set);
      }

      const knownOpen = openRefsBySession.get(sessionId);
      for (const close of closes) {
        if (!knownOpen?.has(close.toolUseId)) continue; // not a gate we opened — ignore
        const closedCount = await closeGateByToolUseId({ workspaceId: ws, sessionId, toolUseId: close.toolUseId });
        if (closedCount > 0) {
          result.closed += closedCount;
          knownOpen.delete(close.toolUseId);
        }
      }

      await sql`
        INSERT INTO harness_shared.session_gate_watcher_files (workspace_id, file_path, byte_offset, updated_at)
        VALUES (${ws}, ${file}, ${offset + consumedBytes}, now())
        ON CONFLICT (workspace_id, file_path)
        DO UPDATE SET byte_offset = EXCLUDED.byte_offset, updated_at = now()
      `;
    } catch (e) {
      result.errors.push({ file, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
