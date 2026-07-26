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
import { type SecretFinding, describeSecretFindings, scanForSecrets } from './secrets-guard';
import { loadSecretsGuardPathExemptions, partitionExemptFindings } from './secrets-guard-exemptions';

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
  /**
   * WI-5591: workspace whose runtime secrets-guard path exemptions
   * (harness_shared.secrets_guard_path_exemptions, migration 644) should be
   * consulted before a 'secrets' refusal is finalized — the no-restart escape
   * hatch for a false positive (see secrets-guard-exemptions.ts). Omitted ⇒
   * no runtime exemptions are consulted (only the static FIXTURE_FILES set
   * applies), preserving prior behavior for callers that don't pass it (e.g.
   * the existing unit/integration tests).
   */
  workspaceId?: string;
  /** Injectable for tests; defaults to the real DB-backed loader. */
  loadPathExemptions?: (workspaceId: string) => Promise<ReadonlySet<string>>;
  /**
   * WI-5738: how to treat the VOLUME gates (`total-over-cap`, `object-flood`).
   *
   * 'enforce' (default) — refuse, as always.
   *
   * 'warn' — record the breach in `volumeWarnings` but ADMIT the range. For a
   * SECOND-LINE guard re-judging content a first-line guard already admitted
   * commit-by-commit, the volume caps are pure double-jeopardy: the same bytes
   * get re-measured as one big range and re-refused, wedging the second guard
   * even though nothing unsafe is present. That is exactly how ref-announce
   * stayed stuck on 2026-07-20 *after* own-head-publish had been unwedged —
   * its baseline is sigrefs, so the manual namespace re-base never freed it.
   *
   * The HARD gates (`blob-over-cap`, `secrets`) are unaffected in both modes:
   * a secret leaving the machine is a real safety boundary, whereas a volume
   * cap is a courtesy rate-limit that receivers re-apply on their own side
   * anyway (foreign-mirror-quarantine.ts).
   */
  volumeGates?: 'enforce' | 'warn';
}

export type PublishRefusalCode = 'blob-over-cap' | 'total-over-cap' | 'object-flood' | 'secrets' | 'error';

export interface PublishGuardResult {
  ok: boolean;
  refusalCode: PublishRefusalCode | null;
  newObjectCount: number;
  newTotalBytes: number;
  oversizeBlobs: { oid: string; path: string; bytes: number }[];
  secretFindings: SecretFinding[];
  /** Findings that WOULD have refused the publish but were suppressed by a
   *  runtime path exemption (WI-5591) — surfaced for audit/logging even
   *  though they no longer block. Empty when no exemption applied. */
  exemptedFindings: SecretFinding[];
  /** WI-5738: volume breaches ADMITTED because `volumeGates: 'warn'` was set.
   *  Non-empty means the range exceeded a volume cap but was let through by a
   *  second-line guard; the first-line guard already enforced it. */
  volumeWarnings: PublishRefusalCode[];
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
    exemptedFindings: [],
    volumeWarnings: [],
    errors: [],
  };
  const warnVolume = input.volumeGates === 'warn';
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
      const msg = `${entries.length} new objects > cap ${caps.maxNewObjects}`;
      if (warnVolume) {
        res.volumeWarnings.push('object-flood');
        res.errors.push(`admitted despite object-flood (second-line guard): ${msg}`);
      } else {
        return refuse('object-flood', msg);
      }
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
      const msg = `${res.newTotalBytes} new bytes > cap ${caps.maxTotalNewBytes}`;
      if (warnVolume) {
        res.volumeWarnings.push('total-over-cap');
        res.errors.push(`admitted despite total-over-cap (second-line guard): ${msg}`);
      } else {
        return refuse('total-over-cap', msg);
      }
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
    if (res.secretFindings.length > 0 && input.workspaceId) {
      // WI-5591: consult the runtime, no-restart exemption list before
      // finalizing a 'secrets' refusal — a false positive on an already
      // fail-closed-forever range can be cleared by an INSERT instead of a
      // code edit + bg-host restart. A path exempted here is moved to
      // exemptedFindings (kept for audit) rather than dropped silently.
      const load = input.loadPathExemptions ?? loadSecretsGuardPathExemptions;
      const exempt = await load(input.workspaceId);
      // WI-5738: matching goes through the SHARED partition helper, which also
      // understands `dir/` and `dir/**` prefix entries. Exact-only matching
      // made the escape hatch inapplicable to the accident class that
      // motivated it (one bad directory = thousands of paths).
      const { blocking, exempted } = partitionExemptFindings(res.secretFindings, exempt);
      res.secretFindings = blocking;
      res.exemptedFindings.push(...exempted);
    }
    if (res.secretFindings.length > 0) return refuse('secrets');

    res.ok = true;
    return res;
  } catch (e) {
    return refuse('error', e instanceof Error ? e.message : String(e));
  }
}

/** The volume gates — aggregate/rate concerns, satisfiable by publishing LESS.
 *  Contrast the hard gates (`blob-over-cap`, `secrets`), which no amount of
 *  range-splitting can satisfy because a single object is the problem. */
const VOLUME_REFUSALS: ReadonlySet<PublishRefusalCode> = new Set(['total-over-cap', 'object-flood']);

export function isVolumeRefusal(code: PublishRefusalCode | null): boolean {
  return code !== null && VOLUME_REFUSALS.has(code);
}

export interface IncrementalPublishResolution {
  /** The furthest sha in (fromOid, toOid] that is safe to publish. Equals
   *  `fromOid` when no progress is possible at all. */
  safeSha: string | null;
  /** True when `safeSha === toOid` — the whole range was admitted (fast path). */
  complete: boolean;
  /** A HARD refusal (oversized blob / secret / git error) at this commit.
   *  Everything before it is still safe and reflected in `safeSha`. */
  blocked: { commit: string; result: PublishGuardResult } | null;
  /** True when a VOLUME cap forced a partial advance — not an error, just a
   *  drain that continues next tick. */
  drained: boolean;
  /** A single commit that alone exceeds the volume caps and therefore cannot be
   *  split any further. It is published anyway (see the header) and named here
   *  so the health layer can say exactly what happened. */
  oversizedCommit: string | null;
  guardCalls: number;
  errors: string[];
}

/**
 * Resolve the furthest sha in (fromOid, toOid] that may be published, splitting
 * the range when a VOLUME cap refuses it.
 *
 * WI-5738 — the ratchet this exists to break. `checkPublishGuard` is a verdict
 * on a whole range, and every caller baselines that range on its own last
 * SUCCESS (own-head-publish's namespace ref, ref-announce's sigrefs). So a
 * refusal is TERMINAL by construction: the baseline can only advance through
 * the publish being refused, while each new commit makes the refused range
 * bigger. On 2026-07-20 a single accidental 2.26GB AppImage extraction put the
 * range over the 500MB total cap; the guard then refused every tick for five
 * days, and the total was still CLIMBING (2261MB → 2415MB) days later.
 * Deleting the files did nothing — the guard enumerates objects introduced
 * anywhere in the range, so the blobs stay counted while the commit that
 * introduced them is inside it.
 *
 * The fix distinguishes two kinds of refusal:
 *
 *   - VOLUME (`total-over-cap`, `object-flood`) is an aggregate/rate concern:
 *     "do not ask a peer to replicate this much at once". It is satisfiable by
 *     publishing LESS, so we binary-search the longest admissible prefix and
 *     publish that. The baseline advances, the remaining range shrinks, and the
 *     backlog drains over subsequent ticks instead of deadlocking.
 *
 *   - HARD (`blob-over-cap`, `secrets`) cannot be satisfied by splitting — one
 *     specific object is the problem — so those still refuse. But they now
 *     refuse AT A COMMIT, with everything before it published, which both keeps
 *     the plane moving and names the offender exactly.
 *
 * A single commit that alone busts the volume caps is published anyway: it
 * cannot be split, and refusing it forever is precisely the outage this
 * function removes. It is reported as `oversizedCommit` so the health layer can
 * raise it. Prevention for that case belongs at COMMIT time (a cumulative dirty
 * -bytes cap in git-sync), not as a terminal publish-time latch.
 *
 * Cost: the admitted fast path is ONE guard call, exactly as before. The split
 * path is O(log n) guard calls and only runs while something is already wedged.
 */
export async function resolveIncrementalPublishSha(input: PublishGuardInput): Promise<IncrementalPublishResolution> {
  const runGit = input.runGit ?? defaultRunGit;
  const res: IncrementalPublishResolution = {
    safeSha: input.fromOid,
    complete: false,
    blocked: null,
    drained: false,
    oversizedCommit: null,
    guardCalls: 0,
    errors: [],
  };

  const judge = async (to: string): Promise<PublishGuardResult> => {
    res.guardCalls += 1;
    return checkPublishGuard({ ...input, toOid: to });
  };

  // Fast path: the whole range is fine (the overwhelming majority of ticks).
  const whole = await judge(input.toOid);
  if (whole.ok) return { ...res, safeSha: input.toOid, complete: true };

  // Enumerate the range oldest-first so a prefix is always a valid publish
  // point. Cheap — commits only, no object walk.
  const range = input.fromOid ? [`${input.fromOid}..${input.toOid}`] : [input.toOid];
  const revs = await runGit(['rev-list', '--reverse', ...range], input.repoPath);
  if (revs.code !== 0) {
    res.errors.push(`rev-list --reverse failed, cannot split range: ${revs.stderr.trim()}`);
    res.blocked = { commit: input.toOid, result: whole };
    return res;
  }
  const commits = revs.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (commits.length <= 1) {
    // Nothing to split. A volume-only refusal on a single indivisible commit is
    // published anyway rather than wedging the plane forever.
    if (isVolumeRefusal(whole.refusalCode) && commits.length === 1) {
      return { ...res, safeSha: input.toOid, complete: true, oversizedCommit: commits[0], drained: true };
    }
    res.blocked = { commit: commits[0] ?? input.toOid, result: whole };
    return res;
  }

  // Binary-search the longest admissible prefix. Cumulative object volume grows
  // monotonically along the range, so the predicate is monotone for the volume
  // gates; a hard refusal inside the prefix simply makes it look inadmissible,
  // which is safe (we publish less, never more).
  let lo = 0; // commits[0..lo] known-unknown
  let hi = commits.length - 1;
  let bestIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const verdict = await judge(commits[mid]);
    if (verdict.ok) {
      bestIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestIdx >= 0) {
    res.safeSha = commits[bestIdx];
    res.drained = true;
  }

  // Judge the very next commit to attribute the stall precisely.
  const nextIdx = bestIdx + 1;
  if (nextIdx < commits.length) {
    const nextVerdict = await judge(commits[nextIdx]);
    if (!nextVerdict.ok) {
      if (isVolumeRefusal(nextVerdict.refusalCode) && bestIdx === -1) {
        // The FIRST commit alone busts a volume cap — indivisible. Publish it
        // rather than latching the whole plane shut (see the header).
        res.safeSha = commits[nextIdx];
        res.oversizedCommit = commits[nextIdx];
        res.drained = true;
      } else if (!isVolumeRefusal(nextVerdict.refusalCode)) {
        res.blocked = { commit: commits[nextIdx], result: nextVerdict };
      }
    }
  }
  res.complete = res.safeSha === input.toOid;
  return res;
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
      // EI-18751879785723304: name the PATHS, not just a count. This refusal is
      // fail-closed-forever (the guard baseline never advances past a refused
      // range) and its documented remedy — pot_git:secrets_exemptions
      // { action:'add', path } — needs the exact path. Emitting only a count
      // forced the operator to hand-reproduce the scan over the whole stranded
      // range to recover the one input the fix requires (EI-18750935999066024:
      // 1,736 files re-scanned by hand during a 3h fleet-wide egress freeze).
      // describeSecretFindings already renders path:line [rule] excerpt with the
      // excerpt MASKED at detection, so this discloses where to look, never the
      // material — the same reason `blob-over-cap` above already names paths.
      return describeSecretFindings(res.secretFindings);
    default:
      return `refusing to publish — ${res.errors.join('; ') || 'unknown error'}`;
  }
}
