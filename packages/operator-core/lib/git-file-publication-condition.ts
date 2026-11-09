import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { BlockerEvidenceMeasurement } from './blocker-resolution-decision';

const path = z.string().min(1).max(1000).refine(value =>
  !isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..'),
  'Expected a repository-relative path');
const oid = z.string().regex(/^[a-f0-9]{40}$/);

/** Committed containment, not an assertion about remote delivery or deployment. */
export const gitFilePublicationBindingSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('git-file-publication'),
  filePath: path, repositoryPath: path.optional(),
  sourceCommit: oid, expectedBlob: oid, parentCommit: oid,
  reason: z.string().trim().min(1).max(2000), reasonRef: z.string().trim().min(1).max(1000),
}).strict().refine(binding => !binding.repositoryPath || binding.filePath.startsWith(binding.repositoryPath + '/'),
  'The file must belong to the named repository');
export type GitFilePublicationBinding = z.infer<typeof gitFilePublicationBindingSchema>;

function git(cwd: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise(resolveResult => {
    execFile('git', args, { cwd, timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) =>
      resolveResult({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, output: stdout.trim() }));
  });
}

/** All paths come from the canonical boundary root, never a caller's checkout. */
export async function readGitFilePublicationCondition(binding: GitFilePublicationBinding, root: string | null | undefined):
Promise<BlockerEvidenceMeasurement> {
  const unknown = (detail: string): BlockerEvidenceMeasurement => ({ status: 'unknown', detail });
  const measured = (satisfied: boolean): BlockerEvidenceMeasurement => ({ status: 'available', reachable: true,
    condition: satisfied ? 'satisfied' : 'pending' });
  if (!root) return unknown('canonical repository root is unavailable');
  try {
    const canonicalRoot = await realpath(root);
    const repository = resolve(canonicalRoot, binding.repositoryPath ?? '');
    const file = resolve(canonicalRoot, binding.filePath);
    // Reject symlink substitutions, even when Git itself would follow them.
    if (await realpath(repository) !== repository || await realpath(file) !== file || !(await stat(file)).isFile() ||
        relative(canonicalRoot, repository).split(sep).includes('..')) return unknown('publication path is outside its canonical repository');
    const top = await git(repository, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0 || await realpath(top.output) !== repository) return unknown('named source repository is unavailable');
    const parentTop = await git(canonicalRoot, ['rev-parse', '--show-toplevel']);
    if (parentTop.code !== 0 || await realpath(parentTop.output) !== canonicalRoot) return unknown('canonical parent repository is unavailable');
    const parentAncestry = await git(canonicalRoot, ['merge-base', '--is-ancestor', binding.parentCommit, 'HEAD']);
    if (parentAncestry.code === 1) return measured(false);
    if (parentAncestry.code !== 0) return unknown('containing parent history is unavailable');
    let containedCommit = binding.parentCommit;
    if (binding.repositoryPath) {
      const link = await git(canonicalRoot, ['ls-tree', binding.parentCommit, '--', binding.repositoryPath]);
      if (link.code !== 0) return unknown('containing parent commit is unavailable');
      const match = /^160000 commit ([a-f0-9]{40})\t/.exec(link.output);
      if (!match) return measured(false);
      containedCommit = match[1];
    }
    const sourceFile = binding.repositoryPath ? binding.filePath.slice(binding.repositoryPath.length + 1) : binding.filePath;
    const [author, accepted, contained, working, ancestry] = await Promise.all([
      git(repository, ['show', '-s', '--format=%an', binding.sourceCommit]),
      git(repository, ['ls-tree', binding.sourceCommit, '--', sourceFile]),
      git(repository, ['ls-tree', containedCommit, '--', sourceFile]),
      git(repository, ['hash-object', '--', sourceFile]),
      git(repository, ['merge-base', '--is-ancestor', binding.sourceCommit, containedCommit]),
    ]);
    if ([author, accepted, contained, working].some(result => result.code !== 0) ||
        (ancestry.code !== 0 && ancestry.code !== 1)) return unknown('committed file evidence could not be measured');
    const blob = (entry: string) => /^100(?:644|755) blob ([a-f0-9]{40})\t/.exec(entry)?.[1];
    return measured(author.output === 'papercusp-git-sync' && ancestry.code === 0 &&
      blob(accepted.output) === binding.expectedBlob && blob(contained.output) === binding.expectedBlob &&
      working.output === binding.expectedBlob);
  } catch {
    return unknown('canonical publication repository or file is unavailable');
  }
}
