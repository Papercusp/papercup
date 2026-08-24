/**
 * stale-path-hints-claim-port — the claim-time "DEAD PATH HINT" guard
 * (EI-21267393427094356).
 *
 * THE CLASS THIS SURFACES: a work-item's `payload.paths` are hints frozen at
 * filing time, but modules MOVE — P-064 renamed hive/* → pot/* repo-wide while
 * EI-5927's recipe kept citing lib/hive/watchdog.ts, and any literal affected-
 * path check on the stored hint fails into a repository-wide fallback search.
 * This guard resolves each dead hint to its CURRENT location at the moment of
 * the claim, so scheduler-admitted items stop handing successors dead paths.
 *
 * RESOLUTION, bounded: for a stored path that no longer exists, find the commit that
 * DELETED it, then diff that commit against its parent WITHOUT a pathspec — a bare
 * `git log -- <dead>` can never see both sides of a rename (the destination is outside
 * the pathspec, so every status reads D), and `--follow` rewrites names but reports
 * A/D pairs against the original. The un-pathspec'd diff is where git's rename
 * detection pairs old→new (`R100<tab><old><tab><new>`); walk forward up to
 * MAX_RENAME_HOPS times until a live path is found. A delete without any rename
 * honestly reports status 'missing' rather than guessing.
 *
 * Fail-soft by design, mirroring every sibling port: a claim must never fail
 * because an advisory lookup did. If the repo is not a git work tree (or git
 * is unavailable) the leg stays SILENT for every path — "the probe could not
 * run" must never render as "every path is missing" (the WI-6737 lesson).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ClaimTimeStalePathHint {
  /** The stored hint exactly as filed. */
  requested: string;
  /** 'moved' = resolvedTo names the current location; 'missing' = no rename chain found. */
  status: 'moved' | 'missing';
  /** The current canonical path, when follow-resolution succeeded. */
  resolvedTo?: string;
}

/** Bounded so a pathological rename chain can never stall the claim path. */
const MAX_RENAME_HOPS = 3;

/** Globs cannot be validated against the tree or walked through renames — skip silently. */
function isConcretePath(p: string): boolean {
  return p.length > 0 && !/[*?[\]{}]/.test(p);
}

function pathsOfPayload(payload: unknown): string[] | null {
  const raw = (payload as { paths?: unknown } | null | undefined)?.paths;
  if (!Array.isArray(raw)) return null;
  const paths = raw.filter((p): p is string => typeof p === 'string' && p.length > 0);
  return paths.length > 0 ? paths : null;
}

function git(args: readonly string[], cwd: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolvePromise(err ? null : String(stdout));
    });
  });
}

/**
 * The commit that deleted `cur` → the new name git's rename detection paired it with,
 * or null when the deletion was not a rename (or history cannot answer here).
 */
async function nextRename(cur: string, cwd: string): Promise<string | null> {
  const delCommit = (await git(['log', '--diff-filter=D', '--format=%H', '-n', '1', '--', cur], cwd))?.trim();
  if (!delCommit) return null;
  const out = await git(['diff-tree', '-r', '-M50%', '--name-status', `${delCommit}^`, delCommit], cwd);
  if (!out) return null;
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    // R100 <tab> old <tab> new — the old side must BE the path we are chasing, so an
    // unrelated rename elsewhere in the same commit can never redirect us.
    if (parts.length >= 3 && parts[0].startsWith('R') && parts[1] === cur) return parts[2];
  }
  return null;
}

/** Resolve one dead path forward through its rename chain; null ⇒ unresolvable here. */
async function resolveMovedPath(requested: string, cwd: string): Promise<string | null> {
  let cur = requested;
  for (let hop = 0; hop < MAX_RENAME_HOPS; hop += 1) {
    const next = await nextRename(cur, cwd);
    if (!next || !isConcretePath(next)) return null;
    if (existsSync(join(cwd, next))) return next;
    cur = next;
  }
  return null;
}

/**
 * Which of the claimed item's stored payload paths no longer exist at HEAD, and
 * where each moved to. Null when: the subject carries no usable `payload.paths`
 * (the overwhelmingly common case — a normal claim is completely unaffected),
 * every stored path still exists, the repo probe cannot run (total silence —
 * see the header), or any unexpected error escapes (fail-soft, like siblings).
 */
export async function getClaimTimeStalePathHints(ref: {
  workItem?: { payload?: unknown } | null;
  payload?: unknown;
  repoRoot?: string;
}): Promise<ClaimTimeStalePathHint[] | null> {
  const payload = ref.payload ?? ref.workItem?.payload ?? null;
  const requestedPaths = pathsOfPayload(payload);
  if (!requestedPaths) return null;
  try {
    // Resolve against the WORK-TREE ROOT, not process.cwd(): the host may run
    // from any depth inside the checkout, and stored paths are repo-relative.
    const topLevel = (await git(['rev-parse', '--show-toplevel'], resolve(ref.repoRoot ?? process.cwd())))?.trim();
    if (!topLevel) return null;
    const candidates = requestedPaths.filter((p) => isConcretePath(p) && !existsSync(join(topLevel, p)));
    if (candidates.length === 0) return null;
    const hints = await Promise.all(
      candidates.map(async (requested): Promise<ClaimTimeStalePathHint> => {
        try {
          const resolvedTo = await resolveMovedPath(requested, topLevel);
          return resolvedTo ? { requested, status: 'moved', resolvedTo } : { requested, status: 'missing' };
        } catch {
          return { requested, status: 'missing' };
        }
      }),
    );
    return hints.length > 0 ? hints : null;
  } catch {
    return null;
  }
}

/**
 * Render the hints as the note an agent reads at claim time. Pure + exported so
 * the guarantee is directly testable and a future edit cannot silently weaken it
 * — the same shape planItemContradictionWarning chose, and for the same reason.
 */
export function stalePathHintsNote(hints: ClaimTimeStalePathHint[] | null): string | null {
  if (!hints || hints.length === 0) return null;
  const moved = hints.filter((h): h is ClaimTimeStalePathHint & { resolvedTo: string } =>
    Boolean(h.status === 'moved' && h.resolvedTo),
  );
  const missingCount = hints.length - moved.length;
  const movedText = moved.map((h) => `'${h.requested}' → '${h.resolvedTo}'`).join('; ');
  return (
    `⚠ STALE PATH HINTS: ${hints.length} stored payload path(s) no longer exist at HEAD` +
    (movedText ? ` — ${movedText}` : '') +
    (missingCount > 0 ? ` (${missingCount} unresolved)` : '') +
    '. Work from the resolvedTo locations; do NOT take a stored path literally or fall back to a ' +
    'repository-wide search. [EI-21267393427094356]'
  );
}
