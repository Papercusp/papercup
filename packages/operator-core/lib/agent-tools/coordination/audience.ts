/**
 * audience.ts — audience-selector expansion for coord delivery
 * (coord-emit-subscription-scoping-2026-06-05, Brief 28).
 *
 * Lifecycle auto-emits (claim / intent / finding / completion) used to broadcast
 * to `to: ['*']` — every event into every agent's inbox (~360/6h). This module
 * lets the `to[]` carry AUDIENCE SELECTORS that resolve, at send time, to just
 * the agents *watching* the relevant plan / topic / work-item:
 *
 *   @plan:<slug>          — explicit plan subscribers ∪ active presence on the
 *                           plan ∪ subscribers of topics the plan is tagged to
 *   @topic:<slug>         — subscribers of that topic
 *   @object:<kind>:<ref>  — subscribers of that coord object (the full stored
 *                           subscription target_ref, e.g. `feature:<h>#<id>` /
 *                           `issue:<id>`) ∪ its tagged-topic subscribers
 *   @file:<path>          — everyone on that file: active presence whose
 *                           current_files includes <path> ∪ agents holding or
 *                           queued on a LIVE file-lock for it (the
 *                           file-collision signal, for intent/window)
 *   @fleet:<slug>         — live (fresh-heartbeat) members of a named fleet
 *                           (membership IS the subscription — the soft
 *                           coord_presence.fleet_slug label, no rows to manage)
 *   @fleet-leader:<slug>  — the named fleet's CURRENT leader (escalate-to-lead;
 *                           the durable agent_fleets registry, liveness-independent)
 *
 * Plain ownerIds, `*` (broadcast), and `human` pass through untouched, so a
 * normal coord:send is zero-overhead (no `@` → no resolution).
 *
 * Resolution happens in the async send path (sendMessage), NOT in the sync rule
 * `args` — that is why the lifecycle rules emit a SELECTOR string and this module
 * expands it. The expanded concrete ownerIds are stored on the single envelope,
 * so the inbox filter (`to.includes(ownerId) || '*'`) and the federation
 * projection are unchanged (D-001/D-003). Empty resolution → empty `to` → the row
 * still persists (plan-history) but reaches no inbox; we never fall back to `*`
 * (D-004). The pure core takes injected resolvers so it unit-tests with in-memory
 * doubles; the host wires the PG-backed deps in ./audience-host.
 */

/**
 * A fleet member that was NOT delivered to, and why (P-003). Structural on purpose —
 * this module stays host-agnostic, so the reason vocabulary is declared here rather
 * than imported from the PG-backed fleet roster that produces it.
 */
export interface FleetAudienceOmission {
  ownerId: string;
  reason: 'stale-heartbeat' | 'ended' | 'suspect' | 'bee-role';
  heartbeatAt?: string | null;
}

/** An active (fresh-heartbeat, non-revoked) agent + what it is working on. */
export interface ActivePresence {
  ownerId: string;
  planSlug: string | null;
  files: string[];
}

/** The injected, async resolvers (PG-backed in the host, fakes in tests). */
export interface AudienceResolvers {
  /** Explicit subscribers of a subscription target (object|topic) → ownerIds. */
  listTargetSubscribers(targetKind: 'object' | 'topic', targetRef: string): Promise<string[]>;
  /** Active presence rows. Called at most once per expandAudience call. */
  listActivePresence(): Promise<ActivePresence[]>;
  /** Topic slugs a coord object (kind, ref) is tagged to (coord_links rel='tagged'). */
  listTaggedTopics(objectKind: string, objectRef: string): Promise<string[]>;
  /** Live (fresh-heartbeat) members of a named fleet (by slug or human name — the
   *  host slugifies) → ownerIds. Backs the `@fleet:` selector. */
  listFleetMembers(fleetSlug: string): Promise<string[]>;
  /**
   * P-003 — the fleet members this send did NOT reach, and why. OPTIONAL and purely
   * DIAGNOSTIC: it never changes who is delivered to (that is `listFleetMembers`), it
   * only lets a `@fleet:` result distinguish a FULL delivery from a PARTIAL one. A host
   * that cannot answer omits it (or returns []), and the send reports no omissions —
   * which is why callers must treat "absent" as UNKNOWN, never as "nobody was dropped".
   */
  explainFleetAudience?(fleetSlug: string): Promise<FleetAudienceOmission[]>;
  /** The named fleet's current leader → ownerId(s) (0 or 1; the durable registry,
   *  liveness-independent). Backs the `@fleet-leader:` selector. */
  listFleetLeader(fleetSlug: string): Promise<string[]>;
  /**
   * Agents on a repo-relative path per the LOCK plane — holders of a live
   * (unexpired) file-lock ∪ agents queued waiting for one. The automatic half of
   * `@file:` (EI-18772330418885814); see the selector branch for why presence
   * alone is not enough. MUST be fail-soft in the host: a lock plane that is
   * unreachable/unconfigured returns `[]` rather than failing the send.
   */
  listPathLockAgents(path: string): Promise<string[]>;
}

export type AudienceMode = 'scoped' | 'broadcast';

/** The expanded audience plus selectors that resolved to no recipients. */
export interface AudienceExpansion {
  resolved: string[];
  unresolvedSelectors: string[];
}

const SELECTOR_PREFIX = '@';

/** True if any entry is an audience selector (so a send must run expandAudience). */
export function hasAudienceSelector(to: readonly string[]): boolean {
  return to.some((t) => t.startsWith(SELECTOR_PREFIX));
}

/** Build an `@object:` selector from a coord ObjectRef (the canonical
 *  `${kind}:${ref}` that subscriptions store as target_ref). */
export function objectSelector(ref: { kind: string; ref: string }): string {
  return `@object:${ref.kind}:${ref.ref}`;
}

/**
 * Expand a `to[]` containing audience selectors into concrete ownerIds.
 * Pass-throughs (plain ids, `*`, `human`) are preserved; selectors resolve via
 * `resolvers`; in `broadcast` mode every selector collapses to `*` (the
 * kill-switch — D-005). Result is deduped; an unknown selector resolves to no
 * one (never `*` on a typo).
 */
export async function expandAudience(
  to: readonly string[],
  resolvers: AudienceResolvers,
  mode: AudienceMode = 'scoped',
): Promise<string[]> {
  return (await expandAudienceDetailed(to, resolvers, mode)).resolved;
}

/**
 * Expand an audience while retaining the selectors that matched no recipients.
 * The plain `expandAudience` API intentionally remains resolution-only for
 * existing callers; send paths that need to tell a partial delivery from a
 * complete one use this diagnostic sibling.
 */
export async function expandAudienceDetailed(
  to: readonly string[],
  resolvers: AudienceResolvers,
  mode: AudienceMode = 'scoped',
): Promise<AudienceExpansion> {
  const out = new Set<string>();
  const unresolved = new Set<string>();
  let presence: ActivePresence[] | null = null;
  const presenceOnce = async (): Promise<ActivePresence[]> =>
    (presence ??= await resolvers.listActivePresence());

  for (const t of to) {
    if (!t.startsWith(SELECTOR_PREFIX)) {
      out.add(t); // plain ownerId / '*' / 'human'
      continue;
    }
    if (mode === 'broadcast') {
      out.add('*');
      continue;
    }
    const resolved = await resolveSelector(t, resolvers, presenceOnce);
    if (resolved.length === 0) unresolved.add(t);
    for (const id of resolved) out.add(id);
  }
  return { resolved: [...out], unresolvedSelectors: [...unresolved] };
}

async function resolveSelector(
  selector: string,
  resolvers: AudienceResolvers,
  presenceOnce: () => Promise<ActivePresence[]>,
): Promise<string[]> {
  if (selector.startsWith('@topic:')) {
    const slug = selector.slice('@topic:'.length).trim();
    return slug ? resolvers.listTargetSubscribers('topic', slug) : [];
  }

  if (selector.startsWith('@plan:')) {
    const slug = selector.slice('@plan:'.length).trim();
    if (!slug) return [];
    const ids = new Set<string>();
    for (const id of await resolvers.listTargetSubscribers('object', `plan:${slug}`)) ids.add(id);
    for (const id of await taggedTopicSubscribers('plan', slug, resolvers)) ids.add(id);
    for (const p of await presenceOnce()) if (p.planSlug === slug) ids.add(p.ownerId);
    return [...ids];
  }

  if (selector.startsWith('@object:')) {
    // The remainder IS the stored subscription target_ref (`<kind>:<ref>`).
    const targetRef = selector.slice('@object:'.length).trim();
    if (!targetRef) return [];
    const ids = new Set<string>();
    for (const id of await resolvers.listTargetSubscribers('object', targetRef)) ids.add(id);
    const colon = targetRef.indexOf(':');
    if (colon > 0) {
      const kind = targetRef.slice(0, colon);
      const ref = targetRef.slice(colon + 1);
      for (const id of await taggedTopicSubscribers(kind, ref, resolvers)) ids.add(id);
    }
    return [...ids];
  }

  if (selector.startsWith('@file:')) {
    const path = selector.slice('@file:'.length).trim();
    if (!path) return [];
    const ids = new Set<string>();
    for (const p of await presenceOnce()) if (p.files.includes(path)) ids.add(p.ownerId);
    // EI-18772330418885814 — the presence half alone is NOT a check for who is on a
    // file. `current_files` is populated only by an explicit
    // `coord:declare-intent { current_files }`, and every declare that OMITS the arg
    // RESETS it to [] — so in practice it is empty for essentially every agent
    // (measured live 2026-07-27: 119 live presence rows, ZERO with a non-empty
    // current_files). That made `@file:` resolve to nobody even while a peer
    // verifiably held a lock on the path, and coord:send answered with a confident
    // `zero_recipients` / "reached NOBODY live" — read as positive evidence of
    // absence, it invites an agent to edit straight into a live peer's work. A live
    // file-lock is the strongest, and the only AUTOMATIC, "this agent is on this
    // file" signal there is, so union it in. Waiters count too: an agent queued on
    // the path is by definition trying to edit it.
    for (const id of await resolvers.listPathLockAgents(path)) ids.add(id);
    return [...ids];
  }

  // `@fleet-leader:` MUST be tested before `@fleet:` would be — though the
  // prefixes don't actually collide (`@fleet-` vs `@fleet:`), keep the more
  // specific one first for clarity.
  if (selector.startsWith('@fleet-leader:')) {
    const slug = selector.slice('@fleet-leader:'.length).trim();
    return slug ? resolvers.listFleetLeader(slug) : [];
  }

  if (selector.startsWith('@fleet:')) {
    const slug = selector.slice('@fleet:'.length).trim();
    return slug ? resolvers.listFleetMembers(slug) : [];
  }

  // Unknown selector — deliver to no one (never broadcast on a typo).
  return [];
}

async function taggedTopicSubscribers(
  objectKind: string,
  objectRef: string,
  resolvers: AudienceResolvers,
): Promise<string[]> {
  const topics = await resolvers.listTaggedTopics(objectKind, objectRef);
  if (!topics.length) return [];
  const ids = new Set<string>();
  for (const slug of topics) {
    for (const id of await resolvers.listTargetSubscribers('topic', slug)) ids.add(id);
  }
  return [...ids];
}
