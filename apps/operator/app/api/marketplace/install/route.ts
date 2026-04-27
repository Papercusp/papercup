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
  let body: { slug?: string; projectName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json body' }, { status: 400 });
  }
  const slug = String(body.slug ?? '').trim();
  const projectName = String(body.projectName ?? slug).trim();

  if (!isValidSlug(slug)) return NextResponse.json({ ok: false, error: `invalid slug "${slug}"` }, { status: 400 });
  if (!isValidSlug(projectName)) return NextResponse.json({ ok: false, error: `invalid project name "${projectName}"` }, { status: 400 });

  const projectsRoot = process.env.PAPERCUSP_PROJECTS_ROOT ?? join(homedir(), '.papercusp', 'projects');
  const projectPath = join(projectsRoot, projectName);
  if (existsSync(projectPath)) {
    return NextResponse.json(
      { ok: false, error: `project "${projectName}" already exists at ${projectPath}` },
      { status: 409 },
    );
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

  const initResult = await run(PAPERCUSP_BIN, ['init', projectName, '--from', slug], env);
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
    log: [installResult.stdout, initResult.stdout].filter(Boolean).join('\n'),
  });
}
