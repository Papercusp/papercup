/**
 * Per-tool-result door (deterministic-context-carry P-006 leg C, ornith-overflow brief).
 *
 * Caps the TEXT content of one MCP `tools/call` result at the `resultEach` door
 * (context-doors.ts — 1500 tokens at the universal 8K floor, ~6000 chars) so a
 * single oversized tool result cannot blow the per-hop ingestion budget the
 * compaction thresholds are derived from (P-007 holds by CONSTRUCTION). The FULL
 * original text is spilled to the existing scratch store (scratch-uri.ts,
 * "tool-output-as-resource" T2.3) behind a pointer line, so nothing is lost —
 * the reader pages the spill file instead of paying for the whole result in one
 * hop.
 *
 * Same universal-floor rationale as the wake-executor injection door (leg B):
 * this seam does not know the CALLER's context window, and /26 lands virtually
 * every fleet model at the 8K floor anyway, so the floor door applies to all.
 * P-023 makes the knobs configurable.
 *
 * Applied at ONE choke point — the direct tools/call `execute()` path in
 * _mcp-handler.ts, AFTER the delta proxy — because that is where every
 * model-facing result converges (a tools:invoke inner result re-enters through
 * its outer call). Machine-consumed dispatches (capabilities/invoke, the
 * tools:invoke inner re-dispatch, TUI plan-item routes) are deliberately NOT
 * doored: their consumers parse programmatically and pay no context rent.
 *
 * Never doored, by construction:
 *   - delta-protocol results (`_meta.delta` set) — content[0].text is
 *     structured JSON the CLIENT JSON.parses to reconstruct; a cap corrupts it
 *     (the delta protocol is itself a result-shrinking mechanism);
 *   - non-text content items (images, resource links) — passed through intact.
 *
 * Kill-switch: PAPERCUSP_RESULT_DOOR_OFF=1 bypasses entirely (operational
 * rollback, mirrors PAPERCUSP_INJECTION_DOOR_OFF). Fail-soft: any error while
 * capping/spilling returns the ORIGINAL result untouched — the door must never
 * turn a good result into a failure.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHARS_PER_TOKEN_ESTIMATE, capInjectionText, computeTurnDoors } from './context-doors';
import { getDoorConstantsSync } from './context-doors-config';
import { buildScratchUri, safeScratchFilesystemPath } from './scratch-uri';

/** The BAKED floor `resultEach` door (window 0 ⇒ the 8K-floor split ⇒ 1500 tokens).
 *  The live door is resolved per call through the P-023 config surface
 *  (getDoorConstantsSync — workspace defaults ⟵ per-session override); un-configured,
 *  it is exactly this value. */
export const RESULT_DOOR_TOKENS = computeTurnDoors(0).resultEach;

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_SEGMENT_REGEX = /^[A-Za-z0-9._:-]+$/;

/** The subset of an MCP tools/call result the door reads/rewrites. */
export interface DoorableResult {
  content: ReadonlyArray<{ type?: string; text?: string } | Record<string, unknown>>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
}

export interface ResultDoorOpts {
  /** Canonical tool name (colon form) — names the scratch subdir + pointer line. */
  toolName: string;
  /** Caller's workspace id; '*'/invalid shapes spill under 'unscoped'. */
  workspaceId?: string | null;
  /** Spawn run id when it is a UUID; otherwise a fresh UUID names the spill dir. */
  runId?: string | null;
  /** Caller's resolved agent ownerId (resolveAgentIdentity) — keys the P-023
   *  per-session door override; absent ⇒ workspace/baked constants. */
  ownerId?: string | null;
}

function isTextItem(it: unknown): it is { type: 'text'; text: string } {
  return (
    !!it &&
    typeof it === 'object' &&
    (it as { type?: unknown }).type === 'text' &&
    typeof (it as { text?: unknown }).text === 'string'
  );
}

/** Shape the parts so buildScratchUri's validators accept them (fail-soft names,
 *  never fail-the-spill on a weird caller identity). */
function scratchParts(opts: ResultDoorOpts): { workspaceId: string; toolName: string; runId: string } {
  const rawWs = opts.workspaceId ?? '';
  const workspaceId =
    TOOL_SEGMENT_REGEX.test(rawWs) && rawWs !== '.' && rawWs !== '..' ? rawWs : 'unscoped';
  let toolName = TOOL_SEGMENT_REGEX.test(opts.toolName) ? opts.toolName : 'unknown:tool';
  if (!toolName.includes('.') && !toolName.includes(':')) toolName = `tool:${toolName}`;
  const runId = opts.runId && UUID_V4_REGEX.test(opts.runId) ? opts.runId : randomUUID();
  return { workspaceId, toolName, runId };
}

/**
 * Cap `result`'s text content at the resultEach door; over-door → spill the FULL
 * text to scratch + append a pointer line. Returns the ORIGINAL result object
 * unchanged when it fits, is a delta result, the kill-switch is on, or anything
 * goes wrong (fail-soft).
 */
export function applyResultDoor<T extends DoorableResult>(result: T, opts: ResultDoorOpts): T {
  try {
    if (process.env.PAPERCUSP_RESULT_DOOR_OFF === '1') return result;
    if (result._meta && (result._meta as { delta?: unknown }).delta != null) return result;
    const items = result.content;
    if (!Array.isArray(items)) return result;

    // P-023: the effective resultEach door for THIS caller (workspace defaults ⟵
    // session override; sync snapshot, fail-soft to the baked 1500-token floor).
    const doorTokens = computeTurnDoors(0, getDoorConstantsSync(opts.ownerId)).resultEach;
    const budgetChars = doorTokens * CHARS_PER_TOKEN_ESTIMATE;
    let totalChars = 0;
    for (const it of items) if (isTextItem(it)) totalChars += it.text.length;
    if (totalChars <= budgetChars) return result;

    const fullText = items
      .filter(isTextItem)
      .map((it) => it.text)
      .join('\n\n');
    const parts = scratchParts(opts);
    const basename = `result-door-${Date.now()}.md`;
    const uri = buildScratchUri({ ...parts, basename });
    const fsPath = safeScratchFilesystemPath(uri);
    mkdirSync(dirname(fsPath), { recursive: true });
    const header =
      `# result-door spill — FULL tool result (the in-context copy was truncated at the door)\n` +
      `# tool: ${opts.toolName}\n# spilled: ${new Date().toISOString()}\n` +
      `# original ~${Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)} tokens (${totalChars} chars); door ${doorTokens} tokens\n\n`;
    writeFileSync(fsPath, header + fullText, { mode: 0o600 });

    // Rebuild content: text items consume the budget in order (the boundary item
    // is cut at a line/space break); non-text items pass through untouched.
    let remainingChars = budgetChars;
    const doored: Array<{ type: 'text'; text: string } | Record<string, unknown>> = [];
    for (const it of items) {
      if (!isTextItem(it)) {
        doored.push(it as Record<string, unknown>);
        continue;
      }
      if (remainingChars <= 0) continue; // fully in the spill
      if (it.text.length <= remainingChars) {
        doored.push(it);
        remainingChars -= it.text.length;
        continue;
      }
      const { kept } = capInjectionText(it.text, Math.floor(remainingChars / CHARS_PER_TOKEN_ESTIMATE));
      if (kept.length > 0) doored.push({ type: 'text', text: kept });
      remainingChars = 0;
    }
    doored.push({
      type: 'text',
      text:
        `\n[result-door: this result exceeded the ~${doorTokens}-token per-result budget ` +
        `(~${Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)} tokens) and was truncated. ` +
        `The FULL result is at ${fsPath} (scratch URI: ${uri}) — page it with a bounded read ` +
        `(offset/limit) instead of re-running the tool.]`,
    });
    return { ...result, content: doored };
  } catch {
    return result; // fail-soft: never let the door break a good result
  }
}
