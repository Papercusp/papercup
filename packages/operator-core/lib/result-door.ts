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
 *   - genuine delta ENVELOPE results (`_meta.delta.mode !== 'full'`) —
 *     content[0].text is structured JSON the CLIENT JSON.parses to
 *     reconstruct; a cap corrupts it (the delta protocol is itself a
 *     result-shrinking mechanism). NOTE: every delta-CAPABLE tool also
 *     stamps `_meta.delta` on an ORDINARY full response (`mode:'full'`,
 *     reason `no_request` or `proxy_reconstructed`) to advertise the
 *     capability + carry a cursor — that shape is a normal body and MUST
 *     still be doored (EI-19325631662380565: the mere presence of the
 *     block used to skip the door for the whole list-tool family, the
 *     fattest population it exists to cap);
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
import { projectBoundedPayload } from '@papercusp/tooldef';
import { CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from './context-doors';
import { getDoorConstantsSync } from './context-doors-config';
import { buildScratchUri, safeScratchFilesystemPath } from './scratch-uri';
import { buildSpillIndex } from './result-door-index';
import { classifyProjectionBody } from './result-projection';

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
/**
 * D-012 (plan agent-context-firewall-and-output-spill-2026-08-02): the hint is
 * a FUNCTION of the payload, not a constant.
 *
 * The constant this replaces led with `pipe` "for text" on every result —
 * including the one-line JSON bodies that are the overwhelming majority of what
 * this door cuts. On such a body the line operators are provably all-or-nothing
 * (measured: `grep` with a non-matching pattern returns an EMPTY body, `head
 * n:3` returns the ENTIRE array), so the footer's first suggestion was the one
 * operator family that cannot reduce the payload it is attached to — and a
 * no-match reads exactly like a successful filter. Filed as
 * EI-19387749343846381.
 *
 * opencode does the same thing correctly and is where the ruling comes from
 * (`tool/truncate.ts:109-111`): its spill hint branches on `hasTaskTool(agent)`
 * so it never advertises a recovery route the reading agent cannot take. This
 * is that, applied to payload TYPE — and the classification comes from
 * `classifyProjectionBody`, the same function the projection stage itself uses
 * to find the body `pick` operates on, so the advertised operator cannot drift
 * from the one that would actually run.
 */
export function buildProjectionHint(
  textItems: ReadonlyArray<{ text: string }>,
  toolName: string,
): string {
  // BUDGET NOTE (measured, not assumed — the correction in D-016): this string
  // is emitted on EVERY doored result, ~2,600 times per 6 days, 83% of them
  // JSON. A first cut of this function was 570 chars against the 420-char
  // constant it replaced — +34.5% overall, i.e. it would have spent ~94k est.
  // tokens per 6d to fix a correctness bug. Every variant below is now AT OR
  // UNDER the constant's 420. Keep it that way: measure a wording change here,
  // do not eyeball it.
  const lead = ` ⓘ Get only what you need in ONE call instead of paging this spill: `;
  const asString = ` \`projection\` also accepts a JSON STRING.`;
  let shape: { json: unknown; lineCount: number };
  try {
    shape = classifyProjectionBody(textItems);
  } catch {
    // Fail-soft to the payload-agnostic wording rather than losing the hint.
    return (
      `${lead}\`projection: { pick: ["results[].id"] }\` for a JSON body, or ` +
      `\`projection: { pipe: [{ op:"grep", pattern:"..." }] }\` for multi-line text.${asString}`
    );
  }
  if (shape.json) {
    return (
      `${lead}\`projection: { pick: ["results[].id","results[].state"] }\`. This body is JSON on ` +
      `${shape.lineCount} line(s), so \`pick\` is what reduces it — the \`pipe\` line-operators are ` +
      `all-or-nothing here (a no-match returns an EMPTY body, which reads like a filter that ` +
      `worked).${asString}`
    );
  }
  if (shape.lineCount > 1) {
    return (
      `${lead}\`projection: { pipe: [{ op:"grep", pattern:"..." }, { op:"head", n:20 }] }\`. This body ` +
      `is ${shape.lineCount} lines of non-JSON text, so the line-operators are what reduce it: grep ` +
      `(fixed/ignoreCase/invert/before/after/context), head, tail, sort, uniq, cut, count, applied in ` +
      `order. \`pick\` does not apply here (it selects JSON fields).${asString}`
    );
  }
  return (
    ` ⓘ \`projection\` cannot help here: a single non-JSON line, so \`pick\` (JSON fields) and the ` +
    `\`pipe\` line-operators are both all-or-nothing on it. Page the spill with a bounded read, or ` +
    `re-call ${toolName} with narrower arguments.`
  );
}

/** Approximate context cost of a NON-text content item (WI-36613). Cheap by
 *  design — an MCP image/audio block carries its payload as a base64 `data`
 *  string, so its length IS the cost; anything else falls back to a fail-soft
 *  stringify. Called only for items that are already known not to be text, which
 *  in this corpus is a near-empty population. */
function nonTextSize(it: unknown): number {
  const data = (it as { data?: unknown } | undefined)?.data;
  if (typeof data === 'string') return data.length;
  try {
    return JSON.stringify(it)?.length ?? 0;
  } catch {
    return 0;
  }
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
    // EI-19325631662380565: `_meta.delta` presence alone is NOT the marker of a
    // genuine delta envelope — every delta-CAPABLE tool also stamps this block on
    // an ordinary full response (mode:'full', reason 'no_request' or
    // 'proxy_reconstructed') to advertise the capability + carry a cursor. Only a
    // non-'full' mode is a client-reconstructed patch that a text cap would corrupt.
    const deltaMeta = (result._meta as { delta?: { mode?: unknown } } | undefined)?.delta;
    if (deltaMeta != null && deltaMeta.mode !== 'full') return result;
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
    // WI-36613 (borrow item 10). The door measures TEXT ONLY — `totalChars` sums
    // text items and the rebuild below passes every non-text item through intact.
    // That means a result of 2MB of base64 PNG plus 100 chars of text has
    // totalChars=100, takes the identity fast-path directly below, and reaches
    // the model uncapped, unspilled, and UNMENTIONED.
    //
    // OMP has the same shape (its universal cap measures only block.type==='text'),
    // and the transferable point is that NOTHING IN THE CODE LOOKS WRONG when a
    // byte cap written against text silently exempts every other content type.
    //
    // Measured exposure here is currently ZERO — the only image-emitting path is
    // computer:* (computer.ts:161) and tool_invocations has never recorded one
    // (0 rows ever, against 1,116,788 rows / 302 distinct tools in 14 days). So
    // this deliberately does NOT cap: no data justifies a number, and a
    // speculative cap on a path nobody uses is churn. It only makes the exemption
    // VISIBLE the day it activates, which is the part that was actually missing.
    let nonTextChars = 0;
    for (const it of items) {
      if (isTextItem(it)) totalChars += it.text.length;
      else nonTextChars += nonTextSize(it);
    }
    // Only worth saying when the non-text payload is itself over the door budget:
    // below that it is noise, and the fast path must stay byte-identical for the
    // overwhelmingly common ordinary result.
    const nonTextOverBudget = nonTextChars > budgetChars;
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
      if (!upstreamProjection?.truncated && !nonTextOverBudget) return result;
      const fastPathNotices: string[] = [];
      if (nonTextOverBudget) {
        fastPathNotices.push(
          `\n[⚠ UNCAPPED NON-TEXT PAYLOAD — the text in this result fit the per-result door, so ` +
            `nothing was truncated, but it also carries ~${nonTextChars} chars of NON-TEXT content ` +
            `(image/binary blocks). The door measures TEXT ONLY and passes non-text through intact, ` +
            `so that payload entered your context in full — ~${Math.round(nonTextChars / budgetChars)}× ` +
            `the ~${doorTokens}-token text budget. Nothing is wrong; it is simply not bounded by this ` +
            `door. If you did not need the capture, re-call without the argument that produced it.]`,
        );
      }
      if (upstreamProjection?.truncated) {
        fastPathNotices.push(
          `\n[⚠ PARTIAL RESULT — this fit the per-result door, but it is NOT the tool's full ` +
              `output: it was tier-projected upstream (payloadProjection: tier=${upstreamProjection.tier} ` +
              `forced=${upstreamProjection.forced} omittedCount=${upstreamProjection.omittedCount}, ` +
              `${upstreamProjection.returnedChars} of ${upstreamProjection.originalChars} chars). Those ` +
              `${upstreamProjection.omittedCount} field(s)/row(s) were never serialized, so nothing ` +
              `downstream can recover them and their ABSENCE HERE IS NOT EVIDENCE THEY DO NOT EXIST. ` +
              `Re-call ${opts.toolName} with payloadTier:'full' (or narrower args) for the missing detail.]`,
        );
      }
      return {
        ...result,
        content: [...items, ...fastPathNotices.map((text) => ({ type: 'text' as const, text }))],
      } as T;
    }

    const textItems = items.filter(isTextItem);
    const fullText = textItems.map((it) => it.text).join('\n\n');
    // WI-36047 (borrow item 9, opencode/OMP research): THE SPILL GETS ITS OWN
    // FAIL-SOFT BOUNDARY, SEPARATE FROM THE CAP.
    //
    // This door's cap is implemented as a side-effect of "park the full copy
    // somewhere first", and that shape has TWO distinct failure modes which
    // deserve OPPOSITE answers:
    //   - the CAPPING fails  → returning the original result is right (the door
    //     must never turn a good result into a failure);
    //   - the SPILL WRITE fails → returning the original result is WRONG. It
    //     re-exposes the full, context-blowing payload the door exists to bound,
    //     and it does so precisely when the box is already unhealthy (disk full,
    //     unwritable scratch, permissions).
    // Until this fix ONE `try` spanned both, so the second case silently took the
    // first case's answer. OMP has the identical bug with the sign flipped: it
    // gets the save-FAILED path right (output-meta.ts:684-692, truncates anyway,
    // under an explicit comment that a save failure must never re-expose the full
    // output) and the store-ABSENT path wrong (`:656`, returns uncapped).
    //
    // So: a spill we could not write degrades to TRUNCATE-WITHOUT-RECOVERY —
    // still capped, and the footer says the overflow is gone rather than naming a
    // path that does not exist. Never to no-cap.
    let fsPath: string | null = null;
    let uri: string | null = null;
    let spillError: string | null = null;
    // The FOOTER is model-facing prose and gets the terse errno only. A raw fs
    // error message embeds the full failing path (`ENOTDIR: not a directory,
    // mkdir '/…/scratch/ws-1/plans:get/…'`), which would put a filesystem path
    // back into a footer whose entire job here is to name NO path — and a reader
    // that sees one will try to page it. The full message stays on `_meta`.
    let spillErrorCode: string | null = null;
    const noteSpillFailure = (err: unknown): void => {
      spillError = err instanceof Error ? err.message : String(err);
      spillErrorCode = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown error';
      fsPath = null;
      uri = null;
    };
    try {
      const parts = scratchParts(opts);
      const basename = `result-door-${Date.now()}.md`;
      uri = buildScratchUri({ ...parts, basename });
      fsPath = safeScratchFilesystemPath(uri);
    } catch (err) {
      // A path we cannot even NAME is the store-absent case: cap, disclose, move on.
      noteSpillFailure(err);
    }
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
    if (fsPath != null) {
      try {
        mkdirSync(dirname(fsPath), { recursive: true });
        writeFileSync(fsPath, header + (spillIndex ? `${spillIndex}\n` : '') + fullText, {
          mode: 0o600,
        });
      } catch (err) {
        // WI-36047: the write failed — fall through to the CAP anyway, and null
        // the path so no footer, no `_meta`, and no telemetry backfill advertises
        // a spill file that is not there. Truncate-without-recovery, never no-cap.
        noteSpillFailure(err);
      }
    }

    const baseResultDoorMeta = {
      truncated: true,
      /** null when the spill could NOT be written (WI-36047) — the result was
       *  still capped, but nothing was parked, so `_mcp-handler`'s outputRef
       *  backfill correctly declines to advertise a file that is not there. */
      spillPath: fsPath,
      spillUri: uri,
      /** True when the cap applied but the spill write failed, i.e. the cut
       *  content is gone. Distinct from `upstreamProjected` (content that was
       *  never serialized) — this is content the door itself discarded. */
      spillFailed: fsPath == null,
      /** Full fs error message (carries the failing path — kept OUT of the
       *  model-facing footer, which gets `spillErrorCode` instead). */
      spillError,
      spillErrorCode,
      originalChars: totalChars,
      /** Approximate chars of NON-text content (images/binary) this result
       *  carried. The door does NOT cap these — it measures text only — so this
       *  field is the only place that number is stated (WI-36613). 0 for the
       *  overwhelming majority of results. */
      nonTextChars,
      doorTokens,
      /** True when `data` was ALREADY a lossy upstream projection before this
       *  door saw it — i.e. paging the spill cannot recover what was omitted. */
      upstreamProjected: Boolean(upstreamProjection),
      /** Field-level cutoffs the TOOL itself applied; the spill cannot recover
       *  these either (EI-18745696571494110). Empty when none were detected. */
      innerTruncationMarkers,
    };

    // WI-38402 / EI-20244970883634313 / EI-20435986111760474: character-slicing
    // ANY oversized text body creates an incomplete transport value. JSON was
    // the obvious case, but raw text is equally unsafe for a machine-readable
    // caller: code:tools emits TypeScript, and tools:invoke used to return a
    // sliced declaration followed by prose. ptool correctly refused that as an
    // incomplete payload, so a ten-signature acceptance read could not recover.
    //
    // This is the universal model-facing choke point. Project both JSON and
    // non-JSON text STRUCTURALLY and serialize only after projection completes.
    // Non-JSON text gets a stable `{ text, _projection }` envelope; JSON retains
    // its native object/array shape plus `_projection`. The durable spill is
    // written first, so both forms carry the same schema-valid capability:read
    // cursor and no client ever has to parse a chopped prefix plus a prose footer.
    const bodyShape = classifyProjectionBody(textItems);
    const parsedJsonBody = bodyShape.json != null;
    const recovery = fsPath != null && uri != null
      ? {
          cursor: {
            kind: 'scratch-page',
            tool: 'capability:read',
            args: { file_path: fsPath, byte_offset: 0, byte_limit: 3_072 },
            uri,
            // EI-20685195115158619: these two are NAMED for what they describe.
            // A bare `encoding: 'base64'` sitting beside `file_path` reads as
            // "the file at that path is base64" — an agent acted on exactly that
            // reading, ran `base64 -d <path>`, got `invalid input`, and burned
            // calls. Only capability:read's RESPONSE `data` field is base64
            // (byte-window mode, read.ts); the spill FILE is plaintext UTF-8, and
            // being directly greppable/tailable is the point of writing it that
            // way. `result-door-encoding-contract.test.ts` follows this cursor
            // end-to-end so the two can never drift apart silently.
            responseDataEncoding: 'base64',
            spillFileEncoding: 'utf-8',
          },
          next:
            // `response.data` rather than a bare `data`: naming the field's OWNER
            // is what stops the misread (EI-20685195115158619), and it costs 9
            // chars against the budget the comment below guards. The rest of the
            // disambiguation rides on the self-describing cursor fields above,
            // which are branch-independent and cost the JSON preview nothing.
            `Call capability:read with _projection.cursor.args, base64-decode response.data, then follow ` +
            `next_cursor until eof to recover the exact spill bytes. The spill begins with a text ` +
            `header and then contains the result as it reached this door.` +
            // Keep the established JSON recovery pointer deliberately terse. The
            // payload projector budgets the pointer together with the retained
            // JSON preview; expanding it here can evict coord:orient's recovery
            // fields from that preview (WI-5656) — measured again on
            // EI-20685195115158619, where a ~90-char plaintext warning here reded
            // orient-recovery-door-priority. Raw text needs the fuller honesty
            // wording because its new `{ text, _projection }` envelope replaced
            // the former prose footer that carried those disclosures.
            (parsedJsonBody
              ? ''
              : ` The spill FILE is plaintext — grep/tail it directly; \`base64 -d\` on ` +
                `args.file_path fails EMPTY, which reads as an empty spill.`) +
            (parsedJsonBody
              ? ''
              : upstreamProjection
                ? ` ⚠ This is NOT the tool's full output: it was ALREADY tier-projected upstream ` +
                  `(tier=${upstreamProjection.tier}, forced=${upstreamProjection.forced}, ` +
                  `omittedCount=${upstreamProjection.omittedCount}); paging cannot recover those omitted ` +
                  `fields. Re-call ${opts.toolName} with payloadTier:'full' for full detail.`
                : innerTruncationMarkers.length > 0
                  ? ` ⚠ The TOOL ITSELF already truncated field(s) before this door ` +
                    `(${innerTruncationMarkers.join(', ')}); paging preserves what it emitted but cannot ` +
                    `recover those fields. Re-call ${opts.toolName} with a wider per-field limit.`
                  : ` No upstream truncation marker was detected; that does not prove the tool emitted ` +
                    `every field in full.`) +
            buildProjectionHint(textItems, opts.toolName),
        }
      : {
          cursor: {
            kind: 'unavailable',
            tool: opts.toolName,
            args: {},
            reason: 'spill-write-failed',
          },
          next:
            `The result was structurally bounded, but its spill write failed ` +
            `(${spillErrorCode ?? 'unknown error'}), so the omitted bytes are NOT recoverable and no ` +
            `spill path exists. Re-call ${opts.toolName} with narrower arguments or a projection.` +
            (upstreamProjection
              ? ` It was ALSO tier-projected upstream (omittedCount=${upstreamProjection.omittedCount}), ` +
                `so those fields were never serialized either.`
              : '') +
            buildProjectionHint(textItems, opts.toolName),
        };
    const projected = projectBoundedPayload(
      parsedJsonBody ? bodyShape.json!.parsed : { text: fullText },
      {
        toolName: opts.toolName,
        tier: 'trimmed',
        forced: true,
        originalChars: totalChars,
        targetChars: budgetChars,
        recovery,
      },
    );
    const structuralText = JSON.stringify(projected);
    let inserted = false;
    const structuralContent: Array<{ type: 'text'; text: string } | Record<string, unknown>> = [];
    for (const item of items) {
      if (isTextItem(item)) {
        if (!inserted) {
          structuralContent.push({ type: 'text', text: structuralText });
          inserted = true;
        }
      } else {
        structuralContent.push(item as Record<string, unknown>);
      }
    }
    return {
      ...result,
      _meta: {
        ...(result._meta ?? {}),
        resultDoor: {
          ...baseResultDoorMeta,
          structural: true,
          recoveryCursor: recovery.cursor,
        },
      },
      content: structuralContent,
      // EI-20335562969900283: `structuredContent` is the schema-bearing MCP
      // payload, not a second copy of the model-facing text body. Replacing it
      // with `projected` can violate the declared outputSchema after a generic
      // projection omits rows/required fields. Preserve it byte-for-byte; only
      // model-facing text is subject to this context door.
    } as T;
  } catch {
    return result; // fail-soft: never let the door break a good result
  }
}
