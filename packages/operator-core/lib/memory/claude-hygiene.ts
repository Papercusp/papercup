/**
 * Read-only hygiene snapshot of the owner's Claude file-memory store
 * (memory-settings-page-refresh P-012).
 *
 * The SessionStart memory-compact hook keeps `MEMORY.md` (the always-
 * loaded index) under a hard byte cap by paging older entries out to
 * `MEMORY-overflow.md`. This module reports that pressure so the
 * settings memory page can surface a curation banner. Pure read — it
 * never writes the store, and a box without a Claude store (or with the
 * dir unreadable) reports `null` rather than inventing numbers.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { claudeProjectMemoryDir } from '@papercusp/memory';

export interface ClaudeHygiene {
  /** Topic files in the store (excluding indexes / archive). */
  activeCount: number;
  /** Entries paged out to MEMORY-overflow.md (0 = index holds everything). */
  overflowCount: number;
  /** Current MEMORY.md size in bytes. */
  indexBytes: number;
}

function resolveMemoryDir(): string {
  return (
    process.env.PAPERCUSP_CLAUDE_MEMORY_DIR ||
    claudeProjectMemoryDir(
      process.env.PAPERCUSP_CLAUDE_PROJECT_DIR || os.homedir(),
      path.join(os.homedir(), '.claude'),
    )
  );
}

/** Count index pointer lines (`- [Title](file.md) — hook`) in an index file. */
function countIndexEntries(markdown: string): number {
  return markdown.split('\n').filter((l) => /^\s*-\s+\[/.test(l)).length;
}

export async function readClaudeHygiene(
  memoryDir: string = resolveMemoryDir(),
): Promise<ClaudeHygiene | null> {
  try {
    const names = await fs.readdir(memoryDir);
    const topicFiles = names.filter(
      (n) => n.endsWith('.md') && !/^MEMORY(-overflow)?\.md$/i.test(n) && !n.startsWith('_'),
    );
    const indexBytes = await fs
      .stat(path.join(memoryDir, 'MEMORY.md'))
      .then((s) => s.size)
      .catch(() => 0);
    const overflowCount = await fs
      .readFile(path.join(memoryDir, 'MEMORY-overflow.md'), 'utf8')
      .then(countIndexEntries)
      .catch(() => 0);
    return { activeCount: topicFiles.length, overflowCount, indexBytes };
  } catch {
    return null; // no Claude store on this box
  }
}
