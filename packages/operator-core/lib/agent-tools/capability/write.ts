/**
 * capability:write — write (create/overwrite) a file, mirroring the native
 * Write tool. The body runs ONLY while the per-path file lock is held
 * (`guardFileLock`, P-013) — the server-side replacement for the client
 * PreToolUse lock hook, so a fleet agent's write serializes with every other
 * agent (SU sessions included) on the same physical file. Part of P-010
 * (`agent-capability-confinement-2026-06-13`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { fileLockedResult, guardFileLock } from '../locks/file-lock-guard';
import { resolveCapabilityBaseDir } from './base-dir';

const GLOB_METACHARS = new Set(['*', '?', '[', ']']);

/**
 * Return the first glob metacharacter in a destination path, if any.
 *
 * capability:write takes one concrete destination, not a shell/pathspec glob.
 * Letting a glob-shaped argument through creates a literal file whose name is
 * usually the serialized tool-call payload's own source path (EI-21390906760757289).
 */
export function findWritePathGlobMetacharacter(filePath: string): string | null {
  for (const character of filePath) {
    if (GLOB_METACHARS.has(character)) return character;
  }
  return null;
}

export default defineTool({
  name: 'capability:write',
  description:
    'Write a file (create or overwrite) like the native Write tool. Acquires the per-path file lock server-side before writing (busy → returns who holds it). Path is absolute or relative to the project dir.',
  guidance: {
    when: 'Create a new file, or fully replace an existing one. For a partial change to an existing file prefer capability:edit.',
    notWhen: 'A small in-place change — use capability:edit (exact string replacement). Reading first — use capability:read.',
    chaining: 'capability:read (if overwriting) → capability:write. On a file_locked result, wait/pivot/coordinate with the holder.',
    seeAlso: [
      'capability:read (read before overwriting)',
      'capability:edit (surgical edit instead of overwrite)',
    ],
  },
  capability: 'capability:fs-write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    file_path: z.string().min(1).describe('Absolute path, or relative to the project dir.'),
    content: z.string().describe('Full file content to write (overwrites any existing file).'),
  }),
  async handler(args, ctx) {
    const globMetacharacter = findWritePathGlobMetacharacter(args.file_path);
    if (globMetacharacter) {
      return invalidPath(
        `file_path contains the glob metacharacter ${JSON.stringify(globMetacharacter)}; capability:write requires a concrete destination path`,
      );
    }
    const baseDir = resolveCapabilityBaseDir(ctx);
    const abs = isAbsolute(args.file_path) ? args.file_path : resolve(baseDir, args.file_path);

    // Lock the path we are ACTUALLY going to write (`abs`), never the raw argument —
    // handing the guard a relative path makes it re-resolve against its own base, and
    // any disagreement between the two resolutions keys the lock off a file this
    // handler never touches (EI-20881501070735530).
    const outcome = await guardFileLock(ctx, [abs], { intent: 'capability:write' }, async () => {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, args.content, 'utf8');
      const bytes = Buffer.byteLength(args.content, 'utf8');
      const lines = args.content === '' ? 0 : args.content.split('\n').length;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, path: abs, bytes, lines }) }] };
    });

    return outcome.acquired ? outcome.result : await fileLockedResult(outcome.busy, outcome.reader);
  },
});

function invalidPath(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'invalid_path', message }) }],
    isError: true,
  };
}
