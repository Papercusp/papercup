/**
 * chunked-blob-scan.ts — bounded, batched reading of new blobs for the G-10
 * secrets guards.
 *
 * Extracted from publish-guard.ts (WI-6254) so that its SIBLING guard,
 * foreign-mirror-quarantine.ts (WI-6258), gets the same bound from the same
 * code rather than a second copy. The `cat-file --batch` frame parser below is
 * byte-exact and easy to get subtly wrong; two independently-maintained copies
 * of it is precisely the drift this module exists to prevent.
 *
 * The two callers differ in what they are protecting:
 *   - publish-guard judges the device's OWN namespace (trusted-ish input, but
 *     it runs inside ref-announce, whose OOM took the whole sidecar down).
 *   - foreign-mirror-quarantine judges UNTRUSTED peer input, already bounded by
 *     hard object/blob/total caps — so the risk there is a burst inside those
 *     caps rather than an unbounded one.
 * Both want the same property: peak resident content is one chunk, not the
 * whole admissible range.
 */
import { defaultRunGitStdin } from './storage';
import { type SecretFinding, scanForSecrets } from './secrets-guard';

/**
 * Default ceiling on blob CONTENT held in memory at once during a scan.
 *
 * This is a RESOURCE bound on the guard's own work, NOT a volume policy: it
 * changes how much is read at a time, never what is admitted or refused. That
 * distinction matters because it is why the bound holds even where volume
 * gates are downgraded to warnings, and why it is never waivable.
 */
export const DEFAULT_SCAN_CHUNK_BYTES = 32 * 1024 * 1024;

/** A new blob in the judged range, with the size `--batch-check` already told
 *  us — which is what lets the scan be partitioned without a second stat pass. */
export interface BlobEntry {
  oid: string;
  path: string;
  bytes: number;
}

/**
 * Partition blobs into groups whose total size stays within `chunkBytes`.
 *
 * A blob larger than the budget forms its own group rather than being dropped:
 * coverage is never traded for the bound. That is safe because both callers
 * enforce a hard per-blob cap (`blob-over-cap`) before reaching here, so a
 * single blob is already bounded.
 */
export function partitionBlobsForScan(blobs: readonly BlobEntry[], chunkBytes: number): BlobEntry[][] {
  const budget = Math.max(1, chunkBytes);
  const groups: BlobEntry[][] = [];
  let current: BlobEntry[] = [];
  let currentBytes = 0;
  for (const b of blobs) {
    const size = Number.isFinite(b.bytes) && b.bytes > 0 ? b.bytes : 0;
    if (current.length > 0 && currentBytes + size > budget) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(b);
    currentBytes += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Read one partition's blobs with a SINGLE `git cat-file --batch`, returning
 * the decodable TEXT ones. Binary blobs are skipped (the size caps already own
 * that class), matching the per-blob behaviour both callers had before.
 *
 * `--batch` frames each object as `<oid> SP <type> SP <size> LF <contents> LF`,
 * or `<oid> SP missing LF` for one git cannot read. We parse against the
 * declared size rather than scanning for delimiters, so content containing
 * newlines (i.e. every source file) cannot desynchronise the stream.
 */
export async function readTextBlobs(
  group: readonly BlobEntry[],
  repoPath: string,
): Promise<{ files: { path: string; content: string }[]; error: string | null }> {
  const pathByOid = new Map(group.map((b) => [b.oid, b.path] as const));
  // `defaultRunGitStdin` returns stdout as BYTES, which is what the frame walk
  // below needs: `cat-file --batch` interleaves headers with raw object content
  // on one stream, so decoding it as a string would corrupt binary blobs and
  // desynchronise the parser from the byte-exact sizes git reports.
  const out = await defaultRunGitStdin(
    ['cat-file', '--batch', '--buffer'],
    repoPath,
    group.map((b) => b.oid).join('\n') + '\n',
  );
  // Fail-CLOSED: an unreadable batch means part of the range went unjudged.
  // (A single `missing` object inside an otherwise good batch is tolerated
  // below, exactly as the old per-blob loops tolerated a `cat-file` failure.)
  if (out.code !== 0) return { files: [], error: `cat-file --batch failed: ${out.stderr.trim()}` };

  const files: { path: string; content: string }[] = [];
  const buf = out.stdout;
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    const header = buf.toString('utf8', pos, nl);
    pos = nl + 1;
    const [oid, type, sizeS] = header.trim().split(/\s+/);
    if (!oid || !type || type === 'missing') continue;
    const size = Number(sizeS ?? 0);
    if (!Number.isFinite(size) || size < 0) break; // unparseable frame — stop rather than misread
    const end = Math.min(pos + size, buf.length);
    const content = buf.subarray(pos, end);
    pos = end + 1; // skip the LF git appends after contents
    const p = pathByOid.get(oid) ?? '';
    if (!p) continue;
    if (content.includes(0)) continue; // binary
    files.push({ path: p, content: content.toString('utf8') });
  }
  return { files, error: null };
}

/**
 * Scan every named TEXT blob for secrets, reading in bounded chunks.
 *
 * Coverage is identical to a single whole-range read: every text blob is still
 * scanned, and `scanForSecrets` is a pure per-file map-concat, so scanning in
 * ordered chunks yields exactly the findings — and the order — one call would.
 *
 * Fail-CLOSED: a chunk that cannot be read is returned as `error`, because it
 * means part of the range went unjudged. Callers must refuse on it rather than
 * treat an empty finding list as "clean".
 */
export async function scanTextBlobsChunked(
  blobs: readonly BlobEntry[],
  repoPath: string,
  chunkBytes: number,
): Promise<{ findings: SecretFinding[]; error: string | null }> {
  const groups = partitionBlobsForScan(
    blobs.filter((b) => b.path),
    chunkBytes,
  );
  const findings: SecretFinding[] = [];
  for (const group of groups) {
    const { files, error } = await readTextBlobs(group, repoPath);
    if (error) return { findings: [], error };
    findings.push(...scanForSecrets(files));
  }
  return { findings, error: null };
}
