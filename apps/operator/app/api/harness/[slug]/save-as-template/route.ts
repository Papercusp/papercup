/**
 * POST /api/harness/:slug/save-as-template
 *
 * Forks the harness's *recipe* (no mid-mission state) into
 * `~/.papercusp/templates/<newSlug>/<version>/`, ready to be edited or
 * published via `POST /api/templates/<slug>/<version>/publish`.
 *
 * Recipe = papercusp.json + the four canonical config files
 * (SPEC.md, AGENTS.md, .harness/config.json, .harness/validation-contract.md)
 * + recommended plugins lifted from `enabled-plugins.json`. Anything else
 * lives in snapshots, not templates.
 */

import { NextResponse } from 'next/server';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { papercuspPath } from '@/lib/papercusp-root';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { loadHarnessRegistry } from '@/lib/harness-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// Accepts numeric-major.minor.patch with optional `-prerelease`,
// optional `+build`, or both in that order (semver §9 + §10). Bug
// caught by SEMVER_RE.test('1.0.0-rc.1+build.5') returning false
// before this loosening.
export const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

interface Body {
  slug: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
}

// Files that make up a template recipe. Path is relative to the
// harness project directory; targetPath is where it lands in the
// template dir (usually identical). Missing source files are skipped
// silently — legacy harnesses created before SPEC.md was canonical
// shouldn't fail the whole save.
const RECIPE_FILES: { from: string; to: string; required?: boolean }[] = [
  { from: 'SPEC.md', to: 'SPEC.md' },
  { from: 'AGENTS.md', to: 'AGENTS.md' },
  { from: '.harness/config.json', to: '.harness/config.json' },
  { from: '.harness/validation-contract.md', to: '.harness/validation-contract.md' },
];

const CONFIG_FILE_DESCRIPTIONS: Record<string, { label: string; language: string; description: string }> = {
  'SPEC.md': {
    label: 'SPEC.md',
    language: 'markdown',
    description: 'What this project should accomplish — read by every role on every iteration.',
  },
  'AGENTS.md': {
    label: 'AGENTS.md',
    language: 'markdown',
    description: 'Coding conventions, libraries to prefer, idioms to avoid — applied by the worker.',
  },
  '.harness/config.json': {
    label: 'config.json',
    language: 'json',
    description: 'Phase, model preferences per role, timeouts, cost cap.',
  },
  '.harness/validation-contract.md': {
    label: 'validation-contract.md',
    language: 'markdown',
    description: 'What "passing" means — the validator enforces this against every worker proposal.',
  },
};

interface EnabledPluginsFile {
  enabled?: Record<string, { version?: string; enabledAt?: string; configHash?: string }>;
}

async function readEnabledPlugins(harnessSlug: string): Promise<{ slug: string; version: string; autoEnable: true }[]> {
  const path = papercuspPath('harnesses', harnessSlug, 'enabled-plugins.json');
  if (!existsSync(path)) return [];
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as EnabledPluginsFile;
    const enabled = parsed.enabled ?? {};
    return Object.entries(enabled).map(([slug, meta]) => ({
      slug,
      version: meta.version ?? '0.0.0',
      autoEnable: true,
    }));
  } catch {
    return [];
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const blocked = await gateApiRoute(req, FLAGS.TEMPLATES);
  if (blocked) return blocked;
  const { slug: harnessSlug } = await ctx.params;
  if (!SLUG_RE.test(harnessSlug)) {
    return NextResponse.json({ ok: false, error: 'invalid harness slug' }, { status: 400 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json body' }, { status: 400 });
  }

  const newSlug = String(body.slug ?? '').trim();
  const version = String(body.version ?? '').trim();
  if (!SLUG_RE.test(newSlug)) {
    return NextResponse.json({ ok: false, error: `invalid template slug "${newSlug}"` }, { status: 400 });
  }
  if (!SEMVER_RE.test(version)) {
    return NextResponse.json({ ok: false, error: `invalid semver "${version}"` }, { status: 400 });
  }

  const reg = await loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === harnessSlug);
  if (!project) {
    return NextResponse.json({ ok: false, error: `unknown harness "${harnessSlug}"` }, { status: 404 });
  }

  const targetDir = papercuspPath('templates', newSlug, version);
  if (existsSync(targetDir)) {
    return NextResponse.json(
      { ok: false, error: `template ${newSlug}@${version} already exists at ${targetDir}` },
      { status: 409 },
    );
  }

  await fs.mkdir(targetDir, { recursive: true });

  const copied: string[] = [];
  for (const f of RECIPE_FILES) {
    const src = join(project.path, f.from);
    if (!existsSync(src)) continue;
    const dst = join(targetDir, f.to);
    await fs.mkdir(dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    copied.push(f.to);
  }

  const plugins = await readEnabledPlugins(harnessSlug);

  // Pull existing manifest from the harness if present (legacy harnesses
  // may have none) so we preserve `models`, `papercusp` version pin, etc.
  let baseManifest: Record<string, unknown> = {};
  const harnessManifestCandidates = [
    join(project.path, '.harness', 'papercusp.json'),
    join(project.path, 'papercusp.json'),
  ];
  for (const candidate of harnessManifestCandidates) {
    if (!existsSync(candidate)) continue;
    try {
      baseManifest = JSON.parse(await fs.readFile(candidate, 'utf8')) as Record<string, unknown>;
      break;
    } catch {
      // ignore parse errors — fall through to next candidate
    }
  }

  const configFiles = copied
    .filter((p) => CONFIG_FILE_DESCRIPTIONS[p])
    .map((p) => ({ path: p, ...CONFIG_FILE_DESCRIPTIONS[p] }));

  const manifest = {
    ...baseManifest,
    name: newSlug,
    version,
    kind: 'template',
    description: body.description?.trim() || (baseManifest.description as string | undefined) || `Template forked from ${harnessSlug}`,
    author: body.author?.trim() || (baseManifest.author as string | undefined) || '',
    license: body.license?.trim() || (baseManifest.license as string | undefined) || 'MIT',
    papercusp: (baseManifest.papercusp as string | undefined) ?? '^0.1.0',
    plugins,
    configFiles,
    forkedFrom: {
      at: new Date().toISOString(),
      harness: harnessSlug,
    },
  };

  await fs.writeFile(
    join(targetDir, 'papercusp.json'),
    JSON.stringify(manifest, null, 2),
  );

  return NextResponse.json({
    ok: true,
    slug: newSlug,
    version,
    path: targetDir,
    copied,
    pluginRecs: plugins.length,
    editPath: `/installed/templates/${encodeURIComponent(newSlug)}`,
  });
}
