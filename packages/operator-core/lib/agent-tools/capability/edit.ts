/**
 * capability:edit — exact-string replacement in a file, mirroring the native
 * Edit tool (old_string → new_string, replace_all). The body runs ONLY while
 * the per-path file lock is held (`guardFileLock`, P-013). Part of P-010
 * (`agent-capability-confinement-2026-06-13`).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { fileLockedResult, guardFileLock } from '../locks/file-lock-guard';
import { resolveCapabilityBaseDir } from './base-dir';

export default defineTool({
  name: 'capability:edit',
  description:
    'Exact string replacement in a file, like the native Edit tool. old_string must match exactly and (unless replace_all) be unique. Acquires the per-path file lock server-side before editing. Path is absolute or relative to the project dir.',
  guidance: {
    when: 'Make a targeted in-place change to an existing file. Include enough surrounding context in old_string to make it unique, or set replace_all.',
    notWhen: 'Creating a file or replacing it wholesale — use capability:write. Reading — use capability:read.',
    chaining: 'capability:read → capability:edit. On a file_locked result, wait/pivot/coordinate with the holder.',
  },
  capability: 'capability:fs-write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
  args: z.object({
    file_path: z.string().min(1).describe('Absolute path, or relative to the project dir.'),
    old_string: z.string().describe('The exact text to replace.'),
    new_string: z.string().describe('The replacement text (must differ from old_string).'),
    replace_all: z.boolean().optional().describe('Replace every occurrence (default false → require a unique match).'),
  }),
  async handler(args, ctx) {
    if (args.old_string === args.new_string) return err('no_op', 'old_string and new_string are identical.');
    const baseDir = resolveCapabilityBaseDir(ctx);
    const abs = isAbsolute(args.file_path) ? args.file_path : resolve(baseDir, args.file_path);

    const outcome = await guardFileLock(ctx, [args.file_path], { intent: 'capability:edit' }, async () => {
      let raw: string;
      try {
        raw = readFileSync(abs, 'utf8');
      } catch (e: unknown) {
        return err('read_failed', e instanceof Error ? e.message : String(e));
      }
      const count = occurrences(raw, args.old_string);
      if (count === 0) return err('not_found', `old_string not found in ${abs}.`);
      if (count > 1 && !args.replace_all) {
        return err('not_unique', `old_string matches ${count} times; pass replace_all or add surrounding context to make it unique.`);
      }
      const next = args.replace_all
        ? raw.split(args.old_string).join(args.new_string)
        : raw.replace(args.old_string, args.new_string);
      try {
        writeFileSync(abs, next, 'utf8');
      } catch (e: unknown) {
        return err('write_failed', e instanceof Error ? e.message : String(e));
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, path: abs, replacements: args.replace_all ? count : 1 }) }],
      };
    });

    return outcome.acquired ? outcome.result : await fileLockedResult(outcome.busy);
  },
});

function occurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

function err(reason: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, message }) }],
    isError: true,
  };
}
