import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { harnessRoot, harnessPath } from '@papercusp/harness/paths';

const exec = promisify(execFile);

type CheckStatus = 'ok' | 'missing' | 'error';

interface Check {
  name: string;
  status: CheckStatus;
  detail?: string;
  hint?: string;
  optional?: boolean;
}

async function checkBinary(bin: string, args: string[] = ['--version']): Promise<Check> {
  try {
    const { stdout, stderr } = await exec(bin, args, { timeout: 5000 });
    const out = (stdout || stderr).trim().split(/\r?\n/)[0] ?? '';
    return { name: bin, status: 'ok', detail: out };
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { name: bin, status: 'missing', detail: `${bin} not on PATH` };
    }
    return { name: bin, status: 'error', detail: String(err?.message ?? err) };
  }
}

/**
 * Check for pi (omp). GUI app launches on macOS often miss the user's
 * login-shell PATH so 'omp' alone may fail even when installed via
 * homebrew. Probe well-known absolute locations as a fallback.
 */
async function checkPi(): Promise<Check> {
  const direct = await checkBinary('omp');
  if (direct.status === 'ok') return { ...direct, name: 'pi' };

  // The desktop bundle vendors omp at <sidecar>/bin/omp[.exe]. The Tauri
  // shell prepends that dir to PATH so the direct check above succeeds,
  // but probe the absolute path too in case some descendant process
  // strips PATH (e.g. login-shell wrappers on macOS GUI apps).
  const bundledOmp = process.cwd() ? `${process.cwd()}/bin/omp` : '';
  const candidates = [
    bundledOmp,
    `${bundledOmp}.exe`,
    '/usr/local/bin/omp',
    '/opt/homebrew/bin/omp',
    `${process.env.HOME ?? ''}/.cargo/bin/omp`,
    `${process.env.HOME ?? ''}/.local/bin/omp`,
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) {
      const probe = await checkBinary(path);
      if (probe.status === 'ok') return { ...probe, name: 'pi', detail: `${probe.detail} (at ${path})` };
    }
  }
  return {
    name: 'pi',
    status: 'missing',
    detail: 'omp not on PATH or known install paths',
    hint: 'Install via: brew install can1357/oh-my-pi/oh-my-pi (or see https://github.com/can1357/oh-my-pi). Optional — required only for the in-app pi tab.',
  };
}

async function checkPostgres(): Promise<Check> {
  // In desktop builds we ship pglite-server and Tauri main spawns it on a
  // unix socket (PAPERCUSP_USE_PGLITE=1 is the production default). When
  // that's the active DB, "postgres on :5432" isn't the right probe — the
  // socket-dir env var is, and if it exists with a `.s.PGSQL.5432` socket
  // inside, the harness has a working DB.
  if (process.env.PAPERCUSP_USE_PGLITE === '1') {
    const socketDir = process.env.PAPERCUSP_PGLITE_SOCKET_DIR;
    if (socketDir && existsSync(`${socketDir}/.s.PGSQL.5432`)) {
      return { name: 'postgres', status: 'ok', detail: `pglite (${socketDir})` };
    }
    return {
      name: 'postgres',
      status: 'missing',
      detail: socketDir
        ? `pglite socket not yet bound at ${socketDir}`
        : 'PAPERCUSP_USE_PGLITE=1 but PAPERCUSP_PGLITE_SOCKET_DIR unset',
      hint: 'pglite-server may still be starting; reload in a few seconds.',
    };
  }
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (status: CheckStatus, detail: string) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ name: 'postgres', status, detail });
    };
    socket.setTimeout(2000);
    socket.once('connect', () => finish('ok', 'localhost:5432 reachable'));
    socket.once('timeout', () => finish('missing', 'localhost:5432 timeout'));
    socket.once('error', (e: any) => finish('missing', `localhost:5432 ${e?.code ?? 'unreachable'}`));
    socket.connect(5432, '127.0.0.1');
  });
}

function checkHarnessDir(): Check {
  const runScript = harnessPath('run.sh');
  if (!existsSync(runScript)) {
    return {
      name: 'harness',
      status: 'missing',
      detail: `${runScript} not found`,
      hint: 'Reinstall workspace deps (npm install) so @papercusp/harness resolves; PAPERCUSP_HARNESS_DIR overrides if set.',
    };
  }
  return { name: 'harness', status: 'ok', detail: harnessRoot() };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// Soft-prerequisite CLIs: harness flows shell out to these, but most
// developer machines have them. Reported as optional so the bootstrap
// UI can show "install these to unlock all flows" without blocking the
// app from booting. Hints aim at the platform install command.
const SOFT_PREREQS: Array<{ name: string; hint: string }> = [
  { name: 'git', hint: 'Bundled on Windows; macOS: install Xcode CLT (xcode-select --install); Linux: apt/dnf install git. Required by harness worktree + version-detection flows.' },
  { name: 'tar', hint: 'macOS/Linux ship tar by default. Windows 10+ has tar.exe — if missing, update Windows. Required by snapshot publish/fork.' },
  { name: 'curl', hint: 'macOS/Linux ship curl by default. Windows 10+ has curl.exe. Required by harness fetch flows.' },
  // gh, node, bash, omp, code-server are all bundled now and don't need
  // soft-prereq surfacing — preflight's hard checks pick them up via PATH
  // (which Tauri prepends with sidecar/bin and, on Windows, the MinGit
  // tree). If a bundled binary fails to download at build time the
  // hard-check status is what surfaces.
];

async function checkSoftPrereq(name: string, hint: string): Promise<Check> {
  const probe = await checkBinary(name);
  if (probe.status === 'ok') return { ...probe, optional: true };
  return { ...probe, hint, optional: true };
}

export async function GET() {
  const [node, claude, bash, postgres, pi, ...softs] = await Promise.all([
    checkBinary('node'),
    checkBinary('claude'),
    checkBinary('bash'),
    checkPostgres(),
    checkPi(),
    ...SOFT_PREREQS.map((p) => checkSoftPrereq(p.name, p.hint)),
  ]);
  const harness = checkHarnessDir();
  const checks = [node, postgres, claude, bash, harness, pi, ...softs];
  // Optional checks (pi + soft prereqs) don't block boot — only the
  // core hard deps (node/postgres/claude/bash/harness) do.
  const required = checks.filter((c) => !c.optional && c.name !== 'pi');
  const allOk = required.every((c) => c.status === 'ok');
  return NextResponse.json({ ok: allOk, checks }, { headers: CORS_HEADERS });
}
