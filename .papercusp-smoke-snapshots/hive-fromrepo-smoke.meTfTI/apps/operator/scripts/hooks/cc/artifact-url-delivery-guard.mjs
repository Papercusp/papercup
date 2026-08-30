#!/usr/bin/env node
/**
 * artifact-url-delivery-guard — stop an artifact URL from being reported to the
 * owner as delivered when no artifact was ever published (EI-21844056581395228,
 * a repeat of EI-19944806095285549).
 *
 * WHY A HOOK AND NOT A PROMPT RAIL
 * The prompt already carries the rail ("Rendered ≠ delivered … re-resolve before
 * citing an artifact URL as delivered"). It has now failed TWICE, in sessions
 * that were carrying that exact text. A rail that has been read and not followed
 * twice is not repaired by rewording it a third time, so this is the mechanical
 * layer underneath it. On the derived-truth ladder this is the ATTEST rung: the
 * claim ("this artifact exists") cannot be derived statically, so it is
 * reconciled against a runtime ledger of Artifact calls that actually happened.
 *
 * THE ORACLE — deliberately "verified", not "published"
 * An id is citable only if a NON-ERROR Artifact tool call in THIS session
 * returned it: a publish, an action:'list' row, or an action:'read'. That is
 * precisely the re-resolve discipline the rail asks for, so an agent citing an
 * artifact from an earlier session is required to confirm it still resolves
 * first — which is the point, not a false positive. A failing call (a read of a
 * URL that does not exist) is an error response and is never harvested, so a
 * bad URL echoed back inside an error can never verify itself.
 *
 * TWO BRANCHES, ONE MECHANISM (matching the ask-gate-mirror precedent):
 *   PostToolUse(Artifact) → harvest returned ids into a session-scoped ledger.
 *   Stop                  → scan the final assistant text; block on any cited
 *                           id the ledger never saw.
 *
 * SCANNING IS QUOTE-STRIPPED (the EI-19412167276099357 defect-3 lesson): code
 * fences, inline code and blockquotes are removed before scanning, so quoting a
 * known-bad URL — in a post-mortem, a fixture, a table row, this very file's
 * header — can never itself trip the guard. That also gives the agent its escape
 * hatch: discuss the URL in backticks, cite it bare only once it resolves.
 *
 * WHY BLOCKING AT Stop CANNOT WEDGE A SESSION: Claude sets `stop_hook_active` on
 * the continuation that follows our own decision:block, and we exit early on it.
 * The guard therefore bounces at most ONCE per turn — it forces a correction, it
 * cannot trap a session in a loop.
 *
 * FAIL-OPEN EVERYWHERE ELSE: any parse/IO failure exits 0 silently. A broken
 * guard must degrade to "no guard", never to a blocked agent.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Artifact ids as they appear in a claude.ai artifact URL. */
const ARTIFACT_URL_RE = /claude\.ai\/(?:code\/)?artifact(?:s)?\/([0-9a-zA-Z][0-9a-zA-Z-]{7,})/gi;

const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

/** Where a session's verified-id ledger lives (overridable for tests). */
export function ledgerPathFor(sessionId, env = process.env) {
  const root = env.PAPERCUSP_ARTIFACT_LEDGER_DIR || join(homedir(), '.papercusp', 'artifact-url-ledger');
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return join(root, `${safe}.ids`);
}

/**
 * Remove regions where citing a URL is deliberate quotation rather than a
 * delivery claim: fenced blocks, inline code, and blockquote lines.
 */
export function stripQuotedForScanning(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^[ \t]*>.*$/gm, ' ');
}

/** Every artifact id mentioned in `text`, de-duplicated, order preserved. */
export function extractArtifactIds(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(ARTIFACT_URL_RE)) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** True when a PostToolUse payload names the native/MCP Artifact tool. */
export function isArtifactTool(toolName) {
  return typeof toolName === 'string' && /(^|_)artifact$/i.test(toolName.replace(/^mcp__.*?__/, ''));
}

/** True when the tool response reports failure (never harvest from these). */
export function isErrorResponse(response) {
  if (!response) return false;
  if (typeof response === 'object') {
    if (response.is_error === true || response.isError === true) return true;
    if (response.error) return true;
    if (response.ok === false) return true;
  }
  return false;
}

/**
 * Ids a non-error Artifact call actually returned. Harvest from the RESPONSE
 * only: an id that appears solely in the request is a URL the agent asserted,
 * which is exactly the unverified thing this guard exists to catch.
 */
export function harvestLedgerIds(hook) {
  if (!hook || !isArtifactTool(hook.tool_name ?? hook.toolName)) return [];
  const response = hook.tool_response ?? hook.toolResponse;
  if (response === undefined || response === null) return [];
  if (isErrorResponse(response)) return [];
  let blob;
  try {
    blob = typeof response === 'string' ? response : JSON.stringify(response);
  } catch {
    return [];
  }
  return extractArtifactIds(blob);
}

export function readLedger(path) {
  try {
    return new Set(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export function appendLedger(path, ids) {
  if (!ids.length) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, ids.map((id) => `${id}\n`).join(''), 'utf8');
  } catch {
    /* fail open */
  }
}

export function formatBlockReason(unverified) {
  const list = unverified.map((id) => `  • ${id}`).join('\n');
  return (
    `⛔ artifact-url-delivery-guard (EI-21844056581395228): your message cites an ` +
    `artifact URL that NO Artifact call in this session ever returned:\n\n${list}\n\n` +
    `Publishing is not the same as delivering, and a publish result is not proof a ` +
    `page is reachable. This exact failure has now happened twice: a URL was reported ` +
    `to the owner as ready for review and the artifact did not exist.\n\n` +
    `Do ONE of these before ending the turn:\n` +
    `  1. VERIFY it — Artifact { action:'list' } (it should appear) or read/publish it. ` +
    `Then cite it; this guard will pass because the call returned the id.\n` +
    `  2. STOP CITING IT — if it does not resolve, say so plainly and retract it. ` +
    `A dead URL handed to the owner is worse than no link.\n` +
    `  3. QUOTE IT — discussing a known-bad URL is fine in backticks or a code fence; ` +
    `this guard only scans unquoted prose.\n\n` +
    `Prefer recording the SOURCE FILE PATH alongside any URL: a path lets the next ` +
    `reader republish, where a bare dead URL is a dead end.`
  );
}

/**
 * The Stop decision. Returns null to allow the turn to end, or { reason }.
 * Pure so both directions are unit-testable without a transcript or a session.
 */
export function evaluateStop({ text, ledger, stopHookActive }) {
  if (stopHookActive) return null; // loop guard — never bounce twice in one turn
  const cited = extractArtifactIds(stripQuotedForScanning(text));
  if (!cited.length) return null;
  const unverified = cited.filter((id) => !ledger.has(id));
  if (!unverified.length) return null;
  return { unverified, reason: formatBlockReason(unverified) };
}

/** Last assistant text blocks from a JSONL transcript tail. */
export function lastAssistantText(transcriptPath, readFile = readFileSync) {
  if (!transcriptPath) return '';
  let raw;
  try {
    raw = readFile(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  const tail = raw.length > TRANSCRIPT_TAIL_BYTES ? raw.slice(raw.length - TRANSCRIPT_TAIL_BYTES) : raw;
  const lines = tail.split('\n');
  if (raw.length > TRANSCRIPT_TAIL_BYTES) lines.shift(); // drop a torn first line
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || obj.type !== 'assistant') continue;
    const content = obj.message?.content;
    const texts = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      }
    } else if (typeof content === 'string') {
      texts.push(content);
    }
    if (texts.length) return texts.join('\n');
    // a tool-only assistant turn — keep scanning further back
  }
  return '';
}

function truthy(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function readStdin(timeoutMs) {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done('');
    let data = '';
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        done(data);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function main() {
  try {
    const hook = JSON.parse(await readStdin(250));
    const event = hook.hook_event_name ?? hook.hookEventName ?? '';
    const sessionId = hook.session_id ?? hook.sessionId ?? '';
    const path = ledgerPathFor(sessionId);

    if (event === 'PostToolUse') {
      appendLedger(path, harvestLedgerIds(hook));
      process.exit(0);
    }

    if (event !== 'Stop') process.exit(0);

    const verdict = evaluateStop({
      text: lastAssistantText(hook.transcript_path ?? hook.transcriptPath ?? ''),
      ledger: readLedger(path),
      stopHookActive: truthy(hook.stop_hook_active ?? hook.stopHookActive),
    });
    if (verdict) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }) + '\n');
    }
  } catch {
    // Fail open: a broken guard degrades to no guard, never to a blocked agent.
  }
  process.exit(0);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('artifact-url-delivery-guard.mjs');
if (invokedDirectly) main();
