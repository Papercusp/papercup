import type { GitRunner } from '../harness/docs/subject-ref';
import type { FootprintCommit, FootprintCommitWindow } from './footprint';

/** Work per Git read, never the size of the reconciled census. */
export const FOOTPRINT_COMMITS_PER_PAGE = 500;
const RECORD_SEPARATOR = '\u001e';

/** Parse `git log --format=%x1e%H --name-only` output into commits (oldest first). */
export function parseNameOnlyLog(stdout: string): FootprintCommit[] {
  const commits: FootprintCommit[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    const lines = record.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const [sha, ...paths] = lines;
    if (!/^[0-9a-f]{7,64}$/i.test(sha!)) continue;
    commits.push({ sha: sha!, paths });
  }
  return commits.reverse();
}

export async function readFootprintCommitWindow(
  input: { root: string; headSha: string; range: string[] },
  runGit: GitRunner,
): Promise<FootprintCommitWindow> {
  const pages: FootprintCommit[][] = [];
  let offset = 0;
  // Pin the range and drain every page before publishing a watermark/finding.
  // A failed drain throws: the durable pre-census watermark remains retryable
  // after restart. Topological order keeps offsets stable despite clock skew.
  for (;;) {
    const log = await runGit([
      'log', '--topo-order', '--no-renames', '--format=%x1e%H', '--name-only',
      `--max-count=${FOOTPRINT_COMMITS_PER_PAGE}`, `--skip=${offset}`, ...input.range,
    ], input.root);
    if (log.code !== 0) {
      throw new Error(`spec-conformance footprint: git log failed (${log.code}) at offset ${offset}: ${log.stderr.trim().slice(0, 300)}`);
    }
    const page = parseNameOnlyLog(log.stdout);
    pages.push(page);
    if (page.length < FOOTPRINT_COMMITS_PER_PAGE) break;
    offset += page.length;
  }
  // Each page is oldest first, but Git supplies the newest page first.
  return { headSha: input.headSha, commits: pages.reverse().flat() };
}
