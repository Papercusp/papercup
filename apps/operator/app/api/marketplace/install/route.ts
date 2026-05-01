import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

import { papercuspPath } from '@/lib/papercusp-root';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED_ORIGINS = new Set([
  'http://localhost:3060',
  'http://127.0.0.1:3060',
  'https://papercuspai.com',
  'https://www.papercuspai.com',
]);

function corsHeaders(origin: string | null): HeadersInit {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
  }
  return {};
}

export function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

const MARKETPLACE_URL = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';

// Resolve the papercusp CLI: explicit env first, then walk up from CWD looking
// for sibling workspace `papercusp/packages/cli/bin/papercusp`, then fall back
// to PATH lookup. Cached after first resolution.
let cachedCli: string | null = null;
// Best-effort: locate the Papercusp desktop app binary so we can launch it
// after a successful install. Returns null when no built/installed copy is
// found — the marketplace UI then opens the operator URL in a new browser tab.
function resolveDesktopBin(): string | null {
  if (process.env.PAPERCUSP_DESKTOP_BIN && existsSync(process.env.PAPERCUSP_DESKTOP_BIN)) {
    return process.env.PAPERCUSP_DESKTOP_BIN;
  }
  const home = homedir();
  const candidates =
    platform() === 'darwin'
      ? [
          '/Applications/Papercusp.app',
          join(home, 'Applications', 'Papercusp.app'),
        ]
      : platform() === 'win32'
      ? [
          join(home, 'AppData', 'Local', 'Papercusp', 'Papercusp.exe'),
          'C:\\Program Files\\Papercusp\\Papercusp.exe',
        ]
      : [
          // Linux — built bundles + dev target dir
          '/usr/local/bin/papercusp-desktop',
          '/usr/bin/papercusp-desktop',
          join(home, '.local', 'bin', 'papercusp-desktop'),
          join(home, 'papercupai-workspace', 'papercusp-desktop', 'src-tauri', 'target', 'release', 'papercusp-desktop'),
          join(home, 'papercupai-workspace', 'papercusp-desktop', 'src-tauri', 'target', 'debug', 'papercusp-desktop'),
        ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function launchDesktopBin(bin: string): { ok: true } | { ok: false; error: string } {
  try {
    if (platform() === 'darwin' && bin.endsWith('.app')) {
      spawn('open', [bin], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn(bin, [], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function resolvePapercuspCli(): string {
  if (cachedCli) return cachedCli;
  if (process.env.PAPERCUSP_CLI && existsSync(process.env.PAPERCUSP_CLI)) {
    cachedCli = process.env.PAPERCUSP_CLI;
    return cachedCli;
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'papercusp', 'packages', 'cli', 'bin', 'papercusp');
    if (existsSync(candidate)) {
      cachedCli = candidate;
      return cachedCli;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedCli = process.env.PAPERCUSP_CLI ?? 'papercusp';
  return cachedCli;
}

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
    papercuspPath('registry.json'),
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
  const harnessTemplateRoot = papercuspPath('harnesses', slug);
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
  const cors = corsHeaders(req.headers.get('origin'));
  const json = (data: unknown, init?: { status?: number }) =>
    NextResponse.json(data, { status: init?.status ?? 200, headers: cors });

  let body: { slug?: string; projectName?: string; targetPath?: string; harness?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid json body' }, { status: 400 });
  }
  const slug = String(body.slug ?? '').trim();
  const projectName = String(body.projectName ?? slug).trim();
  const rawTarget = typeof body.targetPath === 'string' ? body.targetPath.trim() : '';
  const targetPath = rawTarget.length > 0 ? rawTarget : null;
  const harnessSlug = typeof body.harness === 'string' ? body.harness.trim() : '';

  if (!isValidSlug(slug)) return json({ ok: false, error: `invalid slug "${slug}"` }, { status: 400 });

  // ── subagent-pack branch ─────────────────────────────────────────────
  // Pre-flight the manifest so we know if this install needs the harness
  // scaffolding flow (default) or the subagent-pack flow (copy md files
  // into <harness>/.omp/agents/). Subagent packs need a target harness;
  // they don't create new projects.
  const catalogManifest = await fetchCatalogManifest(slug);
  if (catalogManifest?.kind === 'subagent-pack') {
    if (!harnessSlug || !isValidSlug(harnessSlug)) {
      return json(
        { ok: false, error: `subagent-pack install requires "harness": "<existing-slug>" in body` },
        { status: 400 },
      );
    }
    const env = { ...process.env, PAPERCUSP_MARKETPLACE_URL: MARKETPLACE_URL };
    const installResult = await run(resolvePapercuspCli(), ['install', slug], env);
    if (installResult.code !== 0) {
      return json(
        { ok: false, error: 'papercusp install failed', log: [installResult.stdout, installResult.stderr].filter(Boolean).join('\n') },
        { status: 500 },
      );
    }
    const subResult = await installSubagentPack(slug, harnessSlug, catalogManifest);
    if (!subResult.ok) {
      return json(
        { ok: false, error: subResult.error, log: installResult.stdout },
        { status: subResult.status },
      );
    }
    return json({
      ok: true,
      kind: 'subagent-pack',
      templateSlug: slug,
      harnessSlug,
      targetDir: subResult.targetDir,
      copied: subResult.copied,
      log: installResult.stdout,
    });
  }

  // ── snapshot branch ──────────────────────────────────────────────────
  // Snapshots fork into a brand-new harness (registered in the CLI's
  // registry.json), not "install + init" the way templates do. Delegate
  // to `papercusp snapshot fork`, which handles tarball download +
  // extract + registry write atomically.
  if (catalogManifest?.kind === 'snapshot') {
    const env = { ...process.env, PAPERCUSP_MARKETPLACE_URL: MARKETPLACE_URL };
    // If the caller explicitly passed a project name (different from the
    // snapshot slug — projectName defaults to slug above), forward it; else
    // let the fork CLI auto-derive (<sourceHarness>-fork[-<n>]) — that's
    // the saner default for "browse → click Fork" without naming it.
    const forkArgs = ['snapshot', 'fork', slug];
    const explicitName = body.projectName && body.projectName !== slug ? body.projectName.trim() : null;
    if (explicitName && isValidSlug(explicitName)) forkArgs.push(explicitName);
    const forkResult = await run(resolvePapercuspCli(), forkArgs, env);
    if (forkResult.code !== 0) {
      return json(
        {
          ok: false,
          error: 'papercusp snapshot fork failed',
          log: [forkResult.stdout, forkResult.stderr].filter(Boolean).join('\n'),
        },
        { status: 500 },
      );
    }
    // Read registry.json to discover the slug the CLI picked + its path.
    let forkedSlug: string | null = null;
    let forkedPath: string | null = null;
    try {
      const regRaw = await fs.readFile(papercuspPath('registry.json'), 'utf8');
      const reg = JSON.parse(regRaw) as { projects?: Array<{ slug: string; path: string; addedAt?: string }> };
      // Newest entry by addedAt is the fork we just made.
      const projects = reg.projects ?? [];
      const sorted = [...projects].sort((a, b) =>
        (b.addedAt ?? '').localeCompare(a.addedAt ?? ''),
      );
      if (sorted[0]) {
        forkedSlug = sorted[0].slug;
        forkedPath = sorted[0].path;
      }
    } catch {
      // Best-effort; if registry read fails the fork still succeeded.
    }

    const desktopBin = resolveDesktopBin();
    let desktopLaunched = false;
    let desktopError: string | undefined;
    if (desktopBin) {
      const launch = launchDesktopBin(desktopBin);
      if (launch.ok) desktopLaunched = true;
      else desktopError = launch.error;
    }

    return json({
      ok: true,
      kind: 'snapshot',
      templateSlug: slug,
      projectSlug: forkedSlug ?? slug,
      projectPath: forkedPath ?? '(unknown)',
      log: forkResult.stdout,
      desktop: { launched: desktopLaunched, bin: desktopBin, error: desktopError },
    });
  }

  if (!isValidSlug(projectName)) return json({ ok: false, error: `invalid project name "${projectName}"` }, { status: 400 });

  // Resolve where the project will live + validate up front.
  let projectPath: string;
  if (targetPath) {
    if (!targetPath.startsWith('/') && !targetPath.startsWith('~')) {
      return json(
        { ok: false, error: `target path must be absolute (got "${targetPath}")` },
        { status: 400 },
      );
    }
    projectPath = targetPath.startsWith('~') ? join(homedir(), targetPath.slice(1)) : targetPath;
    if (!existsSync(projectPath)) {
      return json(
        { ok: false, error: `target path "${projectPath}" does not exist` },
        { status: 400 },
      );
    }
    if (existsSync(join(projectPath, '.harness'))) {
      return json(
        { ok: false, error: `target "${projectPath}" already has a .harness/ — already initialized?` },
        { status: 409 },
      );
    }
  } else {
    const projectsRoot = process.env.PAPERCUSP_PROJECTS_ROOT ?? papercuspPath('projects');
    projectPath = join(projectsRoot, projectName);
    if (existsSync(projectPath)) {
      return json(
        { ok: false, error: `project "${projectName}" already exists at ${projectPath}` },
        { status: 409 },
      );
    }
  }

  const env = {
    ...process.env,
    PAPERCUSP_MARKETPLACE_URL: MARKETPLACE_URL,
  };

  const installResult = await run(resolvePapercuspCli(), ['install', slug], env);
  if (installResult.code !== 0) {
    return json(
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
  const initResult = await run(resolvePapercuspCli(), initArgs, env);
  if (initResult.code !== 0) {
    return json(
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

  // Fire onHarnessCreated lifecycle for every loaded plugin enabled on
  // this new harness. Best-effort: a failing plugin (e.g. github-repo
  // can't reach GitHub) shouldn't block the install; errors are logged
  // by firePluginLifecycle's per-plugin try/catch.
  try {
    const { firePluginLifecycle } = await import('../../../../lib/plugin-host-runtime');
    await firePluginLifecycle('onHarnessCreated', {
      installSlug: projectName,
      projectDir: projectPath,
      stateDir: join(projectPath, '.harness'),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[install] onHarnessCreated dispatch failed:', e);
  }

  // Best-effort: launch the desktop app if it's installed/built.
  const desktopBin = resolveDesktopBin();
  let desktopLaunched = false;
  let desktopError: string | undefined;
  if (desktopBin) {
    const launch = launchDesktopBin(desktopBin);
    if (launch.ok) desktopLaunched = true;
    else desktopError = launch.error;
  }

  return json({
    ok: true,
    projectSlug: projectName,
    projectPath,
    templateSlug: slug,
    attachedToExisting: !!targetPath,
    log: [installResult.stdout, initResult.stdout].filter(Boolean).join('\n'),
    desktop: { launched: desktopLaunched, bin: desktopBin, error: desktopError },
  });
}
