import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Marketplace catalog API.
 *
 * Proxies to the marketplace server at PAPERCUSP_MARKETPLACE_URL (default
 * http://localhost:3057). If the marketplace is unreachable, returns a
 * curated fallback list so the UI still renders something useful.
 */
// Plugins that aren't ready for users yet — hidden from every catalog
// surface (AddPluginButton, /marketplace/plugins, /installed/plugins).
// Match by the unscoped basename so `@papercupai/<x>` and a future
// rename don't slip through.
const HIDDEN_PLUGIN_BASENAMES = new Set([
  'notion-export',
  'slack-notifier',
  'vscode-server',
  'jira-sync',
]);
function isHidden(slugOrName: string | undefined | null): boolean {
  if (!slugOrName) return false;
  const base = slugOrName.includes('/') ? slugOrName.split('/').pop()! : slugOrName;
  return HIDDEN_PLUGIN_BASENAMES.has(base);
}
const FALLBACK_CATALOG = [
  {
    name: 'papercup-org',
    version: '0.1.0',
    description: '5-department fictional company with cross-dept message bus, directives, and an automated YouTube briefing pipeline.',
    author: 'Papercusp Team',
    license: 'MIT',
    plugins: ['briefings@0.1.0'],
    homepage: 'https://papercupai.com',
  },
  {
    name: 'papercup-coding',
    version: '0.1.0',
    description: 'Solo coding harness: scoper plans features, workers implement, validators verify, reviewers gate proposals. Drop in a SPEC.md and go.',
    author: 'Papercusp Team',
    license: 'MIT',
    plugins: [],
  },
];

export async function GET() {
  const base = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
  // Try DB-backed `/v1/catalog` first (sees R2-only publishes). Fall back to
  // the filesystem-backed `/catalog` if v1 isn't available (e.g. older
  // marketplace-api), then to the hardcoded list below.
  for (const path of ['/v1/catalog', '/catalog']) {
    try {
      const r = await fetch(`${base}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
      if (!r.ok) continue;
      const d = await r.json();
      const upstream = (d.catalog ?? []) as any[];
      // Reshape from marketplace's `{name, version, ...}` to UI's `{slug, name, install, ...}`.
      const items = upstream
        .filter((m: any) => !isHidden(m.slug ?? m.name))
        .map((m: any) => ({
          slug: m.slug ?? m.name,
          name: m.name ?? m.slug,
          version: m.version,
          description: m.description ?? '',
          author: m.author ?? 'unknown',
          license: m.license ?? 'unspecified',
          plugins: m.plugins ?? [],
          homepage: m.homepage ?? null,
          topology: m.topology ?? 'single',
          subprojects: Array.isArray(m.subprojects) ? m.subprojects : [],
          kind: m.kind ?? 'template',
          icon: m.icon ?? null,
          requiresTemplateKinds: Array.isArray(m.requiresTemplateKinds) ? m.requiresTemplateKinds : [],
          retracted: m.retracted,
          install: `papercusp install ${m.slug ?? m.name}`,
          source: 'live',
        }));
      return NextResponse.json({ catalog: items, source: path === '/v1/catalog' ? 'marketplace-db' : 'marketplace-fs' });
    } catch {
      continue;
    }
  }
  // Fallback when marketplace isn't reachable.
  const items = FALLBACK_CATALOG.map((m) => ({
    slug: m.name,
    name: m.name,
    version: m.version,
    description: m.description,
    author: m.author,
    license: m.license,
    plugins: m.plugins,
    homepage: m.homepage ?? null,
    install: `papercusp install ${m.name}`,
    source: 'fallback',
  }));
  return NextResponse.json({ catalog: items, source: 'fallback' });
}
