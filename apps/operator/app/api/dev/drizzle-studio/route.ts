/**
 * /api/dev/drizzle-studio
 *
 * Manages a child `drizzle-kit studio` gateway (default :4983). The UI is
 * served by https://local.drizzle.studio and connects back to this local
 * gateway over CORS. Lifecycle:
 *   POST   → start (idempotent — returns running PID if already up)
 *   GET    → status { running, pid, port, since }
 *   DELETE → stop
 *
 * Bundled with the desktop app by virtue of `drizzle-kit` being a root
 * devDependency that survives the desktop sidecar copy (see
 * scripts/build-desktop-sidecar.sh's node_modules walk).
 */
import { NextResponse } from 'next/server';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StudioProc {
  child: ChildProcessByStdio<null, Readable, Readable>;
  port: number;
  since: number;
  lastStderr: string;
}

const STATE: { proc: StudioProc | null; lastExitStderr: string; lastExitCode: number | null } =
  (globalThis as any).__drizzleStudioState ??= { proc: null, lastExitStderr: '', lastExitCode: null };

function configPath(): string | null {
  // Walk up from the operator cwd to find the repo root containing the
  // drizzle config. Works in dev (apps/operator) and in standalone build.
  const candidates = [
    'libs/papercusp/libs/db/drizzle.config.ts',
    '../../libs/papercusp/libs/db/drizzle.config.ts',
    '../../../libs/papercusp/libs/db/drizzle.config.ts',
  ];
  for (const c of candidates) {
    const abs = resolve(process.cwd(), c);
    if (existsSync(abs)) return abs;
  }
  return null;
}

function drizzleKitBin(): string | null {
  // Same walk for the drizzle-kit binary in node_modules/.bin.
  const candidates = [
    'node_modules/.bin/drizzle-kit',
    '../../node_modules/.bin/drizzle-kit',
    '../../../node_modules/.bin/drizzle-kit',
  ];
  for (const c of candidates) {
    const abs = resolve(process.cwd(), c);
    if (existsSync(abs)) return abs;
  }
  return null;
}

async function isPortFree(p: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.once('listening', () => s.close(() => done(true)));
    s.listen(p, '127.0.0.1');
  });
}

async function pickFreePort(start: number): Promise<number> {
  for (let p = start; p < start + 20; p++) {
    if (await isPortFree(p)) return p;
  }
  return start;
}

function status() {
  const p = STATE.proc;
  if (!p) return { running: false, lastStderr: STATE.lastExitStderr, lastExitCode: STATE.lastExitCode };
  if (p.child.killed || p.child.exitCode != null) {
    STATE.lastExitStderr = p.lastStderr;
    STATE.lastExitCode = p.child.exitCode;
    STATE.proc = null;
    return { running: false, lastStderr: STATE.lastExitStderr, lastExitCode: STATE.lastExitCode };
  }
  return { running: true, pid: p.child.pid, port: p.port, since: p.since };
}

export async function GET() {
  return NextResponse.json(status());
}

export async function POST() {
  const cur = status();
  if (cur.running) return NextResponse.json({ ...cur, started: false });

  const cfg = configPath();
  if (!cfg) return NextResponse.json({ error: 'drizzle.config.ts not found' }, { status: 500 });
  const bin = drizzleKitBin();
  if (!bin) return NextResponse.json({ error: 'drizzle-kit binary not found' }, { status: 500 });

  const requested = Number(process.env.DRIZZLE_STUDIO_PORT ?? 4983);
  const port = await pickFreePort(requested);

  const child = spawn(bin, ['studio', '--config', cfg, '--port', String(port), '--host', '127.0.0.1'], {
    cwd: resolve(cfg, '../..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // drizzle-kit needs DATABASE_URL or the URL in the config; the
      // config reads HARNESS_ADMIN_DATABASE_URL so admin role is used.
      HARNESS_ADMIN_DATABASE_URL:
        process.env.HARNESS_ADMIN_DATABASE_URL ??
        'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp',
    },
  });

  const proc: StudioProc = { child, port, since: Date.now(), lastStderr: '' };
  STATE.proc = proc;
  child.stderr.on('data', (b) => {
    proc.lastStderr = (proc.lastStderr + b.toString()).slice(-4096);
  });
  child.on('exit', (code) => {
    if (STATE.proc === proc) {
      STATE.lastExitStderr = proc.lastStderr;
      STATE.lastExitCode = code;
      STATE.proc = null;
    }
  });

  // Wait briefly for the gateway to either bind or fail.
  await new Promise<void>((done) => {
    const t = setTimeout(done, 800);
    child.stdout.once('data', () => { clearTimeout(t); done(); });
    child.once('exit', () => { clearTimeout(t); done(); });
  });

  return NextResponse.json({ ...status(), started: true });
}

export async function DELETE() {
  const p = STATE.proc;
  if (!p) return NextResponse.json({ running: false, stopped: false });
  p.child.kill('SIGTERM');
  STATE.proc = null;
  return NextResponse.json({ running: false, stopped: true });
}
