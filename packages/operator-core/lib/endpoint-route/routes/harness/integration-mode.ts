/**
 * P-017 (pot-review-integration-mode-2026-10-05, D-007): the pot-settings form of
 * the ONE question "Where should the agents' work go?".
 *
 *   GET /harness/:slug/integration-mode → the question (owner-approved wording,
 *       repo name substituted, option availability) + the pot's current answer.
 *   PUT /harness/:slug/integration-mode { mode } → switch through
 *       choosePotIntegrationMode, the same seam pot creation uses: switching to
 *       the working copy creates and records the pot's fork first, and is refused
 *       in plain language when the pot has no test suite. Users never see
 *       low-level git settings.
 *
 * Handlers are built by makeIntegrationModeRoutes(deps) so tests inject the
 * registry, the setting read, the suite resolver and the switch.
 */
import { defineTool } from '@papercusp/agent-mcp';
import type {
  ChoosePotIntegrationModeInput,
  ChoosePotIntegrationModeResult,
  PotIntegrationModeRead,
} from '../../../harness/git-sync/pot-integration-mode';
import {
  integrationModeQuestion,
  parseIntegrationModeAnswer,
} from '../../../harness/git-sync/integration-mode-question';

/** The registry fields this route reads (a subset of the harness registry entry). */
export interface IntegrationModeRegistryEntry {
  slug: string;
  hive_slug?: string;
  self_repo?: boolean;
  github_remote?: string;
  fork_remote?: string;
}

export interface IntegrationModeRouteDeps {
  loadProjects: () => Promise<IntegrationModeRegistryEntry[]>;
  workspaceId: () => Promise<string>;
  readMode: (workspaceId: string, potHomeSlug: string) => Promise<PotIntegrationModeRead>;
  resolveSuite: (slug: string, workspaceId: string) => Promise<string | null>;
  choose: (input: ChoosePotIntegrationModeInput) => Promise<ChoosePotIntegrationModeResult>;
}

/** "owner/repo" for a GitHub remote; the raw remote otherwise; '' when absent. */
export function repoLabelFromRemote(remote: string | undefined | null): string {
  if (!remote) return '';
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : remote.trim();
}

type Resolved =
  | { ok: true; entry: IntegrationModeRegistryEntry; potHomeSlug: string }
  | { ok: false; response: Response };

async function resolvePot(deps: IntegrationModeRouteDeps, slug: string): Promise<Resolved> {
  const entry = (await deps.loadProjects()).find((p) => p.slug === slug);
  if (!entry) return { ok: false, response: Response.json({ error: 'unknown harness' }, { status: 404 }) };
  const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
  if (!potHomeSlug) {
    return {
      ok: false,
      response: Response.json(
        { error: 'not_a_pot', message: 'This project is not a pot, so there is no shared agent work to route.' },
        { status: 409 },
      ),
    };
  }
  return { ok: true, entry, potHomeSlug };
}

export function makeIntegrationModeRoutes(deps: IntegrationModeRouteDeps) {
  const get = defineTool({
    method: 'GET',
    path: '/harness/:slug/integration-mode',
    auth: 'loopback',
    async handler(_req, ctx) {
      const r = await resolvePot(deps, ctx.params.slug as string);
      if (!r.ok) return r.response;
      const ws = await deps.workspaceId();
      // Unknown (resolver failed) leaves the working copy selectable; the PUT re-checks.
      const greenCmd = await deps.resolveSuite(r.entry.slug, ws).catch(() => undefined);
      const hasTestSuite = greenCmd === undefined ? undefined : Boolean(greenCmd && greenCmd.trim());
      const current = await deps.readMode(ws, r.potHomeSlug);
      return Response.json({
        question: integrationModeQuestion({ repoLabel: repoLabelFromRemote(r.entry.github_remote), hasTestSuite }),
        current: current.mode,
        workingCopyUrl: r.entry.fork_remote ?? null,
      });
    },
  });

  const put = defineTool({
    method: 'PUT',
    path: '/harness/:slug/integration-mode',
    auth: 'loopback',
    async handler(req, ctx) {
      const r = await resolvePot(deps, ctx.params.slug as string);
      if (!r.ok) return r.response;
      const body = (await req.json().catch(() => ({}))) as { mode?: unknown };
      const mode = parseIntegrationModeAnswer(body.mode);
      if (!mode) {
        return Response.json({ error: 'mode_required', message: "mode must be 'direct' or 'review'" }, { status: 400 });
      }
      const ws = await deps.workspaceId();
      const greenCmd = await deps.resolveSuite(r.entry.slug, ws).catch(() => null);
      const result = await deps.choose({
        workspaceId: ws,
        potHomeSlug: r.potHomeSlug,
        harnessSlug: r.entry.slug,
        mode,
        greenCmd,
        forkRemote: r.entry.fork_remote ?? null,
        upstreamRemote: r.entry.github_remote ?? null,
      });
      if (!result.ok) return Response.json(result, { status: 409 });
      return Response.json(result);
    },
  });

  return [get, put];
}

export default makeIntegrationModeRoutes({
  loadProjects: async () => (await import('../../../harness-registry')).loadHarnessRegistry().then((r) => r.projects),
  workspaceId: async () => (await import('../../../workspace-registry')).activeWorkspaceId(),
  readMode: async (ws, pot) =>
    (await import('../../../harness/git-sync/pot-integration-mode')).readPotIntegrationMode(ws, pot),
  resolveSuite: async (slug, ws) =>
    (await import('../../../harness/routines/hive-release-env')).resolvePotSuiteCommand(slug, ws),
  choose: async (input) =>
    (await import('../../../harness/git-sync/pot-integration-mode')).choosePotIntegrationMode(input),
});
