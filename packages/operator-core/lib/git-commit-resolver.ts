/**
 * git-commit-resolver.ts — does a hex token name a real commit in the integration tree?
 *
 * The commit resolver for `cell-transcription-detector`'s `resolvesToCommit` option
 * (EI-24684014950807803). Kept out of the detector so the detector stays pure and
 * synchronous.
 *
 * Three choices here are load-bearing:
 *
 * 1. ASYNC, never `execFileSync`. The hint is computed on the hot path of every
 *    `coord:send`; a synchronous spawn blocks the operator's event loop for every
 *    sha-shaped token in every message, and this box runs at load ~200.
 *
 * 2. The INTEGRATION tree, not `process.cwd()`. The :3070 operator runs out of the
 *    release checkout, which is pinned to `main` and does not hold newer staging
 *    commits — exactly the green-checkpoint candidates the detector exists to flag.
 *    Resolving there would answer `false` for a real candidate sha and silently drop
 *    the most important hit. Both operators export `PAPERCUSP_INTEGRATION_ROOT`.
 *
 * 3. TRI-STATE. `git rev-parse --verify --quiet <tok>^{commit}` exits 1 when the
 *    object is absent or is not a commit (→ `false`), and 128 / a spawn error / a
 *    timeout when git itself could not answer — not a repo, no git binary, an
 *    ambiguous short id (→ `null`, "could not tell", and the hit is kept). Collapsing
 *    the second case into `false` would silently disable the detector on a host
 *    without a checkout.
 */

import { execFile } from 'node:child_process';
import { cellTranscriptionHint, detectCellTranscriptions } from './cell-transcription-detector';

const HEX_TOKEN = /^[0-9a-f]{4,40}$/i;

/** Upper bound on distinct tokens resolved per text — each costs one git spawn. */
export const MAX_RESOLVED_COMMIT_TOKENS = 8;

/** The repository whose history the detector's shas refer to. */
export function commitResolverRepo(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return env.PAPERCUSP_INTEGRATION_ROOT || cwd;
}

export function gitResolvesToCommit(
  token: string,
  cwd: string = commitResolverRepo(),
  timeoutMs = 2_000,
): Promise<boolean | null> {
  if (!HEX_TOKEN.test(token)) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['rev-parse', '--verify', '--quiet', `${token}^{commit}`],
        { cwd, timeout: timeoutMs, windowsHide: true },
        (err) => {
          if (!err) return resolve(true);
          // Non-zero exit → `code` is the numeric status; spawn failure → an errno
          // string; timeout → killed with a null code. Only a clean exit 1 is "absent".
          resolve((err as { code?: unknown }).code === 1 ? false : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Detect + format, vetoing sha-shaped tokens that name no commit. Two passes keep the
 * detector pure: pass 1 collects the tokens the detector would report AS SHAS, git
 * resolves them in parallel, pass 2 re-detects with those verdicts.
 *
 * Never throws and never blocks delivery: any failure falls back to the shape-only hint.
 */
export async function cellTranscriptionHintResolvingCommits(
  text: unknown,
  resolve: (token: string) => Promise<boolean | null> = (token) => gitResolvesToCommit(token),
): Promise<string | null> {
  try {
    const tokens = new Set<string>();
    detectCellTranscriptions(text, {
      resolvesToCommit: (token) => {
        tokens.add(token.toLowerCase());
        return null;
      },
    });
    if (tokens.size === 0) return cellTranscriptionHint(text);

    const verdicts = new Map<string, boolean | null>(
      await Promise.all(
        [...tokens].slice(0, MAX_RESOLVED_COMMIT_TOKENS).map(
          async (token) => [token, await resolve(token).catch(() => null)] as const,
        ),
      ),
    );
    return cellTranscriptionHint(text, { resolvesToCommit: (token) => verdicts.get(token.toLowerCase()) ?? null });
  } catch {
    return cellTranscriptionHint(text);
  }
}
