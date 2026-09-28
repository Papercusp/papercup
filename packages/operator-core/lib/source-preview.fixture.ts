/**
 * Synthetic superproject for the source-preview tests (plan
 * dhh-source-preview-2026-09-28). Everything lives under a tmpdir: no test ever
 * mutates the shared checkout (house rule — git-sync would commit it).
 *
 * The fixture is shaped like the real monorepo where it matters to the shared
 * selection: the two marker package.json files source-tree-select.sh requires,
 * one real git submodule at libs/papercusp, a tracked node_modules, and one
 * member of each exclusion class the installer cut drops (privacy excludes
 * derived from audit-release-bundle.py, heavy excludes, non-allowlisted tops).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const GIT_ID = ['-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];

/** The owner-name literal the audit requires; set on every child env. */
export const FIXTURE_ENV = {
  PAPERCUSP_RELEASE_OWNER_NAME: 'Zelda Quuxington',
  PAPERCUSP_RELEASE_OWNER_EMAIL: 'zelda.quuxington@example.invalid',
};

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...FIXTURE_ENV, GIT_CONFIG_NOSYSTEM: '1', ...extra };
}

export function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', [...GIT_ID, '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', env: childEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

export function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

/** Paths the preview must ship (relative to the export root). */
export const SHIPPED = [
  'package.json',
  'package-lock.json',
  'CLAUDE.md',
  'apps/operator/package.json',
  'apps/operator/src/index.ts',
  'packages/core/index.ts',
  'docs/architecture.md',
  'libs/papercusp/package.json',
  'libs/papercusp/libs/db/sql/001-init.sql',
];

/** Tracked paths the shared selection must drop, each for a different reason. */
export const DROPPED = [
  'apps/operator/.env', //                 privacy exclude (from the gate)
  'docs/plans/internal-plan.md', //        privacy exclude (from the gate)
  'scratch/notes.md', //                   not on the allowlist
  '.papercusp/pi-sessions/s1.jsonl', //    not on the allowlist + privacy exclude
  'papercusp-desktop/README.md', //        heavy exclude (the Tauri shell)
  'node_modules/leftpad/index.js', //      preview never ships dependencies
  'apps/operator/node_modules/x/index.js', // …at any depth
  'apps/operator/.next/cache.bin', //      heavy exclude
];

export interface Superproject {
  repo: string;
  subSrc: string;
  commit: string;
  subCommit: string;
}

/** Build the superproject + one submodule; returns the pinned commits. */
export function makeSuperproject(root: string): Superproject {
  const subSrc = join(root, 'core-src');
  mkdirSync(subSrc, { recursive: true });
  git(subSrc, ['init', '-q', '-b', 'main']);
  write(subSrc, 'package.json', JSON.stringify({ name: '@papercusp/core', description: 'core platform libraries' }, null, 2));
  write(subSrc, 'libs/db/sql/001-init.sql', 'CREATE TABLE t (id int);\n');
  git(subSrc, ['add', '-A']);
  git(subSrc, ['commit', '-q', '-m', 'core']);
  const subCommit = git(subSrc, ['rev-parse', 'HEAD']);

  const repo = join(root, 'super');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  write(repo, 'package.json', JSON.stringify({ name: 'fixture-mono', private: true }, null, 2));
  write(repo, 'package-lock.json', '{"lockfileVersion":3}\n');
  write(repo, 'CLAUDE.md', '# guide\n');
  write(repo, '.gitignore', 'node_modules\n.next\n');
  write(repo, 'apps/operator/package.json', JSON.stringify({ name: 'operator', description: 'the operator host' }, null, 2));
  write(repo, 'apps/operator/src/index.ts', 'export const x = 1;\n');
  write(repo, 'packages/core/index.ts', 'export const y = 2;\n');
  write(repo, 'docs/architecture.md', '# architecture\n');
  write(repo, 'apps/operator/.env', 'DATABASE_URL=postgres://local\n');
  write(repo, 'docs/plans/internal-plan.md', '# internal plan\n');
  write(repo, 'scratch/notes.md', 'scratch\n');
  write(repo, '.papercusp/pi-sessions/s1.jsonl', '{"turn":1}\n');
  write(repo, 'papercusp-desktop/README.md', '# desktop shell\n');
  write(repo, 'node_modules/leftpad/index.js', 'module.exports = 1;\n');
  write(repo, 'apps/operator/node_modules/x/index.js', 'module.exports = 2;\n');
  write(repo, 'apps/operator/.next/cache.bin', 'cache\n');
  git(repo, ['add', '-A', '-f']);
  git(repo, ['submodule', 'add', '-q', subSrc, 'libs/papercusp']);
  git(repo, ['commit', '-q', '-m', 'fixture superproject']);
  return { repo, subSrc, commit: git(repo, ['rev-parse', 'HEAD']), subCommit };
}
