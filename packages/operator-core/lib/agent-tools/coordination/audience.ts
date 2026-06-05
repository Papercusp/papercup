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
 *   @file:<path>          — active presence whose current_files includes <path>
 *                           (the file-collision signal, for intent/window)
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
}

export type AudienceMode = 'scoped' | 'broadcast';

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
  const out = new Set<string>();
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
    for (const id of await resolveSelector(t, resolvers, presenceOnce)) out.add(id);
  }
  return [...out];
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
    return [...ids];
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
