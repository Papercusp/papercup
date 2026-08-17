/**
 * capability:read — read a file, mirroring the native Read tool's ergonomics
 * (offset/limit line windowing, cat -n line numbers, long-line truncation).
 * Read-only, so it takes no file lock. Part of P-010
 * (`agent-capability-confinement-2026-06-13`).
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCapabilityBaseDir } from './base-dir';
import { CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';

/**
 * Exported so the bash-substitution audit can PIN its model to it
 * (`pairs/model-drift.test.ts`, WI-6157/D-015). `pairs/file-read.ts` scores
 * `head`/`cat` coverage against a hand-copied `READ_DEFAULT_LIMIT`; if this
 * default changes and the copy does not, the audit emits `capability:read`
 * expressions that silently read a different number of lines than the bash
 * they claim to replace.
 */
export const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // refuse absurd reads outright
export const MAX_BYTE_PAGE = 4_096;

/** base64 encodes 3 bytes as 4 chars, padded up to the next multiple of 4. */
function base64Chars(byteCount: number): number {
  return Math.ceil(byteCount / 3) * 4;
}

/** Slack for JSON escaping inside `file_path` and for door-budget arithmetic we
 *  do not want to depend on to the last character. */
const DOOR_MARGIN_CHARS = 256;

/** Never page so small that recovery becomes absurd, even on a pathological path. */
const MIN_PAGE_BYTES = 512;

/**
 * WI-39670: the largest page whose base64 payload PLUS this response's own
 * envelope still fits the `resultEach` door.
 *
 * Every tool result passes that door, and an over-budget result is projected —
 * for this tool that means `data` is truncated MID-BASE64. Decoding the result
 * then yields a valid plaintext prefix followed by `invalid input`, i.e. silent
 * corruption of the byte-window recovery path, with `ok:true`, `eof:false` and a
 * well-formed `next_cursor` all still looking healthy. `MAX_BYTE_PAGE` (4096)
 * alone is 5464 chars of base64 — already over the 6000-char door once the
 * envelope is counted, so the maximum page the schema ADVERTISES could never be
 * returned intact.
 *
 * The envelope is measured, not guessed, because `file_path` is absolute and
 * appears TWICE (top level and again in `next_cursor.args`) — a deep scratch path
 * moves this by hundreds of chars, which is why a fixed smaller constant would
 * only move the cliff rather than remove it. Clamping is lossless: `byte_length`
 * and `next_cursor` describe the page actually returned, so paging simply takes
 * more steps.
 */
export function doorSafePageBytes(absPath: string, requestedBytes: number): number {
  const envelopeChars = JSON.stringify({
    ok: true,
    file_path: absPath,
    encoding: 'base64',
    byte_offset: Number.MAX_SAFE_INTEGER,
    byte_length: Number.MAX_SAFE_INTEGER,
    total_bytes: Number.MAX_SAFE_INTEGER,
    eof: false,
    data: '',
    next_cursor: {
      tool: 'capability:read',
      args: { file_path: absPath, byte_offset: Number.MAX_SAFE_INTEGER, byte_limit: MAX_BYTE_PAGE },
    },
  }).length;
  // Mirrors how RESULT_DOOR_TOKENS is derived (result-door.ts): the BAKED floor
  // door. A session configured with a WIDER door just gets smaller pages than it
  // strictly needs, which is safe; sizing to a wider door would not be.
  const budgetChars = computeTurnDoors(0).resultEach * CHARS_PER_TOKEN_ESTIMATE;
  const room = budgetChars - envelopeChars - DOOR_MARGIN_CHARS;
  const fits = Math.floor(Math.max(0, room) / 4) * 3;
  return Math.max(MIN_PAGE_BYTES, Math.min(requestedBytes, fits));
}

export default defineTool({
  name: 'capability:read',
  description:
    'Read a file with line-numbered text windows, or exact resumable byte pages. offset/limit window lines; tail:N reads the last N lines. byte_offset+byte_limit returns base64 bytes with a next cursor, including for a single very long line. Path is absolute, ~/-relative, or relative to the project dir.',
  guidance: {
    when: 'Read a source/text file before editing it, or inspect content. Use offset+limit for line pages, tail:N for a log tail, and byte_offset+byte_limit when exact resumable bytes matter or the file may be one long line.',
    notWhen: 'To run a command, use capability:bash. To search across files, use capability:bash with grep/rg.',
    chaining: 'capability:read → capability:edit (exact string replace) or capability:write (overwrite).',
    seeAlso: [
      'capability:edit (exact-string edit)',
      'capability:write (overwrite / create)',
      'capability:bash (grep / rg to search across files)',
    ],
  },
  capability: 'capability:fs-read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    file_path: z.string().min(1).describe('Absolute path, ~/-relative, or relative to the project dir.'),
    offset: z.number().int().nonnegative().optional().describe('1-based line to start from.'),
    limit: z.number().int().positive().optional().describe(`Max lines to read (default ${DEFAULT_LIMIT}).`),
    tail: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Read the LAST N lines instead of reading forward — the `tail -n N` equivalent. Ignores offset.'),
    byte_offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('0-based byte offset for an exact base64 page. Use with byte_limit; mutually exclusive with line offset/limit/tail.'),
    byte_limit: z
      .number()
      .int()
      .positive()
      .max(MAX_BYTE_PAGE)
      .optional()
      .describe(
        `Bytes to return as base64 (max ${MAX_BYTE_PAGE}), an UPPER BOUND — the page is clamped to ` +
        `fit the result door, so read byte_length and follow next_cursor. Use with byte_offset.`,
      ),
  }),
  async handler(args, ctx) {
    const baseDir = resolveCapabilityBaseDir(ctx);
    const abs = resolveReadPath(args.file_path, baseDir);

    let bytes: Buffer;
    try {
      const st = statSync(abs);
      if (st.isDirectory()) return err('is_a_directory', `${abs} is a directory.`);
      if (st.size > MAX_FILE_BYTES) return err('too_large', `${abs} is ${st.size} bytes (> ${MAX_FILE_BYTES}). Read a slice with capability:bash (sed/head).`);
      bytes = readFileSync(abs);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err('read_failed', msg);
    }

    const byteMode = args.byte_offset !== undefined || args.byte_limit !== undefined;
    if (byteMode) {
      if (args.byte_offset === undefined || args.byte_limit === undefined) {
        return err('invalid_byte_window', 'byte_offset and byte_limit must be supplied together.');
      }
      if (args.offset !== undefined || args.limit !== undefined || args.tail !== undefined) {
        return err('mixed_window_modes', 'byte_offset/byte_limit cannot be combined with offset/limit/tail.');
      }
      const start = Math.min(args.byte_offset, bytes.length);
      // WI-39670: clamp to what survives the resultEach door. Requesting the
      // schema's max would otherwise return base64 the door truncates mid-string.
      const effectiveLimit = doorSafePageBytes(abs, args.byte_limit);
      const page = bytes.subarray(start, Math.min(bytes.length, start + effectiveLimit));
      const nextOffset = start + page.length;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            file_path: abs,
            encoding: 'base64',
            byte_offset: start,
            byte_length: page.length,
            total_bytes: bytes.length,
            eof: nextOffset >= bytes.length,
            data: page.toString('base64'),
            // Echo the EFFECTIVE limit, not the caller's: a cursor that keeps
            // asking for a size this tool will not honour reads as though the
            // page were the caller's to choose, and invites the same over-large
            // request every hop.
            next_cursor: nextOffset < bytes.length
              ? { tool: 'capability:read', args: { file_path: abs, byte_offset: nextOffset, byte_limit: effectiveLimit } }
              : null,
          }),
        }],
      };
    }

    const raw = bytes.toString('utf8');

    const allLines = raw.split('\n');
    // A trailing newline yields a final empty element; drop it so line counts match the file.
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();

    const limit = args.limit ?? DEFAULT_LIMIT;
    // `tail` addresses the END of the file, which offset (anchored at line 1)
    // cannot reach without first knowing the line count. The 2026-07-26 bash
    // audit found this was the single largest un-substitutable file read:
    // 1,752 `tail -n N FILE` atoms across 63 sessions had no tool form at all.
    const start = args.tail
      ? Math.max(0, allLines.length - args.tail)
      : args.offset && args.offset > 0
        ? args.offset - 1
        : 0;
    const slice = allLines.slice(start, start + (args.tail ? Math.min(args.tail, limit) : limit));

    const numbered = slice
      .map((line, i) => {
        const n = start + i + 1;
        const truncated = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line;
        return `${String(n).padStart(6)}\t${truncated}`;
      })
      .join('\n');

    const more = start + slice.length < allLines.length;
    const footer = more
      ? `\n\n… [${allLines.length - (start + slice.length)} more lines — re-read with offset=${start + slice.length + 1}]`
      : '';
    const head = `${abs} (${allLines.length} lines${start > 0 || more ? `, showing ${start + 1}–${start + slice.length}` : ''})\n`;

    return {
      content: [{ type: 'text' as const, text: slice.length === 0 ? `${head}(empty)` : head + numbered + footer }],
    };
  },
});

/**
 * Resolve a caller-supplied path to an absolute one.
 *
 * `~/…` must be expanded explicitly: it is a SHELL feature, so Node sees it as
 * a relative path and `resolve(baseDir, '~/x')` silently yields
 * `<projectDir>/~/x` — a file that does not exist, reported as a confusing
 * read_failed rather than as the home-relative read the caller meant. The
 * 2026-07-26 bash audit caught this against real commands (`cat ~/.papercusp/…`,
 * `head -40 ~/mac-verify-build-waiter.sh`).
 */
export function resolveReadPath(filePath: string, baseDir: string): string {
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/')) return resolve(homedir(), filePath.slice(2));
  return isAbsolute(filePath) ? filePath : resolve(baseDir, filePath);
}

function err(reason: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, message }) }],
    isError: true,
  };
}
