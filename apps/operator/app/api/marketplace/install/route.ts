import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PAPERCUSP_BIN = process.env.PAPERCUSP_CLI ?? 'papercusp';
const MARKETPLACE_URL = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';

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

async function fetchCatalogManifest(slug: string): Promise<{ kind?: string; install_target?: string; agents?: string[] } | null> {
  try {
    const r = await fetch(`${MARKETPLACE_URL}/catalog/${encodeURIComponent(slug)}`);
    if (!r.ok) return null;
    const d = (await r.json()) as { latest?: any };
    return d.latest ?? null;
  } catch {
    return null;
  }
}

async function lookupHarnessPath(slug: string): Promise<string | null> {
  // Try the canonical registry first, then the legacy file (kept in sync).
  const candidates = [
    join(homedir(), '.papercusp', 'registry.json'),
    join(homedir(), '.restart-harness-projects.json'),
  ];
  for (const reg of candidates) {
    try {
      const raw = await fs.readFile(reg, 'utf8');
      const parsed = JSON.parse(raw) as { projects?: Array<{ slug?: string; path?: string }> };
      const found = parsed.projects?.find((p) => p?.slug === slug);
      if (found?.path) return found.path;
    } catch {
      // try next
    }
  }
  return null;
}

async function installSubagentPack(
  slug: string,
  harnessSlug: string,
  manifest: { agents?: string[]; install_target?: string },
): Promise<{ ok: true; targetDir: string; copied: string[] } | { ok: false; error: string; status: number }> {
  // Resolve target harness's project root from the registry. Harnesses can
  // live anywhere (existing-repo --target installs put them outside
  // ~/.papercusp/projects/), so we always look up the real path.
  const harnessRoot = await lookupHarnessPath(harnessSlug);
  if (!harnessRoot || !existsSync(harnessRoot)) {
    return { ok: false, status: 400, error: `harness "${harnessSlug}" not found in registry (or path missing on disk)` };
  }
  const installTarget = (manifest.install_target ?? '.omp/agents').replace(/^\/+/, '');
  const targetDir = join(harnessRoot, installTarget);
  await fs.mkdir(targetDir, { recursive: true });

  // Source dir is in ~/.papercusp/harnesses/<slug>/agents/
  // (papercusp install drops the unpacked tarball there)
  const harnessTemplateRoot = join(homedir(), '.papercusp', 'harnesses', slug);
  const agentsSrc = join(harnessTemplateRoot, 'agents');
  if (!existsSync(agentsSrc)) {
    return { ok: false, status: 500, error: `agents/ directory not found in installed template at ${agentsSrc}` };
  }
  const entries = await fs.readdir(agentsSrc);
  const copied: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const src = join(agentsSrc, name);
    const dest = join(targetDir, name);
    await fs.copyFile(src, dest);
    copied.push(name);
  }
  return { ok: true, targetDir, copied };
}

export async function POST(req: Request) {
  let body: { slug?: string; projectName?: string; targetPath?: string; harness?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json body' }, { status: 400 });
  }
  const slug = String(body.slug ?? '').trim();
  const projectName = String(body.projectName ?? slug).trim();
  const rawTarget = typeof body.targetPath === 'string' ? body.targetPath.trim() : '';
  const targetPath = rawTarget.length > 0 ? rawTarget : null;
  const harnessSlug = typeof body.harness === 'string' ? body.harness.trim() : '';

  if (!isValidSlug(slug)) return NextResponse.json({ ok: false, error: `invalid slug "${slug}"` }, { status: 400 });

  // ── subagent-pack branch ─────────────────────────────────────────────
  // Pre-flight the manifest so we know if this install needs the harness
  // scaffolding flow (default) or the subagent-pack flow (copy md files
  // into <harness>/.omp/agents/). Subagent packs need a target harness;
  // they don't create new projects.
  const catalogManifest = await fetchCatalogManifest(slug);
  if (catalogManifest?.kind === 'subagent-pack') {
    if (!harnessSlug || !isValidSlug(harnessSlug)) {
      return NextResponse.json(
        { ok: false, error: `subagent-pack install requires "harness": "<existing-slug>" in body` },
        { status: 400 },
      );
    }
    const env = { ...process.env, PAPERCUSP_MARKETPLACE_URL: MARKETPLACE_URL };
    const installResult = await run(PAPERCUSP_BIN, ['install', slug], env);
    if (installResult.code !== 0) {
      return NextResponse.json(
        { ok: false, error: 'papercusp install failed', log: [installResult.stdout, installResult.stderr].filter(Boolean).join('\n') },
        { status: 500 },
      );
    }
    const subResult = await installSubagentPack(slug, harnessSlug, catalogManifest);
    if (!subResult.ok) {
      return NextResponse.json(
        { ok: false, error: subResult.error, log: installResult.stdout },
        { status: subResult.status },
      );
    }
    return NextResponse.json({
      ok: true,
      kind: 'subagent-pack',
      templateSlug: slug,
      harnessSlug,
      targetDir: subResult.targetDir,
      copied: subResult.copied,
      log: installResult.stdout,
    });
  }

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
    PAPERCUSP_MARKETPLACE_URL: MARKETPLACE_URL,
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
