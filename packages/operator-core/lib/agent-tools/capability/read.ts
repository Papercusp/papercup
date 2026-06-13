/**
 * capability:read — read a file, mirroring the native Read tool's ergonomics
 * (offset/limit line windowing, cat -n line numbers, long-line truncation).
 * Read-only, so it takes no file lock. Part of P-010
 * (`agent-capability-confinement-2026-06-13`).
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';

const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // refuse absurd reads outright

export default defineTool({
  name: 'capability:read',
  description:
    'Read a file (text) with line numbers, like the native Read tool. offset/limit window large files; long lines are truncated. Path is absolute or relative to the project dir.',
  guidance: {
    when: 'Read a source/text file before editing it, or to inspect content. Use offset+limit to page through a large file.',
    notWhen: 'To run a command, use capability:bash. To search across files, use capability:bash with grep/rg.',
    chaining: 'capability:read → capability:edit (exact string replace) or capability:write (overwrite).',
  },
  capability: 'capability:fs-read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    file_path: z.string().min(1).describe('Absolute path, or relative to the project dir.'),
    offset: z.number().int().nonnegative().optional().describe('1-based line to start from.'),
    limit: z.number().int().positive().optional().describe(`Max lines to read (default ${DEFAULT_LIMIT}).`),
  }),
  async handler(args, ctx) {
    const baseDir = ctx.projectDir ?? process.cwd();
    const abs = isAbsolute(args.file_path) ? args.file_path : resolve(baseDir, args.file_path);

    let raw: string;
    try {
      const st = statSync(abs);
      if (st.isDirectory()) return err('is_a_directory', `${abs} is a directory.`);
      if (st.size > MAX_FILE_BYTES) return err('too_large', `${abs} is ${st.size} bytes (> ${MAX_FILE_BYTES}). Read a slice with capability:bash (sed/head).`);
      raw = readFileSync(abs, 'utf8');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err('read_failed', msg);
    }

    const allLines = raw.split('\n');
    // A trailing newline yields a final empty element; drop it so line counts match the file.
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();

    const start = args.offset && args.offset > 0 ? args.offset - 1 : 0;
    const limit = args.limit ?? DEFAULT_LIMIT;
    const slice = allLines.slice(start, start + limit);

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

function err(reason: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, message }) }],
    isError: true,
  };
}
