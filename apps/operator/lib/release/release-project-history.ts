/** Thin release-registry adapter for the shared Project History contract. */
import { build, transformSync } from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  assembleProjectHistory,
  assertProjectHistoryDocument,
  type ProjectHistoryDocument,
  type ProjectHistoryWorkItemInput,
} from '@papercusp/plan-parser/project-history';
import type { HydratedRelease } from './release-history-page';
import { identityLiterals, scrubIdentity, type IdentityLiteral } from './release-content-scrub';
import type { Scope } from './release-registry';

export function releaseHistoryStem(version: string, channel: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || !/^(stable|beta|alpha)$/.test(channel)) {
    throw new Error('Invalid release history version or channel');
  }
  return `desktop-v${version}-${channel}`;
}

export function releaseProjectHistory(
  release: HydratedRelease,
  scope: Scope,
  redact: IdentityLiteral[] = identityLiterals(),
): ProjectHistoryDocument {
  const included = new Set(release.row.workItemIds);
  const items = release.items.filter((item) => included.has(item.id));
  const plans = release.plans.filter((plan) => release.row.planSlugs.includes(plan.slug));
  const bySlug = new Map(plans.map((plan) => [plan.slug, plan]));
  const unplanned = items.filter((item) => !item.planSlug || !bySlug.has(item.planSlug));
  const workItem = (item: typeof items[number]): ProjectHistoryWorkItemInput => ({
    id: item.id,
    title: item.title,
    kind: item.kind ?? 'work-item',
    state: item.state ?? 'unknown',
    completedAt: item.closedAt ?? null,
    completionAuthority: item.completionAuthority ?? null,
    completionSummary: item.terminalCompletionEvidence?.summary ?? null,
    completionEvidence: item.terminalCompletionEvidence
      ? { ...item.terminalCompletionEvidence }
      : null,
  });
  const document = assembleProjectHistory({
    project: { id: 'papercusp', name: 'Papercusp', repository: null },
    source: {
      kind: 'papercusp-plan-export',
      workspace: scope.workspaceId,
      harness: scope.harnessSlug,
      planPrefix: null,
      generatedAt: release.row.cutAt.toISOString(),
      generator: 'papercusp-release-project-history',
    },
    plans: [
      ...plans.map((plan) => ({
        // Use canonical markdown, including its validation assertions and decisions.
        markdown: plan.content.startsWith('---\n') ? plan.content :
          `---\nslug: ${JSON.stringify(plan.slug)}\ntitle: ${JSON.stringify(plan.title)}\nstatus: ${JSON.stringify(plan.status)}\n---\n${plan.content}`,
        filePath: `${plan.slug}.md`,
        completedItems: items.filter((item) => item.planSlug === plan.slug).map(workItem),
      })),
      ...(unplanned.length ? [{
        markdown: '---\nslug: release-unplanned-work\ntitle: Other completed work\nstatus: shipped\n---\nWork recorded in this release without an available plan document.\n',
        completedItems: unplanned.map(workItem),
      }] : []),
    ],
  });
  // The assembler can infer completions from the current plan's WI markers.
  // Those may have landed AFTER this release. Its frozen registry membership wins.
  for (const plan of document.plans) {
    const explicitIds = new Set((plan.slug === 'release-unplanned-work' ? unplanned :
      items.filter((item) => item.planSlug === plan.slug)).map((item) => item.id));
    plan.completedItems = plan.completedItems.filter((item) => explicitIds.has(item.id));
  }
  // Scrub the complete serialized artifact, just like history.json. Validate the
  // final bytes too: a redaction must never produce malformed public JSON.
  return assertProjectHistoryDocument(JSON.parse(scrubIdentity(JSON.stringify(document), redact)));
}

/** Self-hosted assets: no live operator, database, or public CDN is needed. */
export async function buildReleaseHistoryAssets(outDir: string): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '../../../..');
  const assets = path.join(outDir, 'assets');
  fs.mkdirSync(outDir, { recursive: true });
  const staged = fs.mkdtempSync(path.join(outDir, '.history-assets-'));
  try {
    await build({
    // Keep the executed browser entry repo-relative and literal: the module-reachability
    // guard can then prove this file is a production caller even though esbuild loads it
    // by path rather than through a JavaScript import edge.
    entryPoints: {
      'project-history': path.join(
        root,
        'apps/operator/lib/release/release-project-history-client.tsx',
      ),
    },
    outdir: staged,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    minify: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'file' },
    });
    const require = createRequire(import.meta.url);
    const vditorDist = path.dirname(require.resolve('vditor/dist/index.min.js'));
    const mirror = path.join(staged, 'vditor', 'dist');
    fs.cpSync(vditorDist, mirror, {
    recursive: true,
    // Development source/maps are not runtime dependencies of the preview.
    filter: (source) => !source.endsWith('.map') && !source.endsWith('.d.ts') && source !== path.join(vditorDist, 'index.js'),
    });
    normalizeReleaseHistoryAssets(mirror);
    // A reused output directory must not retain excluded development files or
    // old source maps. Replace only this generator's completed asset output.
    fs.rmSync(assets, { recursive: true, force: true });
    fs.renameSync(staged, assets);
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

/** Strip development comments from the third-party runtime before privacy scanning. */
export function normalizeReleaseHistoryAssets(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) normalizeReleaseHistoryAssets(file);
    else if (/\.(js|css)$/.test(entry.name)) {
      const text = fs.readFileSync(file, 'utf8');
      // MathJax ships JSON dictionaries with a .js suffix; they are data.
      try { JSON.parse(text); continue; } catch { /* JavaScript or CSS */ }
      const { code } = transformSync(text, {
        loader: entry.name.endsWith('.css') ? 'css' : 'js', minify: true, legalComments: 'none',
      });
      // Checkpoint node_modules is materialized from an immutable dependency
      // generation. Its files are deliberately 0444, and fs.cpSync preserves
      // that mode in this private staging tree. Make only the staged copy
      // owner-writable before replacing its normalized contents; the source
      // generation remains immutable and its hardlinked inode is untouched.
      const mode = fs.statSync(file).mode;
      if ((mode & 0o200) === 0) fs.chmodSync(file, mode | 0o200);
      fs.writeFileSync(file, code);
    }
  }
}
