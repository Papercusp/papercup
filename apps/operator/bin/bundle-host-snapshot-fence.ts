/**
 * Post-build fence for a snapshot-labelled bundle (WI-6554700010048234).
 *
 * bundle_host_snapshot_commit names the working tree BEFORE esbuild runs, and
 * peers keep editing the shared tree during the build. The label is honest only
 * if every source file the compiler read still has the snapshot's bytes. This
 * compares each esbuild metafile input with its blob in the snapshot commit,
 * descending through submodule gitlinks. Ignored files and node_modules are
 * outside the source identity (as for a clean HEAD build) and are skipped; an
 * unignored file absent from the snapshot is a mismatch.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

export interface SnapshotInputFence { checked: number; skipped: number; mismatches: string[] }

const git = (cwd: string, args: string[], input?: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });

export function snapshotInputFence(root: string, commit: string, inputs: readonly string[]): SnapshotInputFence {
  const result: SnapshotInputFence = { checked: 0, skipped: 0, mismatches: [] };
  const candidates = inputs.filter(path => {
    const keep = path && !isAbsolute(path) && !path.startsWith('..') && !path.includes(':')
      && !path.split('/').includes('node_modules');
    if (!keep) result.skipped++;
    return keep;
  });
  const visit = (dir: string, rev: string, prefix: string, paths: string[]) => {
    const links = git(dir, ['ls-tree', '-r', '-z', rev]).split('\0').filter(Boolean)
      .filter(entry => entry.startsWith('160000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1))
      .sort((a, b) => b.length - a.length);
    const own: string[] = [];
    const bySub = new Map<string, string[]>();
    for (const path of paths) {
      const link = links.find(candidate => path.startsWith(`${candidate}/`));
      if (link) bySub.set(link, [...(bySub.get(link) ?? []), path.slice(link.length + 1)]);
      else own.push(path);
    }
    if (own.length > 0) {
      const expected = git(dir, ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
        own.map(path => `${rev}:${path}\n`).join('')).trimEnd().split('\n');
      const present = own.filter(path => existsSync(join(dir, path)));
      const actual = new Map(present.length === 0 ? [] : git(dir, ['hash-object', '--stdin-paths'],
        present.map(path => `${path}\n`).join('')).trimEnd().split('\n').map((sha, i) => [present[i], sha]));
      own.forEach((path, i) => {
        const [sha, type] = expected[i].split(' ');
        if (type === 'blob') {
          result.checked++;
          if (actual.get(path) !== sha) result.mismatches.push(prefix + path);
          return;
        }
        let ignored = false;
        try { git(dir, ['check-ignore', '-q', '--no-index', path]); ignored = true; } catch { /* not ignored */ }
        if (ignored || !actual.has(path)) result.skipped++;
        else result.mismatches.push(prefix + path);
      });
    }
    for (const [link, subPaths] of bySub) {
      const sha = git(dir, ['rev-parse', `${rev}:${link}`]).trim();
      visit(join(dir, link), sha, `${prefix}${link}/`, subPaths);
    }
  };
  visit(root, git(root, ['rev-parse', '--verify', `${commit}^{commit}`]).trim(), '', candidates);
  return result;
}

// CLI for bundle-host.sh, run right after esbuild (Node strips the types):
//   node bundle-host-snapshot-fence.ts <repo root> <snapshot sha> <metafile> <receipt out>
// Exit 0 = every input matches · 75 (EX_TEMPFAIL) = inputs moved (re-snapshot and rebuild) ·
// 2 = fence error. "Moved" is not 1, so a node crash (exit 1) can never read as a retryable race.
export const FENCE_EXIT_MOVED = 75;
if (isCliEntry(import.meta.url)) {
  const [root, commit, metafile, out] = process.argv.slice(2);
  try {
    if (!root || !commit || !metafile || !out) throw new Error('usage: <repo root> <snapshot sha> <metafile> <receipt out>');
    const graph = JSON.parse(readFileSync(metafile, 'utf8')) as { inputs?: Record<string, unknown> };
    const fence = snapshotInputFence(root, commit, Object.keys(graph.inputs ?? {}));
    writeFileSync(out, `${JSON.stringify({ sha: commit, ...fence })}\n`);
    if (fence.checked === 0) throw new Error('snapshot fence compared no compiler inputs');
    if (fence.mismatches.length > 0) {
      console.error(`compiler inputs moved after source snapshot ${commit}: ${fence.mismatches.slice(0, 10).join(', ')}`);
      process.exitCode = FENCE_EXIT_MOVED;
    } else console.log(`✓ snapshot fence: ${fence.checked} compiler inputs match source snapshot ${commit}`);
  } catch (error) {
    console.error(`ERROR: snapshot fence failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
