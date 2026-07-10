/**
 * hive-git/storage.ts — the per-hive bare-repo store with per-device ref
 * namespaces (cross-machine-coord-parity-and-trust-2026-07-01 Phase 7 G-1,
 * D-010/D-011). The Radicle-Heartwood storage model, adapted:
 *
 *   ONE bare git repo per (hive, managed repo). Inside it, EACH device writes
 *   ONLY under its own namespace `refs/namespaces/<device-ns>/refs/…`, and every
 *   namespace SHARES one object database (a git bare repo already has exactly
 *   one ODB), so a commit is stored once no matter how many device namespaces
 *   reference it. Single-writer-per-namespace eliminates push contention BY
 *   CONSTRUCTION — there is no shared branch anyone races to write; the "real"
 *   refs (staging, release tags) are COMPUTED from the namespaced refs by the
 *   integrator (G-5) / canonical-ref rules (G-6), never pushed directly.
 *
 * DEVICE NAMESPACE KEY (a load-bearing seam the rest of Phase 7 depends on):
 * a device pubkey is raw-32 Ed25519 as BASE64 on the wire (contains '/','+','='
 * — NOT a legal git ref component). We HEX-encode it for the namespace path, so
 * the namespace is `refs/namespaces/<64-hex>/…` (ref-safe, collision-free,
 * mirrors Radicle's node-id namespace). `deviceNamespaceKey` is the ONE place
 * that mapping lives — G-4 (sigrefs), G-5 (integrator) and G-2 (fetch) all key
 * on it.
 *
 * Pure over an injected RunGit (the run-git-sync seam shape), so the whole layer
 * unit-tests against a real temp bare repo with no network. The transport
 * (G-2) and the sigrefs/announcement/integrator layers build ON this module;
 * this file does storage + ref plumbing only — no swarm, no signing, no policy.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, access } from 'node:fs/promises';

/** The run-git seam (matches harness/git-sync/run-git-sync.ts): spawn `git
 *  <args>` in `cwd`, never throw, return the exit code + captured streams. */
export type RunGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Default RunGit — bounded, C-locale, never-throw. `cwd` is the bare repo (git
 *  operates on it via -C-equivalent cwd; bare repos need no worktree). */
export const defaultRunGit: RunGit = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    const t = setTimeout(() => {
      stderr += `\ngit ${args.join(' ')} timed out`;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
      setTimeout(() => finish(-1), 10_000).unref?.();
    }, 60_000);
    t.unref?.();
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      clearTimeout(t);
      stderr += String(e);
      finish(-1);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      finish(code ?? -1);
    });
  });

/** The pot-git storage root — one dir tree of bare repos. Env-overridable
 *  (tests point it at a temp dir; the shipping desktop uses ~/.papercusp). */
export function potGitRoot(): string {
  return (
    process.env.PAPERCUSP_POT_GIT_ROOT ||
    process.env.PAPERCUSP_HIVE_GIT_ROOT || // legacy env name — dual-accept until callers migrate
    join(homedir(), '.papercusp', 'hive-git')
  );
}

/** A slug/key is used as a path component — reject traversal + separators so a
 *  hostile hive slug or repo key can't escape the storage root. */
function assertSafeComponent(v: string, what: string): void {
  if (!v || v.includes('/') || v.includes('\\') || v.includes('..') || v.includes('\0')) {
    throw new Error(`hive-git: unsafe ${what} path component: ${JSON.stringify(v)}`);
  }
}

/** The bare repo path for a (hive home slug, managed-repo key). D-011 G-1b: one
 *  bare repo per (hive, managed repo) — a hive binds N repos, so the repo key
 *  (e.g. the github repo id or the member slug) is part of the path. */
export function hiveGitRepoPath(potHomeSlug: string, repoKey: string): string {
  assertSafeComponent(potHomeSlug, 'potHomeSlug');
  assertSafeComponent(repoKey, 'repoKey');
  return join(potGitRoot(), potHomeSlug, `${repoKey}.git`);
}

/**
 * The git ref-namespace key for a device: raw-32 Ed25519 pubkey (base64 on the
 * wire) → lowercase hex (a legal, collision-free ref component). THE canonical
 * device→namespace mapping for all of Phase 7. Throws on a malformed pubkey
 * (wrong length) so a bad key can't silently write to a garbage namespace.
 */
export function deviceNamespaceKey(devicePubkeyBase64: string): string {
  const raw = Buffer.from(devicePubkeyBase64, 'base64');
  if (raw.length !== 32) {
    throw new Error(`hive-git: device pubkey must be raw-32 Ed25519 (got ${raw.length} bytes)`);
  }
  return raw.toString('hex');
}

/** The full namespaced ref path: `refs/namespaces/<devHex>/<ref>` where `ref`
 *  is a normal ref like `refs/heads/work` or `refs/rad/sigrefs`. */
export function namespaceRefPath(devicePubkeyBase64: string, ref: string): string {
  if (!ref.startsWith('refs/')) throw new Error(`hive-git: ref must start with refs/ (got ${ref})`);
  return `refs/namespaces/${deviceNamespaceKey(devicePubkeyBase64)}/${ref}`;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the bare repo for (hive, repo) exists; `git init --bare -q` if absent.
 * Idempotent + safe to call on the hot path. Returns the repo path. Throws only
 * if init genuinely fails (disk / permissions) — a fresh init on an existing
 * bare repo is a no-op git handles cleanly.
 */
export async function ensurePotGitRepo(
  potHomeSlug: string,
  repoKey: string,
  runGit: RunGit = defaultRunGit,
): Promise<string> {
  const repoPath = hiveGitRepoPath(potHomeSlug, repoKey);
  if (await pathExists(join(repoPath, 'HEAD'))) return repoPath; // already a bare repo
  await mkdir(repoPath, { recursive: true });
  const r = await runGit(['init', '--bare', '-q', repoPath], potGitRoot());
  if (r.code !== 0) throw new Error(`hive-git: init --bare failed for ${repoPath}: ${r.stderr.trim()}`);
  return repoPath;
}

/** Write (create/move) a device's namespaced ref to `sha`. `expectedOld` (when
 *  given) makes it a compare-and-swap so a concurrent local writer can't be
 *  silently clobbered. */
export async function writeNamespaceRef(
  repoPath: string,
  devicePubkeyBase64: string,
  ref: string,
  sha: string,
  runGit: RunGit = defaultRunGit,
  expectedOld?: string,
): Promise<void> {
  const full = namespaceRefPath(devicePubkeyBase64, ref);
  const args = expectedOld !== undefined
    ? ['update-ref', full, sha, expectedOld]
    : ['update-ref', full, sha];
  const r = await runGit(args, repoPath);
  if (r.code !== 0) throw new Error(`hive-git: update-ref ${full} failed: ${r.stderr.trim()}`);
}

/** Read a device's namespaced ref → its sha, or null if the ref does not exist. */
export async function readNamespaceRef(
  repoPath: string,
  devicePubkeyBase64: string,
  ref: string,
  runGit: RunGit = defaultRunGit,
): Promise<string | null> {
  const full = namespaceRefPath(devicePubkeyBase64, ref);
  const r = await runGit(['rev-parse', '--verify', '-q', `${full}^{object}`], repoPath);
  const sha = r.stdout.trim();
  return r.code === 0 && sha ? sha : null;
}

/** Delete a device's namespaced ref (idempotent — a missing ref is not an error). */
export async function deleteNamespaceRef(
  repoPath: string,
  devicePubkeyBase64: string,
  ref: string,
  runGit: RunGit = defaultRunGit,
): Promise<void> {
  const full = namespaceRefPath(devicePubkeyBase64, ref);
  const r = await runGit(['update-ref', '-d', full], repoPath);
  // update-ref -d on a nonexistent ref exits nonzero with "not found" — treat as done.
  if (r.code !== 0 && !/does not exist|not found|no such ref/i.test(r.stderr)) {
    throw new Error(`hive-git: update-ref -d ${full} failed: ${r.stderr.trim()}`);
  }
}

/** Distinct device namespace keys (hex) that have any refs in the repo. */
export async function listNamespaces(
  repoPath: string,
  runGit: RunGit = defaultRunGit,
): Promise<string[]> {
  const r = await runGit(
    ['for-each-ref', '--format=%(refname)', 'refs/namespaces/'],
    repoPath,
  );
  if (r.code !== 0) return [];
  const ns = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^refs\/namespaces\/([0-9a-f]+)\//);
    if (m) ns.add(m[1]);
  }
  return [...ns].sort();
}

export interface NamespaceRef {
  /** The within-namespace ref, e.g. `refs/heads/work`. */
  ref: string;
  sha: string;
}

/** All refs (+ shas) under one device's namespace, with the
 *  `refs/namespaces/<dev>/` prefix stripped back to normal ref names. */
export async function listNamespaceRefs(
  repoPath: string,
  devicePubkeyBase64: string,
  runGit: RunGit = defaultRunGit,
): Promise<NamespaceRef[]> {
  const prefix = `refs/namespaces/${deviceNamespaceKey(devicePubkeyBase64)}/`;
  const r = await runGit(['for-each-ref', '--format=%(objectname) %(refname)', prefix], repoPath);
  if (r.code !== 0) return [];
  const out: NamespaceRef[] = [];
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.indexOf(' ');
    if (sp < 0) continue;
    const sha = t.slice(0, sp);
    const full = t.slice(sp + 1);
    if (full.startsWith(prefix)) out.push({ ref: full.slice(prefix.length), sha });
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}
