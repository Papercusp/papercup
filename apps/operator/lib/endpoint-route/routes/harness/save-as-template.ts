/**
 * POST /api/harness/:slug/save-as-template
 *
 * Forks harness recipe into ~/.papercusp/templates/<newSlug>/<version>/.
 * Recipe = papercusp.json + canonical config files + recommended plugins.
 *
 * Ported from app/api/harness/[slug]/save-as-template/route.ts.
 * `auth: 'public'` — FLAGS.TEMPLATES gate preserved.
 */
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { papercuspPath } from '@/lib/papercusp-root';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { loadHarnessRegistry } from '@/lib/harness-registry';
import { defineTool } from '@papercusp/agent-mcp';

export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

interface Body {
  slug: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
}

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

export default defineTool({
  method: 'POST',
  path: '/harness/:slug/save-as-template',
  auth: 'public',
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.TEMPLATES);
    if (blocked) return blocked;
    const harnessSlug = ctx.params.slug as string;
    if (!SLUG_RE.test(harnessSlug)) {
      return Response.json({ ok: false, error: 'invalid harness slug' }, { status: 400 });
    }

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return Response.json({ ok: false, error: 'invalid json body' }, { status: 400 });
    }

    const newSlug = String(body.slug ?? '').trim();
    const version = String(body.version ?? '').trim();
    if (!SLUG_RE.test(newSlug)) {
      return Response.json({ ok: false, error: `invalid template slug "${newSlug}"` }, { status: 400 });
    }
    if (!SEMVER_RE.test(version)) {
      return Response.json({ ok: false, error: `invalid semver "${version}"` }, { status: 400 });
    }

    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((p) => p.slug === harnessSlug);
    if (!project) {
      return Response.json({ ok: false, error: `unknown harness "${harnessSlug}"` }, { status: 404 });
    }

    const targetDir = papercuspPath('templates', newSlug, version);
    if (existsSync(targetDir)) {
      return Response.json(
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

    let baseManifest: Record<string, unknown> = {};
    const harnessManifestCandidates = [
      join(project.path, '.harness', 'papercusp.json'),
      join(project.path, 'papercusp.json'),
    ];
    // perf:allow A1 — find-first over 2 bounded manifest candidates, break on first.
    for (const candidate of harnessManifestCandidates) {
      if (!existsSync(candidate)) continue;
      try {
        baseManifest = JSON.parse(await fs.readFile(candidate, 'utf8')) as Record<string, unknown>;
        break;
      } catch { /* ignore */ }
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

    return Response.json({
      ok: true,
      slug: newSlug,
      version,
      path: targetDir,
      copied,
      pluginRecs: plugins.length,
      editPath: `/installed/templates/${encodeURIComponent(newSlug)}`,
    });
  },
});
