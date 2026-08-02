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
import { buildSpillIndex } from './result-door-index';

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

// EI-18745696571494110: some tools truncate individual FIELDS inside their own
// JSON body (coord:inbox's per-entry `body_truncated`, plan/list summaries'
// `summary_truncated`, …) independently of this door's own budget — there is
// no shared `_meta` marker for this (unlike `payloadProjection` above), because
// each tool bakes its own field-level cutoff into the body it serializes. When
// that happens on a result that ALSO overflows the door, the spill faithfully
// preserves the tool's output — but that output was already missing the field
// content, so "page the spill instead of re-running" is a dead end: the spill
// can never contain what the tool itself never serialized. Detect the generic
// `"<name>_truncated": true` shape textually (cheap, tool-agnostic) and swap
// the footer/header wording so the reader is pointed at re-calling the tool
// with a wider field-level limit instead of paging a spill that cannot help.
const INNER_TRUNCATION_MARKER_REGEX = /"(\w*_truncated)"\s*:\s*true\b/g;

/** Distinct `*_truncated: true` marker names found in `text` (capped — this
 *  feeds advisory wording, not an audit). Empty when none are present. */
function detectInnerTruncationMarkers(text: string): string[] {
  const found = new Set<string>();
  INNER_TRUNCATION_MARKER_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INNER_TRUNCATION_MARKER_REGEX.exec(text))) {
    found.add(m[1]);
    if (found.size >= 5) break;
  }
  return [...found];
}

/**
 * P-020 / D-041 discoverability. The projection stage is a DISPATCH-level
 * reserved arg, so it appears in no tool's inputSchema — which means no agent
 * would ever learn it exists, and a built-but-unreachable feature is dead code
 * however green its tests. Injecting the schema into all ~550 tools would blow
 * the P-011 prompt-weight budget for a knob most calls never use.
 *
 * A truncated result is the one moment the answer is both relevant and earned:
 * the caller has just been handed less than they asked for and is about to go
 * page a spill file. Teaching `projection` HERE costs zero standing context and
 * arrives exactly when it is actionable — the same "advise at the decision
 * point" shape as the code:run batch nudge.
 */
const PROJECTION_HINT =
  ` ⓘ To get only what you need in ONE call instead of paging this spill, re-call with a ` +
  `caller-specified projection: \`projection: { pipe: [{ op:"grep", pattern:"..." }, { op:"head", n:20 }] }\` ` +
  `for text, or \`projection: { pick: ["results[].id","results[].state"] }\` for a JSON body. ` +
  `Operators: grep (fixed/ignoreCase/invert/before/after/context), head, tail, sort, uniq, cut, count — ` +
  `applied in order, to any tool's result.`;

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
    // EI-13918: `result.data` may ALREADY have been replaced upstream by a
    // lossy payload-tier projection (payload-tier.ts) BEFORE this door ever
    // saw it — in which case `fullText` below is not the tool's true full
    // output; the genuinely-omitted content was never serialized at all, so
    // paging this spill file can never recover it. Detect that via the
    // `_meta.payloadProjection` marker (serialize-result.ts) rather than
    // sniffing the serialized JSON text, and pick truthful header/footer
    // wording for each case instead of unconditionally claiming "FULL".
    const upstreamProjection = (
      result._meta as { payloadProjection?: {
        truncated: true; tier: string; forced: boolean;
        originalChars: number; returnedChars: number; omittedCount: number;
      } } | undefined
    )?.payloadProjection;
    let totalChars = 0;
    for (const it of items) if (isTextItem(it)) totalChars += it.text.length;
    if (totalChars <= budgetChars) {
      // EI-19361771982678588: FITTING THE DOOR IS NOT BEING COMPLETE. This
      // early return is the fast path for an ordinary small result — but a
      // result that was tier-trimmed upstream and THEN landed under the door
      // budget took this path too, and every truncation disclosure below is
      // downstream of here. So the more aggressively a tool trimmed its own
      // payload, the more likely it was to say nothing about it: the warning
      // fired only when the *already-trimmed* body still overflowed. The
      // facts:list case that motivated this cleared the door by 245 chars out
      // of ~6,000 — a slightly tighter trim would have gone silent.
      //
      // Nothing to spill (the omitted rows were never serialized), so this
      // discloses in-band and returns; the identity fast-path is preserved for
      // the overwhelmingly common untruncated case.
      if (!upstreamProjection?.truncated) return result;
      return {
        ...result,
        content: [
          ...items,
          {
            type: 'text' as const,
            text:
              `\n[⚠ PARTIAL RESULT — this fit the per-result door, but it is NOT the tool's full ` +
              `output: it was tier-projected upstream (payloadProjection: tier=${upstreamProjection.tier} ` +
              `forced=${upstreamProjection.forced} omittedCount=${upstreamProjection.omittedCount}, ` +
              `${upstreamProjection.returnedChars} of ${upstreamProjection.originalChars} chars). Those ` +
              `${upstreamProjection.omittedCount} field(s)/row(s) were never serialized, so nothing ` +
              `downstream can recover them and their ABSENCE HERE IS NOT EVIDENCE THEY DO NOT EXIST. ` +
              `Re-call ${opts.toolName} with payloadTier:'full' (or narrower args) for the missing detail.]`,
          },
        ],
      } as T;
    }

    const fullText = items
      .filter(isTextItem)
      .map((it) => it.text)
      .join('\n\n');
    const parts = scratchParts(opts);
    const basename = `result-door-${Date.now()}.md`;
    const uri = buildScratchUri({ ...parts, basename });
    const fsPath = safeScratchFilesystemPath(uri);
    mkdirSync(dirname(fsPath), { recursive: true });
    // EI-18745696571494110: no upstream `_meta` marker fired, but the tool may
    // have still truncated individual FIELDS inside its own body (coord:inbox's
    // per-entry `body_truncated`, a list's `summary_truncated`, …) — check only
    // when upstreamProjection didn't already explain the shortfall, since that
    // case is more severe (the WHOLE result is a partial projection) and takes
    // priority over a field-level marker.
    const innerTruncationMarkers = upstreamProjection ? [] : detectInnerTruncationMarkers(fullText);
    const header = upstreamProjection
      ? `# result-door spill — an ALREADY-PROJECTED (partial) tool result\n` +
        `# tool: ${opts.toolName}\n# spilled: ${new Date().toISOString()}\n` +
        `# upstream payload-tier shaping already replaced the tool's full output with a ` +
        `bounded projection BEFORE this door ran: tier=${upstreamProjection.tier} ` +
        `forced=${upstreamProjection.forced} originalChars=${upstreamProjection.originalChars} ` +
        `returnedChars=${upstreamProjection.returnedChars} omittedCount=${upstreamProjection.omittedCount}.\n` +
        `# The ${upstreamProjection.omittedCount} omitted field(s)/row(s) were NEVER serialized and are ` +
        `NOT recoverable from this file — re-call ${opts.toolName} with payloadTier:'full' ` +
        `(or narrower args) for the missing detail.\n` +
        `# What follows is only that already-partial projection, further capped at the ` +
        `per-result door (${doorTokens} tokens) below.\n\n`
      : innerTruncationMarkers.length > 0
      ? `# result-door spill — FULL door-level text, but the TOOL ITSELF already truncated field(s)\n` +
        `# tool: ${opts.toolName}\n# spilled: ${new Date().toISOString()}\n` +
        `# original ~${Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)} tokens (${totalChars} chars); door ${doorTokens} tokens\n` +
        `# detected marker(s): ${innerTruncationMarkers.join(', ')} — these mark field(s) the tool cut\n` +
        `# short BEFORE this door ever ran. This file holds everything the tool DID emit, but the\n` +
        `# marked field(s) are themselves incomplete and were never fully serialized — paging this\n` +
        `# file will NOT recover them. Re-call ${opts.toolName} with a wider per-field limit/budget\n` +
        `# argument for the missing detail.\n\n`
      : // EI-18762253154342502: never claim "FULL" unconditionally — no marker firing
        // proves nothing was cut upstream, only that no DETECTED marker was found (a
        // tool can truncate a field with a plain ellipsis and no `_truncated` flag,
        // as plans:items did before this fix). "as it reached this door" is always
        // true and never overclaims what was actually recoverable.
        `# result-door spill — the text as it reached this door (no upstream truncation marker detected;\n` +
        `# that does NOT guarantee the tool emitted every field in full — only that none of its known\n` +
        `# _truncated markers fired)\n` +
        `# tool: ${opts.toolName}\n# spilled: ${new Date().toISOString()}\n` +
        `# original ~${Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)} tokens (${totalChars} chars); door ${doorTokens} tokens\n\n`;
    // P-003 (agent-epistemics-2026-08-02): for a LIST-shaped result, lead the file
    // with one line per entry. The door already solves SIZE; this solves the question
    // the reader actually arrives with — "which of these do I care about" — which was
    // otherwise answered by grepping the spill file by hand. It lives in the FILE, not
    // in the returned result, so it costs the agent zero context. `buildSpillIndex`
    // returns null (never throws) whenever an index would not help, keeping the
    // door's fail-soft contract: a missing index is an annoyance, a failed WRITE
    // loses the payload.
    const spillIndex = buildSpillIndex(fullText);
    writeFileSync(fsPath, header + (spillIndex ? `${spillIndex}\n` : '') + fullText, { mode: 0o600 });

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
      text: upstreamProjection
        ? `\n[result-door: this result exceeded the ~${doorTokens}-token per-result budget ` +
          `(~${Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)} tokens) and was truncated. ` +
          `⚠ this is NOT the tool's full output — it was ALREADY tier-projected upstream ` +
          `(payloadProjection: tier=${upstreamProjection.tier} forced=${upstreamProjection.forced} ` +
          `omittedCount=${upstreamProjection.omittedCount}) before reaching this door. The spilled ` +
          `file at ${fsPath} (scratch URI: ${uri}) contains only that already-partial projection, NOT ` +
          `the omitted content — paging it will never recover what was omitted upstream. For full ` +
          `detail, re-call ${opts.toolName} with payloadTier:'full'.]`
        : innerTruncationMarkers.length > 0
        ? `\n[result-door: this result exceeded the ~${doorTokens}-token per-result budget ` +
          `(~${Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)} tokens) and was truncated. ` +
          `⚠ it ALSO contains field(s) the TOOL ITSELF already truncated before spilling ` +
          `(marker${innerTruncationMarkers.length > 1 ? 's' : ''}: ${innerTruncationMarkers.join(', ')}). ` +
          `The spilled file at ${fsPath} (scratch URI: ${uri}) preserves everything the tool emitted, ` +
          `but those marked field(s) were never fully serialized — paging it will NOT recover them. ` +
          `Re-call ${opts.toolName} with a wider per-field limit/budget argument for the missing detail.]`
        : `\n[result-door: this result exceeded the ~${doorTokens}-token per-result budget ` +
          `(~${Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)} tokens) and was truncated. ` +
          `The result as it reached this door is at ${fsPath} (scratch URI: ${uri}) — page it with a ` +
          `bounded read (offset/limit) instead of re-running the tool. (No upstream truncation marker ` +
          `was detected, but that is not a guarantee the tool emitted every field in full — if a field ` +
          `still looks cut short after paging, re-call ${opts.toolName} with a wider per-field ` +
          `limit/budget argument or payloadTier:'full'.)]`,
    });
    // Appended to whichever footer variant fired — every truncation is a chance
    // to teach the one knob that would have prevented it (see PROJECTION_HINT).
    const lastItem = doored[doored.length - 1] as { type: 'text'; text: string };
    lastItem.text = `${lastItem.text.slice(0, -1)}${PROJECTION_HINT}]`;
    return { ...result, content: doored };
  } catch {
    return result; // fail-soft: never let the door break a good result
  }
}
