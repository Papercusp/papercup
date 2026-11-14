#!/usr/bin/env node
/**
 * stop-toolless-mcp-hint — the in-session self-heal hint for a connected-but-TOOLLESS
 * papercusp MCP connection (layer C of WI-6554700010048116; WI-6554700010048155).
 *
 * THE FAILURE: a psu Claude session's MCP client keeps the server "connected" while its
 * tool list is gone, so every papercusp call answers
 *   `<tool_use_error>Error: No such tool available: mcp__papercusp-su__tools_invoke. Its MCP
 *    server 'papercusp-su' is connected but does not offer this tool here…</tool_use_error>`
 * The agent reads that as "this tool does not exist", ends its turn, and the session sits
 * mute. The break glass (`node scripts/mcp-reconnect.mjs` from native Bash) exists, but an
 * agent that never connects the symptom to it never runs it.
 *
 * WHY A Stop HOOK: Claude never fires PostToolUseFailure for an UNKNOWN tool (the call is
 * refused before dispatch), and the miss is usually the last thing before the turn ends.
 * So at Stop this reads the transcript tail and, when the misses show a toolless
 * connection, blocks ONCE with the exact recovery steps.
 *
 * WHEN IT FIRES — misses counted only AFTER the last papercusp result that was NOT an
 * unknown-tool refusal (a real result, even a server error, proves the list is there) and
 * AFTER any native Bash call that ran mcp-reconnect:
 *   (a) floor: a miss names a REACHABILITY-FLOOR tool (tools_find / tools_invoke). Every
 *       trimmed psu launch carries both, so their absence is a dropped list, not a trim.
 *   (b) multi: >=2 DISTINCT papercusp tools missed. Softer advice: retry via tools:invoke
 *       first, reconnect only if that is missing too.
 * One non-floor miss NEVER fires: on a trimmed surface that is an unseeded or invented name
 * (live samples: `capability_read`, `coord_read`) with the connection healthy around it.
 * The seed list is deliberately NOT mirrored here — the live surface differs from
 * psu-launcher.mjs CLAUDE_MINIMAL_SEED_TOOL_NAMES, and the floor is the one guaranteed part.
 *
 * BOUNDED: Claude sets `stop_hook_active` on the continuation our block causes (early
 * return), and the last-warned miss id is cached per owner, so one miss episode bounces at
 * most one turn.
 *
 * FAIL-SILENT: no PAPERCUSP_SID, a nested CLI, an unreadable transcript, any exception —
 * each ends the turn normally with no output. Purely local: no operator call, because the
 * operator is usually healthy while this session's client is not.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sessionId } from '../inject/core.mjs';
// WI-10004945: a CLI nested inside another agent inherits its PAPERCUSP_SID; its
// transcript is not the su's, and its Stop must not be bounced on the su's behalf.
import { nestedCliCached } from './pc_nested_cli.mjs';

export { nestedCliCached };

/** How much of the transcript end is scanned. */
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

/** The tools every trimmed psu launch carries; a miss on one is definitive. */
export const REACHABILITY_FLOOR_VERBS = Object.freeze(['tools_find', 'tools_invoke']);

const MISS_RE = /No such tool available: (mcp__papercusp[\w-]*__([\w-]+))/;
const PAPERCUSP_TOOL_RE = /^mcp__papercusp[\w-]*__[\w-]+$/;

/** @param {unknown} v */
function truthy(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/**
 * The last `maxBytes` of a file, with a torn first line dropped. '' when unreadable.
 * @param {string} path
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function readTranscriptTail(path, maxBytes = TRANSCRIPT_TAIL_BYTES) {
  if (!path) return '';
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * The text of a tool_result block (string content or text parts).
 * @param {Record<string, unknown>} block
 * @returns {string}
 */
export function toolResultText(block) {
  const c = block?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  return '';
}

/**
 * @typedef {{ toolUseId: string, tool: string, verb: string }} Miss
 */

/**
 * The current miss episode in a JSONL transcript: unknown-tool refusals for papercusp tools
 * since the last real papercusp result or native mcp-reconnect run.
 * @param {string} raw
 * @returns {Miss[]}
 */
export function scanTranscript(raw) {
  /** @type {Map<string, string>} */
  const toolNames = new Map();
  /** @type {Miss[]} */
  let misses = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    if (obj.type === 'assistant') {
      for (const b of content) {
        if (b?.type !== 'tool_use' || typeof b.id !== 'string') continue;
        toolNames.set(b.id, String(b.name ?? ''));
        const cmd = b.input?.command;
        if (b.name === 'Bash' && typeof cmd === 'string' && cmd.includes('mcp-reconnect')) misses = [];
      }
    } else if (obj.type === 'user') {
      for (const b of content) {
        if (b?.type !== 'tool_result') continue;
        const text = toolResultText(b);
        const m = MISS_RE.exec(text);
        if (m && (b.is_error === true || /^\s*<tool_use_error>/.test(text))) {
          misses.push({ toolUseId: String(b.tool_use_id ?? ''), tool: m[1], verb: m[2] });
          continue;
        }
        const name = toolNames.get(String(b.tool_use_id ?? ''));
        if (name && PAPERCUSP_TOOL_RE.test(name)) misses = [];
      }
    }
  }
  return misses;
}

/**
 * Whether a miss episode shows a toolless connection.
 * @param {Miss[]} misses
 * @returns {{ kind: 'floor' | 'multi', tools: string[], latestMissId: string } | null}
 */
export function classifyEpisode(misses) {
  if (!misses.length) return null;
  const tools = [...new Set(misses.map((m) => m.tool))];
  const latestMissId = misses[misses.length - 1].toolUseId;
  if (misses.some((m) => REACHABILITY_FLOOR_VERBS.includes(m.verb))) return { kind: 'floor', tools, latestMissId };
  if (tools.length >= 2) return { kind: 'multi', tools, latestMissId };
  return null;
}

const RECOVERY =
  'run `node scripts/mcp-reconnect.mjs` from NATIVE Bash (if Bash is deferred, load it first with ' +
  'ToolSearch `select:Bash`), then END THIS TURN so the host re-dials the server. If it exits 3 ' +
  '(this host cannot force a reconnect), run the carry-respawn command it prints instead. Do not ' +
  'ask the owner to run /mcp, and do not conclude the tools do not exist.';

/**
 * The block reason for a classified episode.
 * @param {{ kind: 'floor' | 'multi', tools: string[] }} verdict
 * @returns {string}
 */
export function formatReason(verdict) {
  const named = verdict.tools.map((t) => `\`${t}\``).join(', ');
  if (verdict.kind === 'floor') {
    return (
      `⟦toolless-mcp⟧ Your papercusp MCP connection is TOOLLESS: ${named} answered "No such tool ` +
      'available", and tools_find / tools_invoke are on every psu launch. This is a dropped tool ' +
      `list, not a missing tool, and it will not heal by itself. Before ending this turn: ${RECOVERY}`
    );
  }
  return (
    `⟦toolless-mcp⟧ ${verdict.tools.length} distinct papercusp tools (${named}) answered "No such tool ` +
    'available" since your last successful papercusp call. A trimmed surface exposes only a seed, so ' +
    "first retry through `tools:invoke { name: '<group:verb>', args }` (colon form). If tools_invoke " +
    `ITSELF is missing, the connection is toolless: ${RECOVERY}`
  );
}

/**
 * Where the per-owner dedupe marker lives (the activity hook's cache-dir convention).
 * @param {NodeJS.ProcessEnv} env
 */
export function defaultCacheDir(env = process.env) {
  return env.PAPERCUSP_LOCKS_CACHE_DIR || join(env.HOME || homedir(), '.papercusp', 'locks-cache');
}

/** @param {string} owner */
function markerName(owner) {
  return `toolless-mcp-hint-${String(owner).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200)}.json`;
}

/**
 * The block reason for this Stop, or null to let the turn end.
 * @param {{ hook: Record<string, unknown>, env?: NodeJS.ProcessEnv, isNested?: () => boolean, cacheDir?: string, readTail?: (path: string) => string }} input
 * @returns {string | null}
 */
export function evaluateStop({ hook, env = process.env, isNested = nestedCliCached, cacheDir, readTail = readTranscriptTail }) {
  if (truthy(hook.stop_hook_active ?? hook.stopHookActive)) return null;
  const owner = sessionId(env);
  if (!owner) return null;
  if (isNested()) return null;
  const transcriptPath = hook.transcript_path ?? hook.transcriptPath;
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const verdict = classifyEpisode(scanTranscript(readTail(transcriptPath)));
  if (!verdict) return null;
  const dir = cacheDir ?? defaultCacheDir(env);
  const marker = join(dir, markerName(owner));
  try {
    if (JSON.parse(readFileSync(marker, 'utf8'))?.lastWarnedMissId === verdict.latestMissId) return null;
  } catch {
    /* no marker yet */
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${marker}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastWarnedMissId: verdict.latestMissId, at: new Date().toISOString() }));
    renameSync(tmp, marker);
  } catch {
    /* an unwritable cache only loses the dedupe; stop_hook_active still bounds the bounce */
  }
  return formatReason(verdict);
}

/**
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
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
    const raw = await readStdin(250);
    const hook = raw.trim() ? JSON.parse(raw) : {};
    const reason = evaluateStop({ hook });
    if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  } catch {
    // Fail silent: a broken check degrades to no check, never to a blocked agent.
  }
  process.exit(0);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('stop-toolless-mcp-hint.mjs');
if (invokedDirectly) main();
