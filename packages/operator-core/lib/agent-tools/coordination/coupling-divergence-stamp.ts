/**
 * coupling-divergence-stamp.ts — the CONSUMER for `forYouBecause` (D-089, WI-6685).
 *
 * WHY THIS EXISTS. `forYouBecause` is justified on being "STRUCTURED so it can be
 * diffed against the computed coupling graph". D-087 found the computed half was
 * prose and D-089 typed it; this is the third and last piece — the thing that
 * actually performs the diff. Without it the whole chain is a declared mechanism
 * with no consumer, which is the exact defect the D-087 thread found twice
 * already (see the `mechanism-with-no-consumer-detector` fact).
 *
 * ⚠ IT MUST RUN AT SEND, and that is a property of the data, not a preference.
 * The computed graph is LIVE state — locks release, awaited events fire, fleet
 * membership changes. A retrospective pass over `coord_event_log` therefore
 * cannot reconstruct what the graph said when the sender made its claim, and
 * would score every message `not-comparable`. The one moment the comparison is
 * meaningful is the moment the claim is made.
 *
 * ⚠ THE RULE TABLE IS ALSO THE COST GATE, which is why this is affordable on a
 * hot path. Resolving the graph costs a presence snapshot plus the derivation's
 * bounded reads, so it is gated on `participatesInCouplingDivergence` FIRST:
 * `owns` (53% of live asserted uses) and `other` can never be compared, so a
 * message carrying only those does ZERO IO. The correctness rule and the
 * cheapness fall out of the same table — a second, hand-maintained "is this
 * worth computing" predicate would be free to drift from the scoring one.
 *
 * ⚠ FAIL-SOFT, TOTAL, AND NEVER LOAD-BEARING ON THE SEND. Same contract as
 * `resolveGateRefStamps` / `resolvePremiseStamps`: every failure degrades to an
 * empty stamp list. A measurement that can eat a message is a far worse outcome
 * than a message with no measurement — the availability coupling that turns one
 * PG blip into fleet-wide silence.
 */
import {
  participatesInCouplingDivergence,
  couplingDivergenceVerdict,
  type ForYouBecause,
  type ForYouBecauseRelation,
  type CouplingDivergenceVerdict,
} from './message-fields';
import { resolvePresenceScope, assemblePresenceSnapshot } from './presence-snapshot';
import { couplingSourcesFor } from './coupling-sources';
import { deriveCouplings } from '../../coord/coupling-derivation';
import {
  listCouplingsFor,
  resolveCoupledPeers,
  type DerivedCouplingRelation,
} from '../../coord/couplings';

/** One asserted relation, scored against the graph as it stood at send. */
export interface CouplingDivergenceStamp {
  /** Index of the section that carried the assertion. */
  section: number;
  /** The recipient the assertion is ABOUT — the field is per-recipient by nature. */
  recipient: string;
  asserted: ForYouBecauseRelation;
  verdict: CouplingDivergenceVerdict;
  /** What the graph actually held for this pair — empty is a real answer. */
  computed: DerivedCouplingRelation[];
}

/** Bound on the stamp list: sections × recipients is quadratic in principle. */
export const COUPLING_DIVERGENCE_STAMPS_MAX = 40;

export const COUPLING_DIVERGENCE_FIELD = 'couplingDivergence';

/** A section as this module reads it — structural, so any section shape fits. */
interface SectionLike {
  forYouBecause?: ForYouBecause | undefined;
}

/**
 * Recipients this comparison can speak about at all.
 *
 * `*` and `human` and `@selector` audiences are dropped for the same reason the
 * coord-exchange coupling signal drops them: the sender addressed a SET, not a
 * person, so "why THIS recipient" has no single subject to be right or wrong
 * about. Scoring them would invent divergence out of a broadcast.
 */
function comparableRecipients(to: readonly string[], self: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of to) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || id === '*' || id === 'human' || id.startsWith('@')) continue;
    if (id === self || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Score every comparable (section, recipient) assertion against the live graph.
 *
 * Returns `[]` — never throws, never partially fails a send — when there is
 * nothing comparable, when the sender is unresolvable, or when any leg of the
 * coupling read is unavailable.
 */
export async function resolveCouplingDivergenceStamps(opts: {
  selfOwnerId: string;
  to: readonly string[];
  sections: readonly SectionLike[];
  workspaceId?: string | null;
  harnessSlug?: string | null;
}): Promise<CouplingDivergenceStamp[]> {
  try {
    const self = (opts.selfOwnerId ?? '').trim();
    if (!self) return [];

    // THE GATE, before any IO: only assertions the table says can be compared.
    const claims: Array<{ section: number; f: ForYouBecause }> = [];
    opts.sections.forEach((s, i) => {
      const f = s?.forYouBecause;
      if (f && participatesInCouplingDivergence(f)) claims.push({ section: i, f });
    });
    if (claims.length === 0) return [];

    const recipients = comparableRecipients(opts.to, self);
    if (recipients.length === 0) return [];

    // The SAME union `coord:presence` and the coupled-topic feed read — never a
    // private notion of "coupled" (D-078 (b) / D-081). A peer the sender
    // DECOUPLED stays decoupled here too, which is correct: the sender is
    // asserting a relation it has explicitly said it does not want surfaced.
    const ctx = {
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
    };
    const resolved = await resolvePresenceScope(ctx, {});
    const snapshot = await assemblePresenceSnapshot(resolved, {});
    const rosterOwnerIds = snapshot.active
      .map((r) => (r as { ownerId?: unknown }).ownerId)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);

    const derived = await deriveCouplings(
      self,
      snapshot.active,
      couplingSourcesFor({
        selfOwnerId: self,
        rosterOwnerIds,
        ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
        ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      }),
    );
    const edges = await listCouplingsFor(self, opts.workspaceId ?? undefined);
    const peers = resolveCoupledPeers(self, derived, edges);

    const byPeer = new Map<string, DerivedCouplingRelation[]>();
    for (const p of peers) byPeer.set(p.ownerId, p.derivedRelations ?? []);

    const stamps: CouplingDivergenceStamp[] = [];
    for (const { section, f } of claims) {
      for (const recipient of recipients) {
        if (stamps.length >= COUPLING_DIVERGENCE_STAMPS_MAX) return stamps;
        // A recipient with NO entry is not the same as one with an empty entry,
        // but both mean the same thing to the verdict: the graph holds nothing
        // for this pair. `couplingDivergenceVerdict` already treats absence
        // correctly per relation (silence for a one-sided claim, divergence for
        // a two-sided one), so there is no special case to write here.
        const computed = byPeer.get(recipient) ?? [];
        stamps.push({
          section,
          recipient,
          asserted: f.relation,
          verdict: couplingDivergenceVerdict(f, computed),
          computed,
        });
      }
    }
    return stamps;
  } catch {
    return [];
  }
}

/** The stamps worth a reader's attention: an assertion the graph CONTRADICTS. */
export function divergentStamps(
  stamps: readonly CouplingDivergenceStamp[],
): CouplingDivergenceStamp[] {
  return stamps.filter((s) => s.verdict === 'diverges');
}
