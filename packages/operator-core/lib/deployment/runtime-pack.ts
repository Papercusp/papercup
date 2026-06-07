/**
 * Pack the local checkout into a runtime tarball for frame delivery
 * (`cloud-deployment-layer-2026-06-06` P-010, private-repo path).
 *
 * The runtime repo is PRIVATE, so the frame bootstrap's anonymous `git clone`
 * can never work — and shipping a git credential to a disposable frame is the
 * wrong trade. Instead the operator packs its own working tree (sources only —
 * the frame re-resolves deps from the public registry via `npm ci`) and scp's
 * the tarball; `frame-installer` stages it and the bootstrap untars it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';

const execFileP = promisify(execFile);

/** Heavy/derived trees the frame never needs — it re-installs deps itself.
 *  `.env*` is a SECURITY exclude: the dev box's .env.local carries live secrets
 *  and host-specific config (a pinned DATABASE_URL would override the frame's
 *  embedded-pg discovery; BIND_HOST=0.0.0.0 would expose the frame's operator).
 *  The bootstrap's exported env is the frame's ONLY env authority. */
export const DEFAULT_RUNTIME_EXCLUDES = [
  './.git',
  '.git', // submodule .git files/dirs at any depth
  'node_modules',
  'target', // rust build trees (papercusp-desktop)
  '.next',
  '.turbo',
  // ROOT-anchored: bare 'backups' ate apps/operator/app/settings/backups (a
  // SOURCE dir) and broke the frame's SPA build — found live 2026-06-06.
  './backups',
  'test-results',
  'playwright-report',
  '*.log',
  '.env*', // secrets + host-specific config — never ship to a frame
];

export interface PackResult {
  outPath: string;
  bytes: number;
}

/** Pack `repoRoot` into a gzipped tarball at `outPath` (tar must be on PATH). */
export async function packRuntimeTarball(
  repoRoot: string,
  outPath: string,
  excludes: string[] = DEFAULT_RUNTIME_EXCLUDES,
): Promise<PackResult> {
  const args = [
    '-czf',
    outPath,
    ...excludes.flatMap((e) => ['--exclude', e]),
    '-C',
    repoRoot,
    '.',
  ];
  await execFileP('tar', args, { maxBuffer: 16 * 1024 * 1024 });
  return { outPath, bytes: statSync(outPath).size };
}
