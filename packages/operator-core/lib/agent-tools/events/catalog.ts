/**
 * events:catalog — "what can I wait on?" in one call
 * (event-await-discoverability-and-coverage-2026-07-03 P-002, D-001/D-005).
 *
 * The whole plan's headline is a DISCOVERABILITY gap: the await primitive works,
 * but agents poll (`dev:pipeline_position`, `dev:build_status`) because they never
 * find the event key that already fires. This tool renders the awaitable-key
 * registry (`events/await/catalog.ts` — the single source of truth) so the answer
 * to "is there an event for X?" is one read, not a code grep. It is the read-side
 * companion to `events:graph` (which shows server REACTIONS, not agent AWAITS).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  mergeInstalledEventCatalog,
  renderCatalog,
  familyKeyPrefix,
  type CatalogRow,
  type EventFamilyCollision,
  type InstalledUnitEvents,
} from '../../events/await/catalog';
import { readInstalledUnitEvents } from '../../events/await/installed-events';
import { countActiveAwaitsByPrefixes, listActiveAnnouncements } from '../../events/await/store';
import { announcementVisibleTo } from '../../events/await/announce-key';
import { resolveAgentIdentity } from '../coordination/identity';
import { getPresence } from '../coordination/presence';

const MAX_CATALOG_LIMIT = 200;

function catalogRowMatches(row: CatalogRow, query: string): boolean {
  return [
    row.family,
    row.key,
    row.await_example,
    row.describe,
    row.emitter,
    row.provenance,
    row.replaces_poll,
    row.sugar,
  ].some((value) => typeof value === 'string' && value.toLowerCase().includes(query));
}

export default defineTool({
  name: 'events:catalog',
  description:
    'List the awaitable event-key families — the answer to "what can I wait on instead of polling?". Each row: the key template (+ a ready events:await example), what it means, who emits it, whether it fires TODAY, the poll it replaces, its sugar verb (e.g. deploy:await), and `live_awaiters` — how many agents are registered on that key RIGHT NOW (EI-9000). Supports case-insensitive free-text `q` over family/key/description/emitter and a bounded `limit` for family rows. Check here before you poll dev:pipeline_position / dev:build_status / a peer\'s status.',
  capability: 'events:read',
  guidance: {
    when: 'Before you POLL for something (a deploy landing, the gate going green, a peer\'s work-item settling, a service recovering) — look here for an awaitable key so you can events:await + END YOUR TURN instead of re-polling. Also when you\'re unsure whether an event even exists for X, OR you (an emitter/leader) want to see WHO is actually listening on a key before you trust an events:emit alone (live_awaiters).',
    notWhen: 'You already know the exact key — just events:await it. To see server REACTION wiring ("what fires what") use events:graph; to see YOUR OWN pending awaits + recent wakes use events:status.',
    chaining: 'events:catalog → pick a family → events:await { event: <its key> } (or its sugar verb, e.g. deploy:await) → end your turn.',
    seeAlso: [
      'events:await (arm a wait on a key you found here)',
      'events:emit (its `waiters`/`woken` counts are the emit-TIME twin of this READ-time live_awaiters)',
      'events:graph (server reaction wiring — a different question)',
      'deploy:await / checkpoint:await / work-item:await (named sugar for the common waits)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    q: z
      .string()
      .max(200)
      .optional()
      .describe('Case-insensitive substring over family, key, await example, description, emitter, provenance, and sugar.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_CATALOG_LIMIT)
      .optional()
      .describe(`Max family rows returned (default all; maximum ${MAX_CATALOG_LIMIT}).`),
    family: z
      .string()
      .max(64)
      .optional()
      .describe('Filter to one family id (e.g. "deploy", "work-item"). Omit for the whole catalog.'),
    awaitable_now: z
      .boolean()
      .optional()
      .describe('true = only families whose emitter fires TODAY (hide not-yet-wired Phase-2 keys).'),
    liveAwaiters: z
      .boolean()
      .optional()
      .describe('default true — attach `live_awaiters` (current registered-await count) per family. Pass false to skip the extra DB read on a hot path that only needs the static catalog.'),
    announced: z
      .boolean()
      .optional()
      .describe("default true — also list ANNOUNCED gate events (EI-9270: dynamic, leader-declared keys — events:emit { announce:true }) visible to your fleet/plan/harness (+ global), each with fired/latched state and live_awaiters. Pass false to skip."),
    installed: z
      .boolean()
      .optional()
      .describe('default true — also fold in event families declared by INSTALLED packs/plugins (`provides.events`), each tagged `provenance: "installed:<unit>"`. Pass false for the builtin registry only.'),
  }),
  async handler(args, ctx) {
    // ── The INSTALLED tier (P-006 / D-003: events are a dependency axis). Installed
    // units declare the key families they provide; fold them over the builtin registry
    // so "what can I wait on?" answers for the WHOLE host, not just this binary's
    // hard-coded families. Fail-soft: a bad manifest or a cold host degrades to the
    // builtin catalog — never a throw, or an agent gets pushed back to polling.
    let installedUnits: InstalledUnitEvents[] = [];
    if (args.installed !== false) {
      try {
        const harnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
        installedUnits = await readInstalledUnitEvents({
          harnessSlug: typeof harnessRaw === 'string' && harnessRaw !== '*' ? harnessRaw : undefined,
        });
      } catch {
        /* best-effort — builtin-only catalog beats a dead discovery tool */
      }
    }
    // The merged entry list is also what the live-awaiter join reads below, so an
    // INSTALLED family gets its awaiter count too (deriving prefixes from the builtin
    // EVENT_CATALOG alone would silently leave every installed family without one).
    const merged = mergeInstalledEventCatalog(installedUnits);
    const collisions: EventFamilyCollision[] = merged.collisions;
    const query = args.q?.trim().toLowerCase();

    let rows = renderCatalog(installedUnits);
    if (args.family) rows = rows.filter((r) => r.family === args.family);
    if (args.awaitable_now) rows = rows.filter((r) => r.awaitable_now);
    if (query) rows = rows.filter((r) => catalogRowMatches(r, query));
    if (args.limit !== undefined) rows = rows.slice(0, args.limit);

    // EI-9000: live awaiter counts — "is anyone actually listening" per family,
    // the read-time twin of events:emit's waiters/woken. Best-effort: a DB hiccup
    // here must never break catalog discoverability, so a failed count read just
    // omits live_awaiters rather than failing the whole call.
    if (args.liveAwaiters !== false && rows.length > 0) {
      const wanted = new Set(rows.map((r) => r.family));
      const entries = merged.entries.filter((e) => wanted.has(e.family));
      const prefixByFamily = new Map(entries.map((e) => [e.family, familyKeyPrefix(e)]));
      try {
        const counts = await countActiveAwaitsByPrefixes([...prefixByFamily.values()]);
        rows = rows.map((r) => {
          const prefix = prefixByFamily.get(r.family);
          const live_awaiters = prefix !== undefined ? (counts.get(prefix) ?? 0) : undefined;
          return live_awaiters !== undefined ? { ...r, live_awaiters } : r;
        });
      } catch {
        /* best-effort — omit live_awaiters rather than fail catalog discovery */
      }
    }

    // ── Announced gate events (EI-9270): dynamic, leader-declared keys — the catalog's
    // "announced" section, scoped to the reader's fleet/plan/harness (+ global). The
    // static registry above answers "what does the SYSTEM emit"; this answers "what did
    // a LEADER declare for my lane". BEST-EFFORT: any failure omits the section.
    let announced:
      | Array<{
          event: string;
          note: string | null;
          scope: string;
          announced_by: string;
          fired: boolean;
          fired_at: string | null;
          expires_ts: string | null;
          live_awaiters?: number;
        }>
      | undefined;
    if (args.announced !== false) {
      try {
        const anns = await listActiveAnnouncements({ unfiredOnly: false, limit: 100 });
        if (anns.length > 0) {
          let reader: { fleetSlug?: string | null; planSlug?: string | null; harnessSlug?: string | null } = {};
          try {
            const identity = resolveAgentIdentity(ctx);
            const p = (await getPresence(identity.ownerId)) as
              | { fleetSlug?: string | null; currentPlanSlug?: string | null }
              | null;
            const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
            reader = {
              fleetSlug: p?.fleetSlug ?? null,
              planSlug: p?.currentPlanSlug ?? null,
              harnessSlug: typeof ctxHarnessRaw === 'string' && ctxHarnessRaw !== '*' ? ctxHarnessRaw : null,
            };
          } catch { /* unresolvable reader → global-only visibility */ }
          const visible = anns
            .filter((a) => announcementVisibleTo(a, reader))
            .filter((a) => {
              if (!query) return true;
              return [a.eventKey, a.note, a.scopeKind, a.scopeRef, a.subscriberId].some(
                (value) => typeof value === 'string' && value.toLowerCase().includes(query),
              );
            })
            .slice(0, 25);
          let counts: Map<string, number> | null = null;
          try {
            counts = await countActiveAwaitsByPrefixes(visible.map((a) => a.eventKey));
          } catch { /* omit live_awaiters */ }
          announced = visible.map((a) => ({
            event: a.eventKey,
            note: a.note,
            scope: a.scopeKind ? `${a.scopeKind}${a.scopeRef ? ':' + a.scopeRef : ''}` : 'global',
            announced_by: a.subscriberId,
            fired: !!a.firedAt && a.firedReason === 'event',
            fired_at: a.firedReason === 'event' ? a.firedAt : null,
            expires_ts: a.expiresTs,
            ...(counts ? { live_awaiters: counts.get(a.eventKey) ?? 0 } : {}),
          }));
        }
      } catch { /* best-effort — never break catalog discovery */ }
    }

    const rowsOut: CatalogRow[] = rows;
    const installedCount = merged.entries.filter((e) => e.provenance !== 'builtin').length;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            count: rowsOut.length,
            total: merged.entries.length,
            ...(installedCount > 0 ? { installed_families: installedCount } : {}),
            ...(announced && announced.length > 0 ? { announced } : {}),
            // A REFUSED family declaration is reported, never swallowed — otherwise a
            // pack author debugs a family that "just doesn't appear" with no signal.
            ...(collisions.length > 0 ? { collisions } : {}),
            note:
              'Awaiting beats polling: pick a family, events:await its key (or its sugar verb), then END YOUR TURN — you are re-invoked when it fires. awaitable_now:false = the emitter is being wired (Phase 2); the key shape is stable. live_awaiters:0 means nobody is currently registered on that key — a events:emit against it would reach no one. `provenance` says whether a family is a platform guarantee (builtin) or an installed unit\'s promise (installed:<unit>) — the two carry different trust and lifetime.',
            families: rowsOut,
          }),
        },
      ],
    };
  },
});
