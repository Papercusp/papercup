/**
 * pot-git/foreign-mirror-quarantine.ts — leg (iii) of P-109, the
 * OUTCOME-INDEPENDENT half (leader ratification 2026-07-03: quarantine +
 * admission build now; the PUBLISH-TARGET wiring waits for final Q6 / lane C's
 * FS-D3+RC-D1 sign-off).
 *
 * The mirror lane's transfer step, per Q4 (ratified): the HOST FETCHES results
 * out of the foreign clone — the foreign session pushes nothing, holds no
 * credentials, dials nothing (X1). Objects land in a QUARANTINE bare repo
 * first (git's own receive-pack quarantine pattern): alternated on the TARGET
 * repo's ODB so only foreign-NEW objects occupy quarantine, then judged there
 * — X4 size/blob caps, the secrets-guard scan (G-10), and the P-110 identity
 * admission — BEFORE anything is allowed to touch a shared ODB.
 *
 * RC-2 equivalence: under P-108 option (b) this module IS the "admission at
 * push into the results channel"; the caller that publishes an ADMITTED
 * quarantine head into the scope repo (or, under (a), the marked namespace)
 * is the deferred final-Q6 wiring.
 *
 * Fail-CLOSED like its siblings: any git failure, cap breach, secret finding,
 * or identity refusal yields admit:false with a typed, receipt-ready reason
 * (M21: offerId threads through). Never throws on runtime data.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunGit, defaultRunGit } from './storage';
import {
  type ForeignAdmissionResult,
  admitForeignMergeHead,
} from './foreign-merge-admission';
import { type SecretFinding, scanForSecrets } from './secrets-guard';

/** Default per-blob cap — matches GitHub's hard limit posture (a blob the
 *  bridge could never egress should not enter a shared ODB either). */
export const DEFAULT_MAX_BLOB_BYTES = 100 * 1024 * 1024;
/** Default cap on total NEW bytes a single mirror pass may introduce. */
export const DEFAULT_MAX_TOTAL_NEW_BYTES = 500 * 1024 * 1024;
/** Default cap on NEW object count per pass (flood control, D-014 posture). */
export const DEFAULT_MAX_NEW_OBJECTS = 50_000;

export interface QuarantineCaps {
  maxBlobBytes?: number;
  maxTotalNewBytes?: number;
  maxNewObjects?: number;
}

export interface QuarantineFetchInput {
  /** The repo whose ODB the results would eventually enter (canonical or the
   *  scope repo once Q6 finalizes) — quarantine alternates on it so already-
   *  shared history costs nothing. */
  targetRepoPath: string;
  /** The foreign workspace clone to fetch FROM (leg-iv provision output). */
  foreignClonePath: string;
  /** Branch inside the foreign clone carrying the deliverable. */
  sourceBranch: string;
  /** The foreign-marked ref name the result will publish AS (P-110 contract —
   *  also what the admission result echoes for the receipt). */
  foreignRef: string;
  /** The target's current tip the range is judged against (null = judge full
   *  history; see foreign-merge-admission's no-baseline rule). */
  targetTip: string | null;
  /**
   * Additional range anchors (P-109 leg iii): ALREADY-ADMITTED canonical shas
   * ONLY — typically the provision base recorded at clone time
   * (p2p_foreign_workspaces.base_sha, mig 470) — NEVER a ref the foreign
   * session controls. Commits reachable from an anchor are excluded from the
   * judged range. An anchor missing from the fetched history is SKIPPED:
   * skipping only WIDENS the judged range (the fail-closed direction).
   */
  rangeAnchors?: string[];
  /** The offer's attested origin chain (numeric gh user ids, X9). */
  originGithubUserIds: number[];
  offerId?: string;
  caps?: QuarantineCaps;
  /** Where to create the quarantine (default: a fresh tmpdir; caller may pin
   *  it under the offer's root for quota accounting). Always safe to rm. */
  quarantineDir?: string;
  /** Keep the quarantine repo on refusal for forensics (default: removed). */
  keepOnRefusal?: boolean;
  runGit?: RunGit;
  resolveGithubUserId?: (email: string) => Promise<number | null>;
}

export type QuarantineRefusalCode =
  | 'fetch-failed'
  | 'blob-over-cap'
  | 'total-over-cap'
  | 'object-flood'
  | 'secrets'
  | 'identity'
  | 'error';

export interface QuarantineFetchResult {
  admit: boolean;
  refusalCode: QuarantineRefusalCode | null;
  /** The fetched head sha in quarantine (null when the fetch itself failed). */
  head: string | null;
  /** Where the quarantine repo lives when kept (admitted, or keepOnRefusal). */
  quarantinePath: string | null;
  offerId: string | null;
  foreignRef: string;
  newObjectCount: number;
  newTotalBytes: number;
  /** Blobs over the per-blob cap: {oid, path, bytes}. */
  oversizeBlobs: { oid: string; path: string; bytes: number }[];
  secretFindings: SecretFinding[];
  /** The P-110 identity verdict (null when refused before identity ran). */
  identity: ForeignAdmissionResult | null;
  errors: string[];
}

/** git with STDIN — the RunGit seam is (args, cwd) only, and `cat-file
 *  --batch-check` needs oids on stdin (defaultRunGit's exec style, + input). */
function runGitStdin(
  args: string[],
  cwd: string,
  stdin: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
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

/** Resolve a repo's objects dir (bare or worktree'd). */
async function objectsDir(repoPath: string, runGit: RunGit): Promise<string | null> {
  const r = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
  if (r.code !== 0) return null;
  return join(r.stdout.trim(), 'objects');
}

/**
 * Quarantine-fetch one deliverable branch and judge it. The admitted
 * quarantine repo is the hand-off artifact: the (deferred) publish wiring
 * fetches FROM it into the real target, then removes it.
 */
export async function quarantineFetchAndJudge(
  input: QuarantineFetchInput,
): Promise<QuarantineFetchResult> {
  const runGit = input.runGit ?? defaultRunGit;
  const caps = {
    maxBlobBytes: input.caps?.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES,
    maxTotalNewBytes: input.caps?.maxTotalNewBytes ?? DEFAULT_MAX_TOTAL_NEW_BYTES,
    maxNewObjects: input.caps?.maxNewObjects ?? DEFAULT_MAX_NEW_OBJECTS,
  };
  const res: QuarantineFetchResult = {
    admit: false,
    refusalCode: null,
    head: null,
    quarantinePath: null,
    offerId: input.offerId ?? null,
    foreignRef: input.foreignRef,
    newObjectCount: 0,
    newTotalBytes: 0,
    oversizeBlobs: [],
    secretFindings: [],
    identity: null,
    errors: [],
  };

  let quarantine: string | null = null;
  const refuse = async (code: QuarantineRefusalCode, err?: string): Promise<QuarantineFetchResult> => {
    if (err) res.errors.push(err);
    res.refusalCode = code;
    if (quarantine && !input.keepOnRefusal) {
      await rm(quarantine, { recursive: true, force: true });
      res.quarantinePath = null;
    }
    return res;
  };

  try {
    // 1. Quarantine bare repo, alternated on the target ODB (only NEW objects
    //    occupy quarantine; nothing writes the target).
    const base = input.quarantineDir ?? (await mkdtemp(join(tmpdir(), 'fq-')));
    quarantine = join(base, 'quarantine.git');
    res.quarantinePath = quarantine;
    const init = await runGit(['init', '-q', '--bare', quarantine], base);
    if (init.code !== 0) return refuse('error', `quarantine init failed: ${init.stderr.trim()}`);
    const targetObjects = await objectsDir(input.targetRepoPath, runGit);
    if (!targetObjects) return refuse('error', `cannot resolve target objects dir for ${input.targetRepoPath}`);
    await mkdir(join(quarantine, 'objects', 'info'), { recursive: true });
    await writeFile(join(quarantine, 'objects', 'info', 'alternates'), targetObjects + '\n');
    // Seed the target tip as a negotiation base + range anchor.
    if (input.targetTip) {
      const anchor = await runGit(['update-ref', 'refs/canonical/base', input.targetTip], quarantine);
      if (anchor.code !== 0) return refuse('error', `cannot anchor target tip: ${anchor.stderr.trim()}`);
    }

    // 2. Host-side fetch (Q4): pull the deliverable out of the foreign clone.
    const fetch = await runGit(
      ['fetch', '-q', '--no-tags', input.foreignClonePath, `+refs/heads/${input.sourceBranch}:refs/quarantine/head`],
      quarantine,
    );
    if (fetch.code !== 0) return refuse('fetch-failed', `fetch from foreign clone failed: ${fetch.stderr.trim()}`);
    const headR = await runGit(['rev-parse', 'refs/quarantine/head'], quarantine);
    if (headR.code !== 0) return refuse('fetch-failed', 'fetched head unresolvable');
    res.head = headR.stdout.trim();

    // 2b. Range anchors (leg iii): pin each anchor that actually arrived with
    //     the fetch (or is target-shared via alternates). Missing anchors are
    //     skipped — the judged range only ever WIDENS.
    const anchorRefs: string[] = [];
    for (let i = 0; i < (input.rangeAnchors?.length ?? 0); i++) {
      const sha = input.rangeAnchors![i];
      if (!/^[0-9a-f]{40,64}$/i.test(sha)) continue; // never trust a non-sha
      const exists = await runGit(['cat-file', '-e', `${sha}^{commit}`], quarantine);
      if (exists.code !== 0) continue;
      const refName = `refs/quarantine/anchor-${i}`;
      const set = await runGit(['update-ref', refName, sha], quarantine);
      if (set.code === 0) anchorRefs.push(refName);
    }

    // 3. Enumerate foreign-NEW objects (head minus what the target already has).
    const negatives = [
      ...(input.targetTip ? ['^refs/canonical/base'] : []),
      ...anchorRefs.map((r) => `^${r}`),
    ];
    const list = await runGit(
      ['rev-list', '--objects', 'refs/quarantine/head', ...negatives],
      quarantine,
    );
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

    // 4. X4 blob caps via batch-check over the new set.
    const batch = await runGitStdin(
      ['cat-file', `--batch-check=%(objectname) %(objecttype) %(objectsize)`, '--buffer'],
      quarantine,
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

    // 5. Secrets scan (G-10 sibling) over NEW text blobs, capped read.
    const files: { path: string; content: string }[] = [];
    for (const oid of blobOids) {
      const p = pathByOid.get(oid) ?? '';
      if (!p) continue;
      const show = await runGit(['cat-file', 'blob', oid], quarantine);
      if (show.code !== 0) continue; // unreadable blob → identity/size already judged it
      if (show.stdout.includes('\0')) continue; // binary — the size caps own this class
      files.push({ path: p, content: show.stdout });
    }
    res.secretFindings = scanForSecrets(files);
    if (res.secretFindings.length > 0) return refuse('secrets');

    // 6. P-110 identity admission over the quarantine (early-loud; the
    //    canonical-merge call remains mandatory at integration time).
    res.identity = await admitForeignMergeHead({
      repoPath: quarantine,
      foreignRef: input.foreignRef,
      head: res.head,
      stagingHead: input.targetTip,
      originGithubUserIds: input.originGithubUserIds,
      offerId: input.offerId,
      // Anchors are already-admitted canonical tips by contract (see input
      // doc) — exactly what excludeReachableFrom admits.
      excludeReachableFrom: anchorRefs,
      runGit,
      resolveGithubUserId: input.resolveGithubUserId,
    });
    if (!res.identity.admit) return refuse('identity');

    res.admit = true;
    return res;
  } catch (e) {
    return refuse('error', e instanceof Error ? e.message : String(e));
  }
}
