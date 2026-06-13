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
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { fileLockedResult, guardFileLock } from '../locks/file-lock-guard';

export default defineTool({
  name: 'capability:write',
  description:
    'Write a file (create or overwrite) like the native Write tool. Acquires the per-path file lock server-side before writing (busy → returns who holds it). Path is absolute or relative to the project dir.',
  guidance: {
    when: 'Create a new file, or fully replace an existing one. For a partial change to an existing file prefer capability:edit.',
    notWhen: 'A small in-place change — use capability:edit (exact string replacement). Reading first — use capability:read.',
    chaining: 'capability:read (if overwriting) → capability:write. On a file_locked result, wait/pivot/coordinate with the holder.',
  },
  capability: 'capability:fs-write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    file_path: z.string().min(1).describe('Absolute path, or relative to the project dir.'),
    content: z.string().describe('Full file content to write (overwrites any existing file).'),
  }),
  async handler(args, ctx) {
    const baseDir = ctx.projectDir ?? process.cwd();
    const abs = isAbsolute(args.file_path) ? args.file_path : resolve(baseDir, args.file_path);

    const outcome = await guardFileLock(ctx, [args.file_path], { intent: 'capability:write' }, async () => {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, args.content, 'utf8');
      const bytes = Buffer.byteLength(args.content, 'utf8');
      const lines = args.content === '' ? 0 : args.content.split('\n').length;
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, path: abs, bytes, lines }) }] };
    });

    return outcome.acquired ? outcome.result : await fileLockedResult(outcome.busy);
  },
});
