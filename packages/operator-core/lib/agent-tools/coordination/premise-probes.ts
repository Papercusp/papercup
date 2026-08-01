/**
 * premise-probes.ts — the production `PremiseProbes` for `resolvePremiseStamps`
 * (P-011, WI-6731).
 *
 * WHY THIS EXISTS. `premise-resolve.ts` shipped the DECISION logic — pure,
 * unit-tested, and deliberately store-agnostic behind an injected probe set. It
 * had no production implementation at all: every `PremiseProbes` in the tree was
 * a test double. That is the same "mechanism with no consumer" defect the D-087
 * thread already found twice on this plan (see the `mechanism-with-no-consumer-detector`
 * fact), and `send.ts` stamping only `premisesClassified` is what it looked like
 * here: the SYNTACTIC half of `premises` shipped, the falsifiable half did not.
 *
 * ⚠ WHAT A RECIPIENT CAN DO WITH THIS — the justification, stated in the terms
 * D-090 [owner 2026-08-01] requires. `premises` is an AUTHORED field: the sender
 * says what its reasoning RESTED ON. A stamp does not make the field true or
 * legitimate — it tells the RECIPIENT which of two very different things to do:
 *
 *   `stale`  — the ground MOVED since the sender wrote. Re-read the premise, then
 *              re-read the message; the sender was right when they sent it.
 *   `broken` — the ground was never there (a `#completion` on an item that has
 *              not completed). CORRECT the sender; they were wrong at send time.
 *
 * Without the stamp both surface identically as a ref the reader must go and
 * check by hand — which, measurably, nobody did. This is a recipient
 * affordance, NOT a score on the sender, and per D-090 it must never become one:
 * do not wire it to a warning, a refusal, or a per-agent metric. A premise that
 * turns out to be wrong is the field working.
 *
 * ⚠ EVERY IO DEPENDENCY IS IMPORTED DYNAMICALLY, INSIDE THE PROBE. `send.ts`
 * imports this module's factory, and a STATIC import of the work-item / plan /
 * fact / coord stores would drag them into the send path's module graph at load
 * time. That is not hypothetical here: one static import added to `send.ts` on
 * 2026-08-01 made a 95-test suite uncollectable through a partial `../presence`
 * mock (EI-19281789650149592), and `coupling-divergence-stamp.ts` carries the
 * same rule for the same reason. The dynamic import is load-bearing, not style.
 *
 * ⚠ FAIL-SOFT, ALWAYS. Every probe returns `null` on any failure, which
 * `resolveOne` maps to `unknown` — never a failed send and never a false
 * accusation. A decorative stamp that can eat a message is strictly worse than
 * no stamp (the availability coupling that turns one PG blip into fleet-wide
 * silence).
 *
 * ⚠ NO COST GATE HERE, AND THAT IS A MEASURED DECISION, not an omission.
 * `coupling-divergence-stamp.ts` needs `participatesInCouplingDivergence` as a
 * pre-IO gate because its read is a presence snapshot plus a full derivation.
 * Premise probes are nothing like that. Measured over the 30h to 2026-08-01
 * (WI-6731): 21 premise refs total, of which 13 were `invalidatable` — the only
 * ones that reach a probe at all — i.e. ~0.43 probes/hour across the entire
 * fleet. `resolveOne` already short-circuits `!invalidatable` refs before any IO
 * (8 of the 21 were `opaque`), and `resolvePremiseStamps` already de-dupes and
 * caps at `PREMISE_STAMPS_MAX`. Adding a second hand-maintained "is this worth
 * probing" predicate would defend against a load that does not exist, and would
 * be free to drift from the resolver's own rule — the exact failure mode
 * `comparableClaims` exists to avoid by being the same table as the scorer.
 */
import type {
  PremiseProbes,
  ParsedFactRef,
  WorkItemProbeResult,
  FactProbeResult,
} from './premise-resolve';

export interface PremiseProbeScope {
  /** The sender's harness, used to disambiguate a feature-family work-item id. */
  harnessSlug?: string | null;
  /** Explicit workspace; falls back to the active workspace when absent. */
  workspaceId?: string | null;
}

/**
 * A full coord `msg_id` looks like `msas1j6h-0000-<32 hex>`. Agents routinely
 * cite the leading short form in prose, and `getMessageById` matches EXACTLY —
 * so a short-form citation resolves to `null` even when the message is real
 * (WI-6725, open, filed by a peer; reproduced live on 2026-08-01: full id →
 * found, short form → not found).
 *
 * That makes the naive probe DANGEROUS rather than merely incomplete: it would
 * stamp a real, correctly-cited message as `unresolvable` — "no message X" — a
 * false accusation against a sender who did nothing wrong, on a field whose
 * whole purpose is to let agents reason about each other honestly.
 *
 * So a short-form ref returns `unknown` (no IO, no verdict) rather than a
 * verdict this system cannot currently justify. This deliberately mirrors
 * `premise-resolve.ts`'s owner-directive branch, which stays `unknown` for
 * exactly the stated reason that reporting a dangling citation "would be a false
 * accusation". It is NOT a fix for WI-6725 — that is the peer's lane, and it
 * lives in `coord:read`/`coord:thread`, not here. When it lands, this branch can
 * resolve the short form properly and the guard becomes redundant.
 */
export function isFullFormMsgId(msgId: string): boolean {
  return /^[a-z0-9]+-[0-9]{4}-[0-9a-f]{16,}$/i.test(msgId.trim());
}

/**
 * Build the production probe set.
 *
 * Every probe is independently optional at the type level, but all four are
 * supplied here; a probe that throws degrades to `unknown` for that ONE ref
 * without touching the others (`resolvePremiseStamps` runs them in parallel and
 * `resolveOne` wraps each in its own try/catch).
 */
export function premiseProbes(scope: PremiseProbeScope = {}): PremiseProbes {
  const harness = scope.harnessSlug ?? undefined;

  async function workspaceScopedSql(): Promise<{
    sql: <T = unknown>(s: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
    ws: string;
  }> {
    const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../workspace-registry'),
    ]);
    const { sql } = getOrgPg();
    return {
      sql: sql as unknown as <T = unknown>(s: TemplateStringsArray, ...v: unknown[]) => Promise<T>,
      ws: scope.workspaceId ?? activeWorkspaceId(),
    };
  }

  return {
    async workItem(id: string): Promise<WorkItemProbeResult | null> {
      try {
        const [{ getWorkItem }, { ISSUE_TERMINAL_STATES }] = await Promise.all([
          import('../../work-items'),
          import('../../work-item-dispatch-states'),
        ]);
        // ⚠ CROSS-HARNESS RETRY BEFORE DECLARING NON-EXISTENCE. `getWorkItem`'s
        // issue-family leg is a global `getIssue`, but its FEATURE-family leg
        // filters on `harness_slug` — so a feature cited from a peer's harness
        // misses the scoped lookup and would be stamped `unresolvable`, i.e.
        // "WI-N does not exist" about an item that plainly does. That is the
        // false accusation this whole module is built to avoid, and widening
        // classification to BARE ids (which is how a feature is normally cited)
        // is exactly what turns it from latent into likely. Dropping the
        // harness on the retry narrows only to the workspace, which is the same
        // scope `planDecision`/`planItem` deliberately use.
        let wi = await getWorkItem(id, harness);
        if (!wi && harness) wi = await getWorkItem(id);
        if (!wi) return { exists: false };
        // `terminal` is what decides `broken` for a `#completion` anchor, so it
        // must be the SAME terminal-state set the rest of the system dispatches
        // on — never a local list that can drift out of step with it.
        return { exists: true, state: wi.state, terminal: ISSUE_TERMINAL_STATES.includes(wi.state) };
      } catch {
        return null;
      }
    },

    async planDecision(slug: string, decisionId: string) {
      try {
        const { sql, ws } = await workspaceScopedSql();
        // Scoped to the WORKSPACE but deliberately NOT to a harness: a premise
        // may legitimately cite a decision on another harness's plan in the same
        // workspace, and `plan_decisions` is keyed (workspace, harness, plan,
        // decision). Narrowing to the sender's harness would report a real
        // cross-harness citation as dangling — the false accusation again.
        const rows = await sql<{ plan_exists: boolean; decision_exists: boolean }[]>`
          SELECT
            EXISTS (
              SELECT 1 FROM harness_shared.harness_plans
               WHERE workspace_id = ${ws} AND plan_slug = ${slug}
            ) AS plan_exists,
            EXISTS (
              SELECT 1 FROM harness_shared.plan_decisions
               WHERE workspace_id = ${ws} AND plan_slug = ${slug}
                 AND decision_id = ${decisionId}
            ) AS decision_exists`;
        const r = rows[0];
        if (!r) return null;
        return { planExists: r.plan_exists === true, decisionExists: r.decision_exists === true };
      } catch {
        return null;
      }
    },

    async planItem(slug: string, itemId: string) {
      try {
        const { sql, ws } = await workspaceScopedSql();
        // Workspace-scoped, not harness-scoped — the same reasoning as
        // `planDecision` directly above, and for the same reason: narrowing to
        // the sender's harness would report a real cross-harness citation as
        // dangling. `plan_items` is keyed (workspace, harness, plan, item).
        const rows = await sql<{ plan_exists: boolean; item_exists: boolean }[]>`
          SELECT
            EXISTS (
              SELECT 1 FROM harness_shared.harness_plans
               WHERE workspace_id = ${ws} AND plan_slug = ${slug}
            ) AS plan_exists,
            EXISTS (
              SELECT 1 FROM harness_shared.plan_items
               WHERE workspace_id = ${ws} AND plan_slug = ${slug}
                 AND item_id = ${itemId}
            ) AS item_exists`;
        const r = rows[0];
        if (!r) return null;
        return { planExists: r.plan_exists === true, itemExists: r.item_exists === true };
      } catch {
        return null;
      }
    },

    async fact(parsed: ParsedFactRef): Promise<FactProbeResult | null> {
      try {
        const { sql, ws } = await workspaceScopedSql();
        // `exists` means a LIVE current row (not superseded, not retracted, not
        // expired) — the same liveness `listFacts` folds on. `supersededAt` is
        // read across ALL versions of the key, because that is the only signal
        // available for "the ground moved".
        //
        // ⚠ THE `@v<N>` PIN HAS NO STORE COUNTERPART. `agent_facts` carries
        // `superseded_at` but no version NUMBER column, so a pinned version can
        // never be compared to a stored one. `resolveOne` only reports `stale`
        // when `parsed.version != null`, and 0 of 57 observed refs have ever
        // carried a pin (D-085) — so this leg is correct but DORMANT, and saying
        // so is better than implying a staleness check that cannot fire. Fixing
        // it means versioning facts, which is a larger change than this seam.
        const rows = await sql<{ live: boolean | null; superseded_at: string | null }[]>`
          SELECT
            bool_or(superseded_at IS NULL AND retracted_at IS NULL AND expires_at > now()) AS live,
            max(superseded_at)::text AS superseded_at
            FROM harness_shared.agent_facts
           WHERE workspace_id = ${ws}
             AND key = ${parsed.key}
             AND ${
               parsed.scope
                 ? sql`scope = ${parsed.scope} AND coalesce(scope_ref, '') = ${parsed.scopeRef ?? ''}`
                 : sql`TRUE`
             }`;
        const r = rows[0];
        if (!r) return null;
        return { exists: r.live === true, supersededAt: r.superseded_at };
      } catch {
        return null;
      }
    },

    async message(msgId: string) {
      try {
        // See `isFullFormMsgId`: a short-form citation cannot be resolved by the
        // exact-match lookup, and reporting it as dangling would be a false
        // accusation (WI-6725). `unknown` is the honest verdict.
        if (!isFullFormMsgId(msgId)) return null;
        const { getMessageById } = await import('./messages');
        return { exists: (await getMessageById(msgId.trim())) != null };
      } catch {
        return null;
      }
    },
  };
}
