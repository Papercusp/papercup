/**
 * A real `CodeSearchDeps` for the Scout prior-art probe, backed by `git grep`.
 *
 * `code-existence-probe` is deliberately pure and injectable so its logic is
 * testable without touching a repo. This module is the I/O half: the thing that
 * actually reaches the tree.
 *
 * ## The one correctness point that matters here
 *
 * **`git grep` exits 1 when it finds NOTHING.** That is a successful search with an
 * empty result, not a failure. Treating exit 1 as an error would report every
 * genuine miss as a probe outage; treating a REAL failure (exit >= 2 — bad repo,
 * bad flag, timeout) as an empty result would report an outage as "no prior art
 * exists". The second direction is the false negative the probe exists to prevent,
 * so the two are separated explicitly and neither is inferred from stdout being
 * empty.
 *
 * ## Injection safety
 *
 * Search terms come from idea PROSE, so they are untrusted. Every call goes through
 * `execFile`-style argv (never a shell string), and the term is passed after `-e`
 * with a terminating `--`, so a term beginning with `-` is a literal, not a flag.
 * `-F` keeps it a fixed string rather than a regex.
 */

import { execFile } from 'node:child_process';
import type { CodeSearchDeps, SemanticPriorArtMatch } from './code-existence-probe';

/** Result of one process run. `code` is the exit status. */
export interface ExecOutcome {
  stdout: string;
  code: number;
}

/** Injectable process runner, so tests never shell out. */
export type ExecRunner = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; maxBuffer: number },
) => Promise<ExecOutcome>;

export interface GitGrepOptions {
  /** Repo root to search. */
  cwd: string;
  /** Max file paths retained per term (default 50). */
  maxFiles?: number;
  /** Per-search timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Max stdout bytes before the runner aborts (default 8 MiB). */
  maxBuffer?: number;
  /** Override the process runner (tests). */
  exec?: ExecRunner;
  /** Optional semantic leg, passed straight through to the probe. */
  searchSemantic?: (text: string) => Promise<SemanticPriorArtMatch[]>;
}

const DEFAULTS = {
  maxFiles: 50,
  timeoutMs: 10_000,
  maxBuffer: 8 * 1024 * 1024,
} as const;

/** Exit codes above this are real failures; 1 is an honest "no matches". */
const GIT_GREP_NO_MATCH = 1;

const defaultExec: ExecRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer },
      (err, stdout) => {
        if (!err) return resolve({ stdout: stdout ?? '', code: 0 });
        const code = typeof (err as { code?: unknown }).code === 'number'
          ? ((err as { code: number }).code)
          : NaN;
        // A killed process reports a signal, not a numeric code — that is a real
        // failure (timeout / OOM), never an empty result.
        if (Number.isFinite(code)) return resolve({ stdout: stdout ?? '', code });
        return reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });

/**
 * Search tracked files for `term` as a literal substring.
 *
 * Returns paths on a hit, `[]` on an honest miss, and THROWS on a real failure —
 * because `probeCodeExistence` converts a throw into `searched: false`, which is
 * how an outage stays distinguishable from a miss. Swallowing the error here would
 * quietly defeat that.
 */
export async function gitGrepFiles(term: string, opts: GitGrepOptions): Promise<string[]> {
  const exec = opts.exec ?? defaultExec;
  const maxFiles = opts.maxFiles ?? DEFAULTS.maxFiles;

  // Empty/whitespace terms would make `git grep` match everything.
  if (!term.trim()) return [];

  const { stdout, code } = await exec(
    'git',
    ['grep', '--no-color', '-l', '-F', '-I', '-e', term, '--'],
    {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
      maxBuffer: opts.maxBuffer ?? DEFAULTS.maxBuffer,
    },
  );

  if (code === GIT_GREP_NO_MATCH) return []; // a real, complete, empty answer
  if (code !== 0) {
    throw new Error(`git grep failed (exit ${code}) for term ${JSON.stringify(term)}`);
  }

  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, maxFiles);
}

/**
 * Build a `CodeSearchDeps` backed by `git grep`, with per-term memoisation.
 *
 * Memoisation is not an optimisation detail — the screening pass probes every
 * member of a cluster, and members of a cluster are near-duplicates, so the same
 * terms recur heavily within one cluster. Without the cache a 10-member cluster
 * runs ~10x the greps for the same answers.
 *
 * The cache stores REJECTIONS too (as a rejected promise), so a backend outage is
 * not silently retried into a different answer partway through one report.
 */
export function createGitGrepDeps(opts: GitGrepOptions): CodeSearchDeps {
  const cache = new Map<string, Promise<string[]>>();

  const deps: CodeSearchDeps = {
    search: (term: string) => {
      const hit = cache.get(term);
      if (hit) return hit;
      const p = gitGrepFiles(term, opts);
      cache.set(term, p);
      // Keep the rejection observable to the caller, but stop Node treating a
      // cached-and-not-yet-awaited rejection as unhandled.
      p.catch(() => undefined);
      return p;
    },
  };

  if (opts.searchSemantic) deps.searchSemantic = opts.searchSemantic;
  return deps;
}
