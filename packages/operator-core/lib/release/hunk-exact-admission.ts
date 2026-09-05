/**
 * P-020 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-008 layers 2–3):
 * build the SOURCE COMMIT for a hunk-exact admission.
 *
 * WHAT IT DOES. `admitPathsOntoRepairHead` (P-001) is source-agnostic: it admits the named
 * paths' entries from ANY commit in the object store onto repairHead. Path-exact admission
 * with `source: staging` therefore admits staging's whole BLOB of each path — which on this
 * shared tree can carry a stranger's concurrent work in the same file (D-008). This module
 * synthesises a source commit whose tree is repairHead's tree with each admitted path's blob
 * replaced by *repairHead's blob + ONLY the calling agent's ledgered hunks, replayed in
 * order*. Handing that commit to the primitive makes the admission hunk-exact while the
 * primitive's own proof (diff-tree == allowlist) still applies unchanged.
 *
 * WHAT IT REFUSES — and why each refusal names its exit, never a silent widening:
 *   - `no-ledgered-hunks`  no hunk by the caller (∪ includeHunksFrom) is ledgered for a path.
 *                          The ledger cannot attribute what it never saw (an edit made before
 *                          the freeze, a Codex apply_patch, a hook that could not reach the
 *                          operator). Exits: includeHunksFrom:[agent] / wholeBlob:true+reason.
 *   - `hunk-conflict`      a hunk's anchor is not in the content at that point of the replay:
 *                          the fix was made on top of a foreign change. Names the hunk and the
 *                          other agents who touched the path. Same two exits.
 *   - `oversize`           a hunk exceeded the ledger cap and carries no content.
 *   - `not-a-blob`         the path is a symlink/gitlink/directory at repairHead — replaying
 *                          text hunks onto it is meaningless; admit it whole-blob by name.
 *
 * Synchronous plumbing like the primitive it feeds; every git call goes through the same
 * injectable runner. The scratch index and blob files are removed on every path.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADMISSION_GIT_IDENTITY,
  normalizeAdmissionPath,
  realAdmissionGit,
  type AdmissionGitResult,
  type AdmissionGitRunner,
} from './repair-head-admission';
import { replayFrozenRepairHunks, type FrozenRepairEditLedgerRow } from './frozen-repair-edit-ledger';

const SHA_RE = /^[0-9a-f]{40,64}$/;

export interface HunkExactPathReport {
  path: string;
  /** Ledgered hunks replayed (the caller's ∪ includeHunksFrom's), in ledger order. */
  applied: number;
  /** The agents whose hunks were replayed. */
  agents: string[];
  /** Ledgered hunks on this path by agents NOT replayed — the work D-008 keeps out. */
  foreignHunks: number;
  foreignAgents: string[];
  /** repairHead's blob (null when the path did not exist there) and the replayed blob. */
  baseBlob: string | null;
  blob: string;
  /** true when the replay reproduced repairHead's blob byte-for-byte (nothing to admit). */
  unchanged: boolean;
}

export type HunkExactRefusalCode =
  | 'invalid-paths'
  | 'repair-head-unresolvable'
  | 'no-ledgered-hunks'
  | 'hunk-conflict'
  | 'oversize'
  | 'not-a-blob'
  | 'git-failed';

export interface HunkExactRefusal {
  ok: false;
  code: HunkExactRefusalCode;
  detail: string;
  path?: string;
  /** Other agents with ledgered hunks on `path` — the `includeHunksFrom` candidates. */
  foreignAgents?: string[];
  /** hunk-conflict / oversize: index into the replayed hunk list. */
  hunkIndex?: number;
  step?: string;
  /** The explicit widenings D-008 allows — never chosen by the tool on its own. */
  exits: string[];
}

export interface HunkExactSuccess {
  ok: true;
  /** The synthesised source commit (parent: repairHead). Pass as `source.ref` to the primitive. */
  sourceCommit: string;
  tree: string;
  perPath: HunkExactPathReport[];
  /** Every admitted path replayed to exactly repairHead's blob — the primitive will say nothing-to-admit. */
  allUnchanged: boolean;
}

export type HunkExactSourceOutcome = HunkExactSuccess | HunkExactRefusal;

export interface BuildHunkExactSourceInput {
  root: string;
  candidate: string;
  repairHead: string;
  paths: readonly string[];
  /** Ledger rows for this candidate (any path/agent — filtered here). */
  ledger: readonly FrozenRepairEditLedgerRow[];
  actor: string;
  /** D-008 layer 3a: other agents whose hunks are replayed too (a genuinely shared fix). */
  includeHunksFrom?: readonly string[];
  git?: AdmissionGitRunner;
  nowMs: number;
}

function exitsFor(path: string, foreignAgents: string[]): string[] {
  const named = foreignAgents.length > 0 ? foreignAgents.map((a) => JSON.stringify(a)).join(', ') : '<agent>';
  return [
    `release:repair-queue { op:'admit', paths:['${path}'], includeHunksFrom:[${named}] } — replay another agent's ledgered hunks too (a shared fix)`,
    `release:repair-queue { op:'admit', paths:['${path}'], wholeBlob:true, reason:'<why the whole staging blob is safe>' } — admit staging's blob as-is; the ledger records every foreign hunk it carries`,
  ];
}

/**
 * Build the hunk-exact source commit. Never publishes anything: the commit is an ordinary
 * unreferenced object until the primitive builds an admission from it, and garbage otherwise.
 */
export function buildHunkExactSource(input: BuildHunkExactSourceInput): HunkExactSourceOutcome {
  const git = input.git ?? realAdmissionGit;
  const run = (argv: readonly string[], env?: NodeJS.ProcessEnv): AdmissionGitResult =>
    git(argv, { cwd: input.root, env: env ? { ...process.env, ...env } : undefined });
  const gitFailed = (step: string, r: AdmissionGitResult): HunkExactRefusal => ({
    ok: false,
    code: 'git-failed',
    step,
    detail: `${step} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
    exits: [],
  });
  const revParse = (ref: string): string | null => {
    const r = run(['rev-parse', '--verify', '--quiet', ref]);
    const out = r.stdout.trim();
    return r.status === 0 && SHA_RE.test(out) ? out : null;
  };

  const paths: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.paths) {
    const n = normalizeAdmissionPath(raw);
    if (!n) invalid.push(raw);
    else if (!paths.includes(n)) paths.push(n);
  }
  if (invalid.length > 0 || paths.length === 0) {
    return {
      ok: false,
      code: 'invalid-paths',
      detail: invalid.length ? `not repo-relative normal paths: ${invalid.map((p) => JSON.stringify(p)).join(', ')}` : 'no paths were named',
      exits: [],
    };
  }
  const repairHead = revParse(`${input.repairHead}^{commit}`);
  if (!repairHead) {
    return { ok: false, code: 'repair-head-unresolvable', detail: `repairHead ${input.repairHead} does not resolve to a commit in ${input.root}`, exits: [] };
  }
  const repairHeadTree = revParse(`${repairHead}^{tree}`);
  if (!repairHeadTree) return gitFailed('rev-parse repairHead^{tree}', run(['rev-parse', `${repairHead}^{tree}`]));

  const accepted = new Set<string>([input.actor.trim(), ...(input.includeHunksFrom ?? []).map((a) => a.trim()).filter(Boolean)]);
  const scratch = mkdtempSync(join(tmpdir(), 'papercusp-hunk-exact-'));
  const indexEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    const rt = run(['read-tree', repairHead], indexEnv);
    if (rt.status !== 0) return gitFailed('read-tree', rt);

    const perPath: HunkExactPathReport[] = [];
    for (const path of paths) {
      const rows = input.ledger.filter((r) => r.path === path);
      const mine = rows.filter((r) => accepted.has(r.agent));
      const foreign = rows.filter((r) => !accepted.has(r.agent));
      const foreignAgents = [...new Set(foreign.map((r) => r.agent))].sort();
      if (mine.length === 0) {
        return {
          ok: false,
          code: 'no-ledgered-hunks',
          path,
          foreignAgents,
          detail:
            `no ledgered hunk by ${JSON.stringify(input.actor)}${accepted.size > 1 ? ` (or ${[...accepted].filter((a) => a !== input.actor.trim()).join(', ')})` : ''} ` +
            `for ${path} under candidate ${input.candidate.slice(0, 12)}` +
            (foreignAgents.length ? `; ${foreign.length} hunk(s) by ${foreignAgents.join(', ')} ARE ledgered` : '; nobody ledgered an edit to it') +
            ' — hunk-exact admission has nothing to replay (an edit made before the freeze, a Codex apply_patch, or a hook that could not reach the operator is not attributable)',
          exits: exitsFor(path, foreignAgents),
        };
      }
      // repairHead's entry: mode + blob, or absent.
      const ls = run(['ls-tree', '-z', repairHead, '--', path]);
      if (ls.status !== 0) return gitFailed(`ls-tree ${repairHead.slice(0, 12)} -- ${path}`, ls);
      const line = ls.stdout.split('\0').find((l) => l.endsWith(`\t${path}`));
      let mode = '100644';
      let baseBlob: string | null = null;
      if (line) {
        const m = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t/.exec(line);
        if (!m) return gitFailed(`ls-tree ${path}`, { ...ls, stderr: `unparseable entry ${JSON.stringify(line)}` });
        if (m[2] !== 'blob' || m[1] === '120000') {
          return {
            ok: false,
            code: 'not-a-blob',
            path,
            detail: `${path} is a ${m[2] === 'tree' ? 'directory' : m[2] === 'commit' ? 'submodule gitlink' : 'symlink'} at repairHead ${repairHead.slice(0, 12)} — text hunks cannot be replayed onto it`,
            exits: exitsFor(path, foreignAgents).slice(1),
          };
        }
        mode = m[1]!;
        baseBlob = m[3]!;
      }
      let base: string | null = null;
      if (baseBlob) {
        const cat = run(['cat-file', 'blob', baseBlob]);
        if (cat.status !== 0) return gitFailed(`cat-file blob ${baseBlob.slice(0, 12)}`, cat);
        base = cat.stdout;
      }
      const replay = replayFrozenRepairHunks(
        base,
        mine.map((r) => r.hunk),
      );
      if (!replay.ok) {
        const row = mine[replay.index];
        return {
          ok: false,
          code: replay.reason,
          path,
          hunkIndex: replay.index,
          foreignAgents,
          detail:
            `${path}: ${replay.detail}` +
            (row ? ` (hunk by ${row.agent} at ${new Date(row.atMs).toISOString()}${row.workItem ? `, ${row.workItem}` : ''})` : '') +
            (replay.reason === 'hunk-conflict' && foreignAgents.length
              ? `; the path also carries ${foreign.length} ledgered hunk(s) by ${foreignAgents.join(', ')} — your fix may depend on one of them`
              : ''),
          exits: exitsFor(path, foreignAgents),
        };
      }
      const blobFile = join(scratch, `blob-${perPath.length}`);
      writeFileSync(blobFile, replay.content, 'utf8');
      const ho = run(['hash-object', '-w', '--', blobFile]);
      const blob = ho.stdout.trim();
      if (ho.status !== 0 || !SHA_RE.test(blob)) return gitFailed(`hash-object ${path}`, ho);
      const ui = run(['update-index', '--add', '--replace', '--cacheinfo', `${mode},${blob},${path}`], indexEnv);
      if (ui.status !== 0) return gitFailed(`update-index --cacheinfo ${path}`, ui);
      perPath.push({
        path,
        applied: replay.applied,
        agents: [...new Set(mine.map((r) => r.agent))].sort(),
        foreignHunks: foreign.length,
        foreignAgents,
        baseBlob,
        blob,
        unchanged: blob === baseBlob,
      });
    }
    const wt = run(['write-tree'], indexEnv);
    const tree = wt.stdout.trim();
    if (wt.status !== 0 || !SHA_RE.test(tree)) return gitFailed('write-tree', wt);
    const identityEnv: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: ADMISSION_GIT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: ADMISSION_GIT_IDENTITY.email,
      GIT_COMMITTER_NAME: ADMISSION_GIT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: ADMISSION_GIT_IDENTITY.email,
    };
    const message =
      `hunk-exact source for ${input.actor.trim()} onto ${repairHead.slice(0, 12)} (candidate ${input.candidate.slice(0, 12)})\n\n` +
      perPath.map((p) => `${p.path}: ${p.applied} hunk(s) by ${p.agents.join(', ')}${p.foreignHunks ? `; ${p.foreignHunks} foreign hunk(s) NOT carried (${p.foreignAgents.join(', ')})` : ''}`).join('\n') +
      `\n\nBuilt ${new Date(input.nowMs).toISOString()} by papercusp release:repair-queue admit (P-020 / D-008).\n`;
    const ct = run(['commit-tree', tree, '-p', repairHead, '-m', message], identityEnv);
    const sourceCommit = ct.stdout.trim();
    if (ct.status !== 0 || !SHA_RE.test(sourceCommit)) return gitFailed('commit-tree', ct);
    return { ok: true, sourceCommit, tree, perPath, allUnchanged: perPath.every((p) => p.unchanged) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Ledgered hunks on `paths` by agents other than `actor` (∪ include) — what a whole-blob admission may carry. */
export function summarizeForeignHunks(
  ledger: readonly FrozenRepairEditLedgerRow[],
  paths: readonly string[],
  actor: string,
  include: readonly string[] = [],
): { count: number; agents: string[]; byPath: Record<string, number> } {
  const accepted = new Set([actor.trim(), ...include.map((a) => a.trim()).filter(Boolean)]);
  const wanted = new Set(paths.map((p) => normalizeAdmissionPath(p)).filter((p): p is string => p !== null));
  const byPath: Record<string, number> = {};
  const agents = new Set<string>();
  let count = 0;
  for (const row of ledger) {
    if (!wanted.has(row.path) || accepted.has(row.agent)) continue;
    count += 1;
    agents.add(row.agent);
    byPath[row.path] = (byPath[row.path] ?? 0) + 1;
  }
  return { count, agents: [...agents].sort(), byPath };
}
