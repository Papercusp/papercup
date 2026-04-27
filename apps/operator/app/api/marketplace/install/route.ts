import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PAPERCUSP_BIN = process.env.PAPERCUSP_CLI ?? 'papercusp';

type RunResult = { code: number; stdout: string; stderr: string };

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function isValidSlug(s: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/.test(s);
}

export async function POST(req: Request) {
  let body: { slug?: string; projectName?: string; targetPath?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json body' }, { status: 400 });
  }
  const slug = String(body.slug ?? '').trim();
  const projectName = String(body.projectName ?? slug).trim();
  const rawTarget = typeof body.targetPath === 'string' ? body.targetPath.trim() : '';
  const targetPath = rawTarget.length > 0 ? rawTarget : null;

  if (!isValidSlug(slug)) return NextResponse.json({ ok: false, error: `invalid slug "${slug}"` }, { status: 400 });
  if (!isValidSlug(projectName)) return NextResponse.json({ ok: false, error: `invalid project name "${projectName}"` }, { status: 400 });

  // Resolve where the project will live + validate up front.
  let projectPath: string;
  if (targetPath) {
    if (!targetPath.startsWith('/') && !targetPath.startsWith('~')) {
      return NextResponse.json(
        { ok: false, error: `target path must be absolute (got "${targetPath}")` },
        { status: 400 },
      );
    }
    projectPath = targetPath.startsWith('~') ? join(homedir(), targetPath.slice(1)) : targetPath;
    if (!existsSync(projectPath)) {
      return NextResponse.json(
        { ok: false, error: `target path "${projectPath}" does not exist` },
        { status: 400 },
      );
    }
    if (existsSync(join(projectPath, '.harness'))) {
      return NextResponse.json(
        { ok: false, error: `target "${projectPath}" already has a .harness/ — already initialized?` },
        { status: 409 },
      );
    }
  } else {
    const projectsRoot = process.env.PAPERCUSP_PROJECTS_ROOT ?? join(homedir(), '.papercusp', 'projects');
    projectPath = join(projectsRoot, projectName);
    if (existsSync(projectPath)) {
      return NextResponse.json(
        { ok: false, error: `project "${projectName}" already exists at ${projectPath}` },
        { status: 409 },
      );
    }
  }

  const env = {
    ...process.env,
    PAPERCUSP_MARKETPLACE_URL: process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057',
  };

  const installResult = await run(PAPERCUSP_BIN, ['install', slug], env);
  if (installResult.code !== 0) {
    return NextResponse.json(
      {
        ok: false,
        error: 'papercusp install failed',
        log: [installResult.stdout, installResult.stderr].filter(Boolean).join('\n'),
      },
      { status: 500 },
    );
  }

  const initArgs = ['init', projectName, '--from', slug];
  if (targetPath) initArgs.push('--target', projectPath);
  const initResult = await run(PAPERCUSP_BIN, initArgs, env);
  if (initResult.code !== 0) {
    return NextResponse.json(
      {
        ok: false,
        error: 'papercusp init failed',
        log: [installResult.stdout, installResult.stderr, initResult.stdout, initResult.stderr]
          .filter(Boolean)
          .join('\n'),
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    projectSlug: projectName,
    projectPath,
    templateSlug: slug,
    attachedToExisting: !!targetPath,
    log: [installResult.stdout, initResult.stdout].filter(Boolean).join('\n'),
  });
}
