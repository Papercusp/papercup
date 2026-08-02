/**
 * Turn the validated real corpus into gym tasks, inside a real pinned checkout.
 *
 * This is the seam that replaces `fixedTasks()` — the 4-line stub service the
 * gym used to optimize against (D-004: "IT SHOULD BE PUTTING THE REAL PAPERCUSP
 * APP THROUGH THE GYM"). Both call sites — autoloop-cycle and ab-run — go
 * through here so the substrate is materialised exactly once, one way.
 *
 * The corpus JSON is GENERATED, never hand-edited: scratchpad/gym-build-corpus.ts
 * feeds `buildDescriptorsFromProbe` from the probe's measured artifacts, and the
 * discrimination gate remains the only admission path (D-006).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPinnedSubstratePlan, type PapercuspTaskDescriptor } from './papercusp-substrate';
import { materialisePapercuspCorpus, type MaterialisedTask, type RunGit } from './papercusp-corpus-materialise';
import type { GitCommand } from './clone';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_JSON = join(HERE, 'corpus/papercusp-real-corpus.json');

export interface PapercuspCorpus {
  pinCommit: string;
  descriptors: PapercuspTaskDescriptor[];
}

/** Read the generated corpus. Throws rather than falling back to a toy corpus. */
export function loadPapercuspCorpus(path: string = CORPUS_JSON): PapercuspCorpus {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PapercuspCorpus>;
  if (!raw.pinCommit || !Array.isArray(raw.descriptors) || raw.descriptors.length === 0) {
    throw new Error(
      `papercusp corpus at ${path} is empty or malformed. Regenerate it with scratchpad/gym-build-corpus.ts; ` +
        `do NOT fall back to a synthetic corpus — a run that silently swaps in toy tasks while still reporting ` +
        `corpus:'real' is exactly the blindness P-011's fitness-signal-is-real gate exists to catch.`,
    );
  }
  return { pinCommit: raw.pinCommit, descriptors: raw.descriptors };
}

/**
 * Every `node_modules` directory in the source checkout, repo-root-relative.
 *
 * Enumerated, never hardcoded: the count tracks the workspace layout (136 on
 * this tree today). These are symlinked rather than installed — `npm install`
 * in the substrate would cost minutes per cycle and is what made a real-repo
 * task look unaffordable in the first place (D-003's false premise, corrected
 * by D-006's measurement).
 */
export function enumerateNodeModulesDirs(sourceRepo: string): string[] {
  const out = execFileSync(
    'find',
    ['.', '-name', 'node_modules', '-type', 'd', '-prune', '-not', '-path', './.git/*'],
    { cwd: sourceRepo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .map((l) => l.trim().replace(/^\.\//, ''))
    .filter(Boolean);
}

/** Run one planned git command, returning trimmed stdout. */
export const execGitCommand: RunGit = async (cmd: GitCommand): Promise<string> =>
  execFileSync(cmd.argv[0]!, cmd.argv.slice(1), {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(cmd.env ? { env: { ...process.env, ...cmd.env } } : {}),
    ...(cmd.stdin === undefined ? {} : { input: cmd.stdin }),
  }).trim();

export interface MaterialiseSubstrateInput {
  /** The canonical Papercusp checkout to clone FROM. */
  sourceRepo: string;
  /**
   * Where to materialise it.
   *
   * ⚠ MUST be on the SAME FILESYSTEM as `sourceRepo`. The clone is `--local`,
   * which hardlinks the object store instead of copying ~9.9G — and hardlinks
   * cannot cross devices, so a `/tmp` dest fails with "Invalid cross-device
   * link". On this box /tmp is a separate NVMe from the workspace, so the
   * caller must NOT reuse its /tmp scratch dir for this.
   */
  destDir: string;
  corpus?: PapercuspCorpus;
}

export interface MaterialisedSubstrate {
  pinCommit: string;
  tasks: MaterialisedTask[];
}

/**
 * Clone the real repo at the corpus pin, symlink dependencies, and build one
 * commit per task whose tree carries the rewound implementation.
 */
export async function materialisePapercuspSubstrate(input: MaterialiseSubstrateInput): Promise<MaterialisedSubstrate> {
  const corpus = input.corpus ?? loadPapercuspCorpus();
  const plan = buildPinnedSubstratePlan({
    sourceRepo: input.sourceRepo,
    commit: corpus.pinCommit,
    destDir: input.destDir,
    nodeModulesDirs: enumerateNodeModulesDirs(input.sourceRepo),
  });

  for (const cmd of plan.commands) await execGitCommand(cmd);
  for (const { link, target } of plan.symlinks) {
    mkdirSync(dirname(link), { recursive: true });
    if (!existsSync(link)) symlinkSync(target, link);
  }

  const tasks = await materialisePapercuspCorpus(corpus.descriptors, input.destDir, execGitCommand);
  return { pinCommit: corpus.pinCommit, tasks };
}
