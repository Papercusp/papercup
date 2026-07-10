/**
 * pot-git/publish-guard.ts — the OWN-NAMESPACE sibling of
 * foreign-mirror-quarantine.ts's admission checks (Phase 7 G-10,
 * p2p-git-live-activation-2026-07-09 / P-205).
 *
 * foreign-mirror-quarantine.ts judges OTHER people's objects arriving via the
 * foreign-workspace results channel. This module judges the DEVICE'S OWN new
 * objects right before they are exposed under its own namespace ref
 * (`refs/namespaces/<hex>/...`) for peers to fetch — the point P-202's
 * announce→fetch driver calls just before `buildSigrefs`/`buildScopeSigrefs`
 * signs a snapshot of the advancing namespace and announces it hive-wide.
 * There is no quarantine step here (the objects already live in the device's
 * own ODB) — this is a pure "would-be-safe-to-publish" judgment over the
 * (oldOid, newOid] range about to be exposed.
 *
 * Two independent gates, either one refuses the whole publish:
 *   - oversized blob (the sibling of run-git-sync.ts's `findOversizedDirtyFiles`
 *     / foreign-mirror-quarantine.ts's blob cap — a blob no peer should ever
 *     be asked to replicate, mirroring GitHub's own hard limit posture);
 *   - a secret (G-10, secrets-guard.ts) in any new TEXT blob.
 *
 * Fail-CLOSED like its siblings: any git failure judging the range refuses
 * the publish rather than letting an unjudged range through. Pure over the
 * `RunGit` seam (storage.ts) — unit-integration-tests against a real bare
 * repo, no mocked git.
 */
import { spawn } from 'node:child_process';
import { type RunGit, defaultRunGit } from './storage';
import { type SecretFinding, scanForSecrets } from './secrets-guard';

/** Default per-blob cap — matches GitHub's hard limit posture and
 *  foreign-mirror-quarantine's DEFAULT_MAX_BLOB_BYTES (the two "no one should
 *  ever replicate this" gates stay aligned). */
export const DEFAULT_MAX_PUBLISH_BLOB_BYTES = 100 * 1024 * 1024;
/** Default cap on total NEW bytes a single publish may introduce. */
export const DEFAULT_MAX_PUBLISH_TOTAL_BYTES = 500 * 1024 * 1024;
/** Default cap on NEW object count a single publish may introduce (flood control). */
export const DEFAULT_MAX_PUBLISH_NEW_OBJECTS = 50_000;

export interface PublishGuardCaps {
  maxBlobBytes?: number;
  maxTotalNewBytes?: number;
  maxNewObjects?: number;
}

export interface PublishGuardInput {
  /** The bare pot-git repo (storage.ts's `hiveGitRepoPath`). */
  repoPath: string;
  /** The namespace's PREVIOUSLY published head (null on a device's first-ever
   *  publish — the whole history reachable from `toOid` is judged). */
  fromOid: string | null;
  /** The new head about to be published under the device's namespace. */
  toOid: string;
  caps?: PublishGuardCaps;
  runGit?: RunGit;
}

export type PublishRefusalCode = 'blob-over-cap' | 'total-over-cap' | 'object-flood' | 'secrets' | 'error';

export interface PublishGuardResult {
  ok: boolean;
  refusalCode: PublishRefusalCode | null;
  newObjectCount: number;
  newTotalBytes: number;
  oversizeBlobs: { oid: string; path: string; bytes: number }[];
  secretFindings: SecretFinding[];
  errors: string[];
}

/** git with STDIN (the RunGit seam is (args, cwd) only; `cat-file
 *  --batch-check` needs oids on stdin — mirrors foreign-mirror-quarantine's
 *  runGitStdin). */
function runGitStdin(args: string[], cwd: string, stdin: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * Judge the (fromOid, toOid] range about to be exposed under a device's own
 * namespace ref. Pure decision — the caller (P-202's publish driver) decides
 * what to do with a refusal (skip the publish tick, escalate, etc.); this
 * function never mutates refs.
 */
export async function checkPublishGuard(input: PublishGuardInput): Promise<PublishGuardResult> {
  const runGit = input.runGit ?? defaultRunGit;
  const caps = {
    maxBlobBytes: input.caps?.maxBlobBytes ?? DEFAULT_MAX_PUBLISH_BLOB_BYTES,
    maxTotalNewBytes: input.caps?.maxTotalNewBytes ?? DEFAULT_MAX_PUBLISH_TOTAL_BYTES,
    maxNewObjects: input.caps?.maxNewObjects ?? DEFAULT_MAX_PUBLISH_NEW_OBJECTS,
  };
  const res: PublishGuardResult = {
    ok: false,
    refusalCode: null,
    newObjectCount: 0,
    newTotalBytes: 0,
    oversizeBlobs: [],
    secretFindings: [],
    errors: [],
  };
  const refuse = (code: PublishRefusalCode, err?: string): PublishGuardResult => {
    if (err) res.errors.push(err);
    res.refusalCode = code;
    return res;
  };

  try {
    // 1. Enumerate NEW objects in (fromOid, toOid].
    const negatives = input.fromOid ? [`^${input.fromOid}`] : [];
    const list = await runGit(['rev-list', '--objects', input.toOid, ...negatives], input.repoPath);
    if (list.code !== 0) return refuse('error', `rev-list --objects failed: ${list.stderr.trim()}`);
    const entries = list.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const sp = l.indexOf(' ');
        return sp === -1 ? { oid: l, path: '' } : { oid: l.slice(0, sp), path: l.slice(sp + 1) };
      });
    res.newObjectCount = entries.length;
    if (entries.length > caps.maxNewObjects) {
      return refuse('object-flood', `${entries.length} new objects > cap ${caps.maxNewObjects}`);
    }
    if (entries.length === 0) {
      res.ok = true;
      return res; // nothing new to judge (e.g. a fast-forward with no new objects reachable)
    }

    // 2. Blob size caps via batch-check over the new set.
    const batch = await runGitStdin(
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)', '--buffer'],
      input.repoPath,
      entries.map((e) => e.oid).join('\n') + '\n',
    );
    if (batch.code !== 0) return refuse('error', `cat-file --batch-check failed: ${batch.stderr.trim()}`);
    const pathByOid = new Map(entries.map((e) => [e.oid, e.path] as const));
    const blobOids: string[] = [];
    for (const line of batch.stdout.split('\n')) {
      const [oid, type, sizeS] = line.trim().split(/\s+/);
      if (!oid || !type) continue;
      const bytes = Number(sizeS ?? 0);
      res.newTotalBytes += Number.isFinite(bytes) ? bytes : 0;
      if (type === 'blob') {
        blobOids.push(oid);
        if (bytes > caps.maxBlobBytes) {
          res.oversizeBlobs.push({ oid, path: pathByOid.get(oid) ?? '', bytes });
        }
      }
    }
    if (res.oversizeBlobs.length > 0) {
      return refuse(
        'blob-over-cap',
        res.oversizeBlobs
          .slice(0, 3)
          .map((b) => `${b.path || b.oid} is ${b.bytes} bytes (> ${caps.maxBlobBytes})`)
          .join('; '),
      );
    }
    if (res.newTotalBytes > caps.maxTotalNewBytes) {
      return refuse('total-over-cap', `${res.newTotalBytes} new bytes > cap ${caps.maxTotalNewBytes}`);
    }

    // 3. G-10 secrets scan over new TEXT blobs (capped read, binary skipped —
    //    the size caps above already own that class).
    const files: { path: string; content: string }[] = [];
    for (const oid of blobOids) {
      const p = pathByOid.get(oid) ?? '';
      if (!p) continue;
      const show = await runGit(['cat-file', 'blob', oid], input.repoPath);
      if (show.code !== 0) continue; // unreadable blob — size caps already judged it
      if (show.stdout.includes('\0')) continue; // binary
      files.push({ path: p, content: show.stdout });
    }
    res.secretFindings = scanForSecrets(files);
    if (res.secretFindings.length > 0) return refuse('secrets');

    res.ok = true;
    return res;
  } catch (e) {
    return refuse('error', e instanceof Error ? e.message : String(e));
  }
}

/** A one-line operator/log message for a refused publish (secrets already masked
 *  by describeSecretFindings-style masking upstream in secrets-guard.ts). */
export function describePublishRefusal(res: PublishGuardResult): string {
  if (res.ok) return 'publish admitted';
  switch (res.refusalCode) {
    case 'blob-over-cap':
      return `refusing to publish — oversized blob(s): ${res.oversizeBlobs
        .slice(0, 3)
        .map((b) => `${b.path || b.oid} (${b.bytes}B)`)
        .join('; ')}`;
    case 'total-over-cap':
      return `refusing to publish — ${res.newTotalBytes} new bytes exceeds the total-new-bytes cap`;
    case 'object-flood':
      return `refusing to publish — ${res.newObjectCount} new objects exceeds the object-count cap`;
    case 'secrets':
      return `refusing to publish — ${res.secretFindings.length} secret(s) found in new content`;
    default:
      return `refusing to publish — ${res.errors.join('; ') || 'unknown error'}`;
  }
}
