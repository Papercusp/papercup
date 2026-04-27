// Pattern 1 reconciliation: this endpoint is now a thin reshape of the
// canonical unified `/api/plugins/<slug>/contributions` endpoint.
//
// Why keep the alias instead of deleting? HarnessDashboard.tsx fetches from
// here and integrates plugin tabs inline alongside the legacy hard-coded
// docs/vscode/pi tabs. Migrating that integration to use the unified
// endpoint directly is a separate UI refactor — until then, keeping this
// alias means a single canonical data source (the unified manifest +
// contributions endpoint) without breaking the dashboard.
//
// The alias does the field-name remapping that historical clients expect:
//
//   /contributions  →  /api/plugin-tabs
//   pluginName      →  pluginSlug
//   id              →  tabId
//   (added)         →  pluginVersion (empty string for now)
//   (added)         →  enableFlag (read from PAPERCUSP_TABS_FROM_PLUGINS)
//
// Once HarnessDashboard.tsx switches to `/api/plugins/<slug>/contributions`
// directly, this file should be deleted.

interface ContributionsTab {
  pluginName: string;
  id: string;
  label: string;
  icon?: string;
  componentRoot?: string;
  componentId?: string;
  iframeUrl?: string;
  replaces?: string[];
}

interface ContributionsResponse {
  project: { slug: string; path: string | null };
  dashboardTabs: ContributionsTab[];
}

interface LegacyTab {
  pluginSlug: string;
  pluginVersion: string;
  tabId: string;
  label: string;
  icon: string | null;
  iframeUrl: string | null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const harnessSlug = url.searchParams.get('harness');
  if (!harnessSlug) {
    return Response.json({ error: 'harness query param required' }, { status: 400 });
  }

  const enableFlag = process.env.PAPERCUSP_TABS_FROM_PLUGINS === '1';

  // Call the unified canonical endpoint. Use the same origin so the
  // request stays in-process (Next routes through the same server).
  const origin = `${url.protocol}//${url.host}`;
  let body: ContributionsResponse;
  try {
    const r = await fetch(
      `${origin}/api/plugins/${encodeURIComponent(harnessSlug)}/contributions`,
      { cache: 'no-store' },
    );
    if (!r.ok) {
      return Response.json({ enableFlag, plugins: [] });
    }
    body = (await r.json()) as ContributionsResponse;
  } catch {
    return Response.json({ enableFlag, plugins: [] });
  }

  // Reshape to the legacy field names HarnessDashboard.tsx still expects.
  // Only iframe-mode tabs flow through the legacy path; React-mode tabs
  // (componentRoot + componentId) need the new <PluginTabs> renderer and
  // are out of scope here — drop them so the legacy path stays simple.
  const plugins: LegacyTab[] = body.dashboardTabs
    .filter((t) => typeof t.iframeUrl === 'string' && t.iframeUrl.length > 0)
    .map((t) => ({
      pluginSlug: t.pluginName,
      pluginVersion: '',  // not surfaced by the unified endpoint today
      tabId: t.id,
      label: t.label,
      icon: t.icon ?? null,
      iframeUrl: t.iframeUrl ?? null,
    }));

  return Response.json({ enableFlag, plugins });
}
