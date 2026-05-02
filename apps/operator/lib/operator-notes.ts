/**
 * Operator-notes — feature-scoped guidance the user writes to steer a worker.
 *
 * Lives at `<projectDir>/.harness/notes/<featureId>.md`. The worker prompt's
 * Required Reads list pulls this file on each invocation. Notes are append-only
 * (newest block at the bottom) so the worker sees an accumulating timeline; older
 * blocks remain readable as audit trail.
 *
 * Format mirrors `.harness/supervisor-notes.md`:
 *
 *   ## <author> <ISO-8601 timestamp>
 *
 *   <body, free-form markdown>
 *
 * Each block separated by a blank line.
 *
 * This is the Phase A "Steer" primitive — async guidance the worker reads on
 * its next dispatch. No new agent invocation; no new UI surface beyond a
 * write endpoint. Phase B (real-time chat) is a separate primitive.
 */
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadHarnessRegistry } from '@/lib/harness-registry';

export interface OperatorNoteBlock {
  /** Author identifier — typically 'user' but could be a tool slug. */
  author: string;
  /** ISO-8601 timestamp when the block was written. */
  ts: string;
  /** Body content (unparsed markdown). */
  body: string;
}

export interface ReadOperatorNotesResult {
  /** Raw file contents (empty string if file doesn't exist). */
  raw: string;
  /** Parsed blocks, oldest first. */
  blocks: OperatorNoteBlock[];
}

/** Resolve harness slug → project directory via the registry file. */
export function projectDirForSlug(slug: string): string | null {
  return loadHarnessRegistry().projects.find((p) => p.slug === slug)?.path ?? null;
}

/** `<projectDir>/.harness/notes/<featureId>.md` — the canonical location. */
export function notesPathFor(projectDir: string, featureId: string): string {
  return join(projectDir, '.harness', 'notes', `${featureId}.md`);
}

/**
 * Append an operator note block. Creates `<projectDir>/.harness/notes/`
 * if it doesn't exist. Idempotent against directory creation.
 *
 * Returns the absolute path of the file written.
 */
export async function appendOperatorNote(opts: {
  slug: string;
  featureId: string;
  content: string;
  author?: string;
}): Promise<{ path: string; ts: string } | { error: string }> {
  const { slug, featureId, content, author = 'user' } = opts;

  if (!content || !content.trim()) return { error: 'content is required' };
  if (!/^F-[A-Z0-9-]+$/i.test(featureId)) return { error: `invalid featureId: ${featureId}` };

  const projectDir = projectDirForSlug(slug);
  if (!projectDir) return { error: `harness "${slug}" not registered` };

  const notesDir = join(projectDir, '.harness', 'notes');
  await mkdir(notesDir, { recursive: true });

  const filePath = notesPathFor(projectDir, featureId);
  const ts = new Date().toISOString();

  // Block prefix gets a leading newline only if file already has content; this
  // avoids a double-blank-line at file start while keeping blocks separated.
  const exists = existsSync(filePath);
  const prefix = exists ? '\n\n' : '';
  const block = `${prefix}## ${author} ${ts}\n\n${content.trim()}\n`;

  if (exists) {
    await appendFile(filePath, block, 'utf8');
  } else {
    await writeFile(filePath, block, 'utf8');
  }

  return { path: filePath, ts };
}

/**
 * Parse a notes file into blocks. The header regex matches `## <author> <ISO ts>`
 * lines; bodies run from one header to the next. Returns blocks oldest first.
 */
export function parseNotes(raw: string): OperatorNoteBlock[] {
  const blocks: OperatorNoteBlock[] = [];
  if (!raw.trim()) return blocks;

  // Header: `## <author> <ISO timestamp>` at start of line.
  // Author can contain word chars, hyphens, dots, @, slash. Timestamp is ISO 8601.
  const headerRe = /^## (\S+) (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s*$/gm;
  const headers: { author: string; ts: string; bodyStart: number; headerEnd: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(raw)) !== null) {
    headers.push({
      author: m[1],
      ts: m[2],
      headerEnd: m.index + m[0].length,
      bodyStart: m.index + m[0].length,
    });
  }
  for (let i = 0; i < headers.length; i++) {
    const next = headers[i + 1];
    const start = headers[i].headerEnd;
    const end = next ? raw.indexOf(`## ${next.author} ${next.ts}`, start) : raw.length;
    blocks.push({
      author: headers[i].author,
      ts: headers[i].ts,
      body: raw.slice(start, end).trim(),
    });
  }
  return blocks;
}

/**
 * Read all operator notes for a feature. Returns `{ raw: '', blocks: [] }`
 * when the file doesn't exist (not an error — feature simply has no notes).
 */
export function readOperatorNotes(slug: string, featureId: string): ReadOperatorNotesResult | { error: string } {
  if (!/^F-[A-Z0-9-]+$/i.test(featureId)) return { error: `invalid featureId: ${featureId}` };
  const projectDir = projectDirForSlug(slug);
  if (!projectDir) return { error: `harness "${slug}" not registered` };
  const filePath = notesPathFor(projectDir, featureId);
  if (!existsSync(filePath)) return { raw: '', blocks: [] };
  const raw = readFileSync(filePath, 'utf8');
  return { raw, blocks: parseNotes(raw) };
}
