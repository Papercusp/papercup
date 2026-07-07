/**
 * Shared probes for `claude` and `omp` binaries used by both
 * `/api/desktop/preflight` and `/api/desktop/setup-status`. The wizard
 * sidebar status (from setup-status) must agree with the StepAgents
 * card (from preflight) — keep the fallback paths in one place.
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function tryProbe(path: string, timeoutMs = 3000): Promise<boolean> {
  try {
    await exec(path, ['--version'], { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export async function detectClaude(): Promise<boolean> {
  if (await tryProbe('claude')) return true;
  // ~/.local/bin is where the official claude.ai/install.sh installs —
  // missing it left the wizard's own successful install undetected
  // (found live on the Windows VM 2026-06-12).
  const candidates = [
    `${process.env.HOME ?? ''}/.local/bin/claude`,
    `${process.env.HOME ?? ''}/.papercusp/runtime/node_modules/.bin/claude`,
    `${process.env.HOME ?? ''}/.claude/bin/claude`,
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path) && (await tryProbe(path))) return true;
  }
  return false;
}

export async function detectOmp(): Promise<boolean> {
  if (await tryProbe('omp')) return true;
  // GUI app launches on macOS often miss the user's login-shell PATH, so probe
  // the locations the first-run installer (setup-pty-commands
  // buildFrameworkInstallSpec) and common manual installs land omp. omp is NOT
  // bundled in the sidecar anymore (owner directive 2026-07-07 — we use the
  // user's own install), so there is no sidecar/bin/omp candidate here.
  // Windows has no $HOME; the omp installer targets %USERPROFILE%\.papercusp\bin.
  const winHome = process.env.USERPROFILE ?? '';
  const candidates = [
    '/usr/local/bin/omp',
    '/opt/homebrew/bin/omp',
    `${process.env.HOME ?? ''}/.cargo/bin/omp`,
    `${process.env.HOME ?? ''}/.local/bin/omp`,
    `${process.env.HOME ?? ''}/.bun/bin/omp`,
    `${process.env.HOME ?? ''}/.papercusp/runtime/node_modules/.bin/omp`,
    // Where the cross-platform installer (setup-pty-commands buildFrameworkInstallSpec) lands omp.
    `${process.env.HOME ?? ''}/.papercusp/bin/omp`,
    winHome ? `${winHome}\\.papercusp\\bin\\omp.exe` : '',
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path) && (await tryProbe(path))) return true;
  }
  return false;
}

export async function detectCodex(): Promise<boolean> {
  if (await tryProbe('codex')) return true;
  // Same fallback shapes as claude/omp: the wizard's runtime prefix,
  // npm-global, and common manual install locations.
  const home = process.env.HOME ?? '';
  const candidates = [
    `${home}/.papercusp/runtime/node_modules/.bin/codex`,
    `${home}/.local/bin/codex`,
    `${home}/.bun/bin/codex`,
    `${home}/.npm-global/bin/codex`,
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path) && (await tryProbe(path))) return true;
  }
  return false;
}
