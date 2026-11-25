/**
 * capability:patch — apply a set of exact-string hunks across SEVERAL files as one
 * all-or-nothing unit, under managed authority and the per-path file locks.
 *
 * Closes the adapter half of the `patch-notebook-adapters` gap inventoried by P-001
 * (`libs/papercusp/packages/orchestrator/src/managed-capability-contract.ts`, family
 * `edit-write-patch-notebook`). Its falsifier: "Hermetic and real-client tests prove
 * atomic multi-file patch and notebook semantics through managed authority and locks."
 *
 * Why this is not a loop of `capability:edit` calls. A caller looping single edits
 * holds each file's lock only for its own hunk, so a peer can interleave between
 * them, and a hunk that fails halfway leaves the earlier files already mutated — a
 * half-applied refactor on a shared checkout that typechecks nowhere and that no
 * single actor owns. This door takes EVERY target path's lock for the whole
 * operation and validates EVERY hunk before writing ANY file.
 *
 * Honest atomicity (plan D-005 — never claim equivalence the mechanism does not have):
 * this is validate-then-write with rollback, NOT a filesystem transaction. Every hunk
 * is resolved in memory first, so the ordinary failure (a stale or ambiguous
 * old_string) writes nothing at all. If a write fails midway — a disk or permission
 * fault after some files already landed — previously written files are restored from
 * their captured contents and the result says so via `rolledBack`. A rollback that
 * itself fails is reported per path rather than swallowed. The result never says
 * "atomic" without naming which of these happened.
 *
 * An entry is a change to an existing file (`old_string` / `new_string`) or a WHOLE file
 * (`content`: the file is created, or all of it replaced). Before whole files this door
 * could not create one, so an agent with several new files to write, a module and its
 * tests, say, had only `capability:write`, one file a call, where an agent with a plain
 * shell writes them all in one script and goes around the lock to do it. With whole files
 * here, any number of files are written and changed in ONE call under all their locks.
 * A whole file is held to `capability:write`'s own checks (write.ts): no glob in its path,
 * no empty text over existing bytes, no line-numbered read view written back. A rollback
 * removes a file the call created and restores one it replaced.
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { fileLockedResult, guardFileLock } from '../locks/file-lock-guard';
import { resolveCapabilityBaseDir } from './base-dir';
import { occurrences, spliceLiteral, squashWhitespace } from './text-splice';
import { replaceFileContents } from './replace-file';
import {
  emptyWriteWouldDestroy,
  findWritePathGlobMetacharacter,
  looksLikeDisplayFormattedRead,
  refuseRestrictedRuntimeWrite,
} from './write';

/** Bound the blast radius of one call; a larger refactor should be staged deliberately. */
const MAX_HUNKS = 100;

const hunkSchema = z.object({
  file_path: z.string().min(1).describe('Absolute path, or relative to the project dir.'),
  content: z.string().optional().describe('The WHOLE file: creates it, or replaces all of it. Instead of old_string and new_string.'),
  old_string: z.string().optional().describe('The exact text to replace in an existing file. With new_string.'),
  new_string: z.string().optional().describe('The replacement text (must differ from old_string).'),
  replace_all: z.boolean().optional().describe('Replace every occurrence in this file (default false → require a unique match).'),
});

type ResolvedEntry =
  | { index: number; abs: string; whole: true; content: string }
  | { index: number; abs: string; whole: false; old_string: string; new_string: string; replace_all: boolean };

export default defineTool({
  name: 'capability:patch',
  description:
    'Write and change several files as ONE all-or-nothing unit, holding every target path\'s file lock for the whole operation. Each entry is a whole file (content: creates it, or replaces all of it) or an exact-string change to an existing file (old_string, new_string). Every entry is validated before any file is written, so a stale or ambiguous old_string writes nothing. Use instead of looping capability:write or capability:edit.',
  guidance: {
    when: 'More than one file in one go — new files (a module and its tests), a rename across call sites, a signature change plus its callers, or new files together with the changes that use them.',
    notWhen: 'One file (capability:edit for a change, capability:write for the whole of it), or a notebook cell (capability:notebook_edit).',
    chaining: 'capability:read each changed passage verbatim → capability:patch → capability:inspect. On file_locked, no file was written; wait or coordinate with the holder.',
    seeAlso: ['capability:edit (one change in one file)', 'capability:write (one whole file)', 'capability:read (copy old_string exactly)'],
  },
  capability: 'capability:fs-write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    edits: z
      .array(hunkSchema)
      .min(1)
      .max(MAX_HUNKS)
      .describe('Whole files and changes to apply. Several may target the same file; they are applied in order against that file.'),
  }),
  async handler(args, ctx) {
    const baseDir = resolveCapabilityBaseDir(ctx);

    // Resolve to the paths we will ACTUALLY write and lock THOSE, never the raw
    // arguments (the same rule as edit.ts / write.ts — EI-20881501070735530).
    const resolved: ResolvedEntry[] = [];
    for (let i = 0; i < args.edits.length; i++) {
      const e = args.edits[i]!;
      const abs = isAbsolute(e.file_path) ? e.file_path : resolve(baseDir, e.file_path);
      if (e.content !== undefined) {
        if (e.old_string !== undefined || e.new_string !== undefined || e.replace_all !== undefined) {
          return err('invalid_entry', `edits[${i}]: give content (the whole file), or old_string and new_string (a change), not both.`);
        }
        const globMetacharacter = findWritePathGlobMetacharacter(e.file_path);
        if (globMetacharacter) {
          return err(
            'invalid_path',
            `edits[${i}]: file_path contains the glob metacharacter ${JSON.stringify(globMetacharacter)}; a whole file needs a concrete destination path.`,
          );
        }
        resolved.push({ index: i, abs, whole: true, content: e.content });
      } else if (e.old_string !== undefined && e.new_string !== undefined) {
        if (e.old_string === e.new_string) return err('no_op', `edits[${i}]: old_string and new_string are identical.`);
        resolved.push({ index: i, abs, whole: false, old_string: e.old_string, new_string: e.new_string, replace_all: e.replace_all === true });
      } else {
        return err('invalid_entry', `edits[${i}]: give content (the whole file), or both old_string and new_string (a change to an existing file).`);
      }
    }
    const paths = [...new Set(resolved.map((e) => e.abs))];
    // A path's first entry decides whether the file may be absent: a whole file creates it.
    const firstEntry = new Map<string, ResolvedEntry>();
    for (const e of resolved) if (!firstEntry.has(e.abs)) firstEntry.set(e.abs, e);

    // WI-10005589 / D-012 (BAR R-11), as capability:write and capability:edit refuse it: a
    // restricted session may not write a file the agent CLI executes.
    for (const p of paths) {
      const runtimeRefusal = await refuseRestrictedRuntimeWrite(ctx, p);
      if (runtimeRefusal) return runtimeRefusal;
    }

    const outcome = await guardFileLock(ctx, paths, { intent: `capability:patch (${paths.length} file(s))` }, async () => {
      // ---- Phase 1: read every target. Nothing is written in this phase. ----
      // `null` is a file that does not exist yet, which only a whole-file entry may start from.
      const original = new Map<string, string | null>();
      for (const p of paths) {
        try {
          original.set(p, readFileSync(p, 'utf8'));
        } catch (e: unknown) {
          const absent = (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';
          if (absent && firstEntry.get(p)!.whole) {
            original.set(p, null);
            continue;
          }
          return err(
            'read_failed',
            `${p}: ${e instanceof Error ? e.message : String(e)}` +
              (absent ? ' To create the file, give its whole text as content. No file was written.' : ''),
          );
        }
      }

      // ---- Phase 2: resolve EVERY entry in memory. One failure aborts the whole patch. ----
      const next = new Map<string, string | null>(original);
      const replacements = new Map<string, number>();
      for (const h of resolved) {
        const i = h.index;
        if (h.whole) {
          // capability:write's own refusals, judged against what is on disk now.
          const before = original.get(h.abs) ?? null;
          if (emptyWriteWouldDestroy(h.content, before === null ? null : Buffer.byteLength(before, 'utf8'))) {
            return err(
              'empty_overwrite_refused',
              `edits[${i}] (${h.abs}): refusing to replace existing text with empty content. To truncate a file on purpose use capability:write with allow_empty_overwrite. No file was written.`,
            );
          }
          if (looksLikeDisplayFormattedRead(h.content)) {
            return err(
              'display_formatted_content',
              `edits[${i}] (${h.abs}): the content looks like capability:read's line-numbered view, not file text. Read the source with capability:read { raw: true } and send that. No file was written.`,
            );
          }
          next.set(h.abs, h.content);
          continue;
        }
        const current = next.get(h.abs)!;
        const count = occurrences(current, h.old_string);
        if (count === 0) {
          return err('hunk_not_found', `edits[${i}] (${h.abs}): old_string not found.${diagnoseMiss(current, h)} No file was written.`);
        }
        if (count > 1 && !h.replace_all) {
          return err(
            'hunk_not_unique',
            `edits[${i}] (${h.abs}): old_string matches ${count} times; pass replace_all or add surrounding context. No file was written.`,
          );
        }
        next.set(h.abs, spliceLiteral(current, h.old_string, h.new_string, h.replace_all));
        replacements.set(h.abs, (replacements.get(h.abs) ?? 0) + (h.replace_all ? count : 1));
      }

      // ---- Phase 3: write. Every entry already validated, so this is the only failure left. ----
      const changed = paths.filter((p) => next.get(p) !== original.get(p));
      const created = changed.filter((p) => original.get(p) === null);
      const written: string[] = [];
      for (const p of changed) {
        try {
          if (original.get(p) === null) mkdirSync(dirname(p), { recursive: true });
          // Rename into place, never rewrite the inode: a running bash script reads the
          // file by byte offset (WI-10006772).
          replaceFileContents(p, next.get(p)!);
          written.push(p);
        } catch (e: unknown) {
          // A partial write is the one state this door must never leave behind silently.
          const rollback = restore(written, original);
          return err(
            'write_failed',
            `${p}: ${e instanceof Error ? e.message : String(e)}. ${
              rollback.failed.length === 0
                ? `Rolled back ${rollback.restored.length} already-written file(s); the tree is unchanged.`
                : `ROLLBACK INCOMPLETE — restored ${rollback.restored.length}, FAILED to restore: ${rollback.failed.join(', ')}. These files are mid-patch and need manual repair.`
            }`,
            { rolledBack: rollback.restored, rollbackFailed: rollback.failed },
          );
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              // Named, not asserted: this is validate-then-write, not a filesystem transaction.
              atomicity: 'validated-all-hunks-before-writing',
              hunks: resolved.length,
              filesLocked: paths.length,
              filesWritten: changed.length,
              filesCreated: created.length,
              files: changed.map((p) => ({
                path: p,
                replacements: replacements.get(p) ?? 0,
                ...(original.get(p) === null ? { created: true } : {}),
              })),
              unchanged: paths.filter((p) => !changed.includes(p)),
            }),
          },
        ],
      };
    });

    return outcome.acquired ? outcome.result : await fileLockedResult(outcome.busy, outcome.reader);
  },
});

/** Restore already-written files from their captured originals, removing the ones this call created. Reports both sides. */
function restore(written: readonly string[], original: ReadonlyMap<string, string | null>): { restored: string[]; failed: string[] } {
  const restored: string[] = [];
  const failed: string[] = [];
  for (const p of written) {
    try {
      const before = original.get(p) ?? null;
      if (before === null) rmSync(p, { force: true });
      else replaceFileContents(p, before);
      restored.push(p);
    } catch {
      failed.push(p);
    }
  }
  return { restored, failed };
}

/**
 * Failure-path only, so it costs no prompt weight. Same reasoning as edit.ts's
 * diagnosis (EI-20225459009961868): a bare "not found" leaves the caller unable to
 * separate "a peer changed it" from "my old_string was wrong", and on a shared
 * checkout they assume the first and retry. Here it matters more — one bad hunk
 * rejects the WHOLE patch, so the caller needs to know which hypothesis to act on.
 */
function diagnoseMiss(current: string, h: { old_string: string; new_string: string }): string {
  if (h.new_string !== '' && current.includes(h.new_string)) {
    return ' new_string is ALREADY present, so this hunk may have been applied already — re-read before retrying rather than re-applying.';
  }
  const near = occurrences(squashWhitespace(current), squashWhitespace(h.old_string));
  if (near > 0) {
    return ` A whitespace-insensitive match exists (${near}×), so the text IS present but its exact spacing/indentation differs — re-read the hunk with capability:read and copy it verbatim.`;
  }
  return '';
}

function err(reason: string, message: string, extra?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, message, ...extra }) }],
    isError: true,
  };
}
