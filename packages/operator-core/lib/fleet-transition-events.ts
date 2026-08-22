/**
 * fleet-transition-events — the leader-facing fleet transition feed
 * (fleet-leadership-continuity-and-actuation-2026-08-01 P-009, D-008).
 *
 * A fleet leader used to learn about its fleet by POLLING: `loop:arm` on a short
 * interval, `fleet:leader-brief` every wake, most of them near-noops. The
 * measured run behind this plan burned ~14 wakes to notice one released claim, up
 * to 3 minutes late. `leader-brief` already DERIVES every transition a leader
 * reacts to; nothing published them, so there was nothing to park on.
 *
 * This module publishes them as fleet-scoped awaitable keys, so a leader DISCOVERS
 * them via `events:catalog` and sleeps instead of polling:
 *
 *   events:await { event: "fleet:member-dead:<my-fleet>" }      // a member died
 *   events:await { event: "fleet:context-critical:<my-fleet>" } // a member is about to compact
 *   events:await { event: "fleet:member-stalled:<my-fleet>" }  // a held claim stopped advancing
 *   events:await { event: "fleet:admission-blocked:<my-fleet>" } // the fleet spec refused work
 *   events:await { event: "fleet:claim-released:<my-fleet>" }   // work came back to the pool
 *   events:await { event: "fleet:item-completed:<my-fleet>" }   // a member finished something
 *
 * KEY SHAPE — `fleet:<transition>:<slug>`, NOT the `fleet:<slug>:<transition>` the
 * P-009 text sketched. The slug must come LAST because `familyKeyPrefix` (and so
 * `keyMatchesCatalog`) truncates a template at its FIRST placeholder: a
 * `fleet:<slug>:member-dead` template registers the catalog prefix `fleet:`, which
 * then matches EVERY `fleet:*` key ever awaited — including typos — and silently
 * disarms the EI-10870 orphan guard for the whole namespace. Putting the
 * transition first yields the precise prefix `fleet:member-dead:` and matches the
 * existing `fleet:drained:<slug>` family exactly, so the namespace stays uniform.
 *
 * WHY FLEET-SCOPED KEYS AND NOT A PAYLOAD FILTER (D-008). The reuse-first
 * instinct is to payload_filter an existing global key rather than mint a family.
 * There is no global key to filter: `work-items-events.ts` emits only
 * `work-item:done:<id>` and `claim:released:<id>`, both ID-SCOPED — they fire for
 * ONE known id. A leader does not know in advance which item will finish next, so
 * using them means registering N awaits and re-registering whenever the set
 * changes: a subscription treadmill driven by polling the item set, which is the
 * exact anti-pattern this plan exists to remove. Route (b) would have to mint
 * global families FIRST, so it saves no families, and then costs more: the
 * work-item payloads carry no fleet identity (`{id,state,kind,harness,title}`),
 * so the leader's predicate needs the same emit-time fleet lookup anyway; and a
 * global key loads EVERY leader's await row on EVERY system-wide settle only to
 * filter them out, where a fleet-scoped key loads just that fleet's.
 * `fleet:drained:<slug>` is the established precedent this extends.
 *
 * NOT IN THIS MODULE — `idle-with-claimable`, P-009's fifth transition, is ALREADY
 * served by the existing global `work-item:claimable` key, which is genuinely
 * payload-filtered (it carries `{id,kind,severity,harness,title,state,reason,plan,
 * tags}`). A leader parks on it with `payload_filter: { plan: { eq: '<slug>' } }`.
 * Minting a fleet-scoped twin would duplicate an emission that already fires; the
 * catalog cross-references it instead.
 *
 * TWO SHAPES OF SIGNAL, deliberately. `claim-released` / `item-completed` have a
 * real TRANSITION SITE and co-fire from it (the shape `emitWorkItemClaimableEvent`
 * already uses). `member-dead` / `context-critical` have NONE — death is the
 * ABSENCE of a write, and context pressure is derived from reported token counts —
 * so they are DERIVED detectors driven by a periodic sweep, exactly as
 * `fleet-drained-events.ts` documents for its own computed condition. The pure
 * arithmetic lives here; the sweep only supplies observations and carries the
 * previous snapshot.
 *
 * PURE core + injectable seams (fleet-drained-events.ts / session-compacted-events.ts
 * discipline): no PG / IO / clock in the detector, so the whole module unit-tests
 * without a database.
 */

import { emitAwaitedEvent } from './events/await/engine';
import type { ContextPressureBucket } from './agent-tools/coordination/context-pressure';

/** The transition families this module publishes, as they appear in the key. */
export type FleetTransitionKind =
  | 'member-dead'
  | 'context-critical'
  | 'member-stalled'
  | 'admission-blocked'
  | 'claim-released'
  | 'item-completed';

/** Build the awaitable key for one fleet transition. Single-sourced so the
 *  emitters, the catalog entries and the tests can never drift on the shape.
 *  Slug LAST — see the key-shape note in the module header. */
export function fleetTransitionKey(fleetSlug: string, kind: FleetTransitionKind): string {
  return `fleet:${kind}:${fleetSlug}`;
}

/**
 * The liveness verdicts that mean CONFIRMED dead.
 *
 * Deliberately ONLY `ended`. `draining` and `suspect` also read as "dead" in the
 * orphaned-claim arithmetic, but per WI-4400 both require a wake CONFIRMATION
 * before a coordinator may assume the owner is gone — so firing on them would wake
 * a leader on an unconfirmed suspicion, which is a false alarm, and a false alarm
 * in a monitor is itself a bug. A member that is genuinely gone reaches `ended`;
 * its presence row survives there until the TTL reaper evicts it
 * (presence-reaper.ts), so the state is observable, not a race.
 */
const CONFIRMED_DEAD_SESSION_STATES: ReadonlySet<string> = new Set(['ended']);

/** The context-pressure bucket that means "compaction is imminent". */
const CRITICAL_CONTEXT_BUCKET = 'critical';

/**
 * One fleet member as a sweep observes it — the minimal projection of the
 * roster/assignment row the detector reads. Kept narrow so the pure fn unit-tests
 * without importing the full presence types.
 */
export interface FleetMemberObservation {
  agentId: string;
  fleetSlug: string;
  /** The shared liveness oracle's verdict (live | parked | draining | suspect | ended | recorded). */
  sessionState: string | null;
  /** The context-pressure bucket (ok | high | critical), or null when unknown. */
  contextPressure: string | null;
  /** Whether this member currently holds a claim whose progress is stalled. */
  stalled?: boolean | null;
}

/** One detected crossing, ready to emit. */
export interface FleetTransitionEdge {
  kind: Extract<FleetTransitionKind, 'member-dead' | 'context-critical' | 'member-stalled'>;
  fleetSlug: string;
  agentId: string;
  /** The state the member crossed INTO (for the summary line). */
  to: string;
  /** The state it crossed FROM, for the summary line. */
  from: string | null;
}

/** A fleet-level admission-block crossing, ready to emit. */
export interface FleetAdmissionTransitionEdge {
  kind: 'admission-blocked';
  fleetSlug: string;
  from: number;
  to: number;
}

/** One fleet's current distinct admission-block count. */
export interface FleetAdmissionObservation {
  fleetSlug: string;
  blockedCount: number;
}

/** Snapshot identity for a member — a member is only ever compared against
 *  itself WITHIN a fleet, so a fleet change reads as a new member (and therefore
 *  never fires; see the first-observation rule below). */
function observationKey(o: { fleetSlug: string; agentId: string }): string {
  return `${o.fleetSlug}\0${o.agentId}`;
}

/** Index a set of observations for the next sweep's comparison. */
export function indexObservations(
  observations: readonly FleetMemberObservation[],
): Map<string, FleetMemberObservation> {
  return new Map(observations.map((o) => [observationKey(o), o]));
}

/**
 * PURE: which members crossed INTO a confirmed-dead state, or INTO critical
 * context pressure, between the previous sweep and this one.
 *
 * EDGE-ONLY, by two rules, both of which exist to stop a monitor crying wolf:
 *
 *   1. A member with NO previous observation never fires. A first sighting is not
 *      a crossing we witnessed — without this, the first sweep after any operator
 *      restart would wake every leader for every historically-dead row it happens
 *      to still see. The cost is a genuinely missed edge across a restart, which
 *      P-010 explicitly covers by retaining `loop:arm` as a long fallback
 *      heartbeat: the architecture is push-primary WITH a backstop.
 *   2. A member already in the target state does not re-fire while it STAYS there.
 *      `ended` and `critical` are both absorbing-ish states that persist for many
 *      sweeps; re-firing would turn one event into a wake storm.
 *
 * A member that DISAPPEARS between sweeps is deliberately NOT a death signal: the
 * row could equally have been reaped on its TTL, or the member could have left the
 * fleet, and those are indistinguishable here. Disappearance-as-death would be a
 * guess, and the whole point of a push signal is that the leader can trust it.
 *
 * Deterministic order (fleet, then agent) so callers and tests are stable.
 */
export function detectFleetTransitions(
  prev: ReadonlyMap<string, FleetMemberObservation>,
  next: readonly FleetMemberObservation[],
): FleetTransitionEdge[] {
  const edges: FleetTransitionEdge[] = [];
  for (const o of next) {
    const before = prev.get(observationKey(o));
    if (!before) continue; // rule 1 — a first sighting is not a crossing

    const wasDead = CONFIRMED_DEAD_SESSION_STATES.has(before.sessionState ?? '');
    const isDead = CONFIRMED_DEAD_SESSION_STATES.has(o.sessionState ?? '');
    if (isDead && !wasDead) {
      edges.push({
        kind: 'member-dead',
        fleetSlug: o.fleetSlug,
        agentId: o.agentId,
        to: o.sessionState ?? 'ended',
        from: before.sessionState,
      });
    }

    const wasCritical = before.contextPressure === CRITICAL_CONTEXT_BUCKET;
    const isCritical = o.contextPressure === CRITICAL_CONTEXT_BUCKET;
    if (isCritical && !wasCritical) {
      edges.push({
        kind: 'context-critical',
        fleetSlug: o.fleetSlug,
        agentId: o.agentId,
        to: CRITICAL_CONTEXT_BUCKET,
        from: before.contextPressure,
      });
    }

    // A stalled-holder verdict is a second, independent leader intervention
    // signal. Unknown is deliberately not coerced to false: the first reliable
    // observation after a degraded read must not manufacture a crossing.
    if (o.stalled === true && before.stalled === false) {
      edges.push({
        kind: 'member-stalled',
        fleetSlug: o.fleetSlug,
        agentId: o.agentId,
        to: 'stalled',
        from: before.stalled ? 'stalled' : 'clear',
      });
    }
  }
  edges.sort((a, b) => a.fleetSlug.localeCompare(b.fleetSlug) || a.agentId.localeCompare(b.agentId) || a.kind.localeCompare(b.kind));
  return edges;
}

/** PURE: fire when a fleet gains a new distinct admission block. A persistent
 * block must not wake the leader every sweep, but a rising count is actionable
 * even when an older block is still present. */
export function detectFleetAdmissionTransitions(
  prev: ReadonlyMap<string, number>,
  next: readonly FleetAdmissionObservation[],
): FleetAdmissionTransitionEdge[] {
  return next
    .filter((observation) => Number.isFinite(observation.blockedCount) && observation.blockedCount > 0)
    .map((observation) => {
      const before = prev.get(observation.fleetSlug) ?? 0;
      return before < observation.blockedCount
        ? {
            kind: 'admission-blocked' as const,
            fleetSlug: observation.fleetSlug,
            from: before,
            to: observation.blockedCount,
          }
        : null;
    })
    .filter((edge): edge is FleetAdmissionTransitionEdge => edge !== null)
    .sort((a, b) => a.fleetSlug.localeCompare(b.fleetSlug));
}

/**
 * Expected fail-soft noise for a best-effort fire-and-forget emit (never warn, or
 * vitest-fail-on-console flakes rig tests): a partial test schema ("… does not
 * exist"), or the async query outliving its Postgres pool
 * (CONNECTION_ENDED/DESTROYED). Anything else is a genuine surprise worth a warn.
 * Mirrors fleet-drained-events.ts / work-items-events.ts.
 */
function failSoft(scope: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (/does not exist/.test(msg)) return;
  const code = (e as { code?: unknown } | null)?.code;
  if (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(msg)
  ) {
    return;
  }
  console.warn(`[fleet-transition-events] ${scope} emit failed: ${msg}`);
}

/** Injectable seams for tests. */
export interface FleetTransitionEventsDeps {
  emit?: typeof emitAwaitedEvent;
  /**
   * Re-read the current writer-backed context bucket immediately before a
   * `context-critical` event is emitted. The sweep's observation can be stale
   * by the time its detached emit runs; a non-critical current value suppresses
   * that stale wake. Omitted for non-sweep callers, which retain the historical
   * emit behavior.
   */
  currentContextPressure?: (agentId: string) => Promise<ContextPressureBucket | null>;
  /** Resolve an agent's current fleet. Default = the canonical append-only
   *  membership fact; injected as a stub in tests. */
  fleetOfAgent?: (workspaceId: string, ownerId: string) => Promise<string | null>;
}

/**
 * The holder's fleet, from the CANONICAL append-only membership fact
 * (`harness_shared.fleet_membership_events`) rather than the `coord_presence`
 * projection of it.
 *
 * The distinction is load-bearing here: a work-item is very often released BY THE
 * REAPER precisely because its holder DIED, and the presence row of a dead agent is
 * evicted on a TTL (presence-reaper.ts). Reading the projection would therefore
 * lose the fleet exactly in the case a leader most needs the signal — an orphaned
 * claim. The membership fact survives death by design (WI-1345), so it answers.
 *
 * Fail-soft: any read failure resolves to null (no event), never a throw — this
 * runs inside a fire-and-forget emit on a write path that must not be breakable.
 */
export async function fleetSlugOfAgent(
  workspaceId: string,
  ownerId: string | null | undefined,
  deps: Pick<FleetTransitionEventsDeps, 'fleetOfAgent'> = {},
): Promise<string | null> {
  if (!ownerId) return null;
  const resolve =
    deps.fleetOfAgent ??
    (async (ws: string, owner: string) => {
      const { latestFleetMembership } = await import('./fleet-membership-store');
      return (await latestFleetMembership(ws, owner))?.fleetSlug ?? null;
    });
  try {
    return await resolve(workspaceId, ownerId);
  } catch {
    return null;
  }
}

/**
 * Fire one detected member-dead / context-critical edge. Awaiter-only (no `to`
 * push): the audience is whoever registered interest in this fleet — which is the
 * leader, and the point is that it is ASLEEP. Fire-and-forget; never throws.
 */
export function emitFleetTransitionEdge(edge: FleetTransitionEdge, deps: FleetTransitionEventsDeps = {}): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  const summary =
    edge.kind === 'member-dead'
      ? `fleet ${edge.fleetSlug}: member ${edge.agentId} is DEAD (${edge.from ?? 'unknown'} → ${edge.to})`
      : edge.kind === 'context-critical'
        ? `fleet ${edge.fleetSlug}: member ${edge.agentId} context pressure is CRITICAL (${edge.from ?? 'unknown'} → ${edge.to})`
        : `fleet ${edge.fleetSlug}: member ${edge.agentId} claim is STALLED (${edge.from ?? 'unknown'} → ${edge.to})`;
  void Promise.resolve()
    .then(async () => {
      // The sweep's bucket is a watchdog-cached observation. Revalidate only
      // this derived edge, at the last responsible moment, so recovery between
      // observation and delivery cannot wake a leader with an obsolete payload.
      if (edge.kind === 'context-critical' && deps.currentContextPressure) {
        let current: ContextPressureBucket | null;
        try {
          current = await deps.currentContextPressure(edge.agentId);
        } catch (e: unknown) {
          // A failed revalidation must not break the detached event path. The
          // original sweep observation is still the best available signal when
          // the current writer cannot be read; a successful non-critical read
          // is what suppresses the stale wake.
          failSoft(`context-critical revalidation for ${edge.fleetSlug}/${edge.agentId}`, e);
          current = CRITICAL_CONTEXT_BUCKET;
        }
        if (current !== CRITICAL_CONTEXT_BUCKET) return;
      }
      await emit({
        key: fleetTransitionKey(edge.fleetSlug, edge.kind),
        summary,
        payload: {
          fleetSlug: edge.fleetSlug,
          agentId: edge.agentId,
          transition: edge.kind,
          from: edge.from,
          to: edge.to,
        },
        source: 'fleet',
      });
    })
    .catch((e: unknown) => failSoft(`${edge.kind} for ${edge.fleetSlug}/${edge.agentId}`, e));
}

/** Fire a fleet-level admission-block edge. Awaiter-only and fail-soft, like
 * the member transition emitter above. */
export function emitFleetAdmissionTransitionEdge(
  edge: FleetAdmissionTransitionEdge,
  deps: FleetTransitionEventsDeps = {},
): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  void Promise.resolve()
    .then(() =>
      emit({
        key: fleetTransitionKey(edge.fleetSlug, edge.kind),
        summary:
          `fleet ${edge.fleetSlug}: claim admission is BLOCKED (${edge.from} → ${edge.to} distinct refusal(s))`,
        payload: {
          fleetSlug: edge.fleetSlug,
          transition: edge.kind,
          from: edge.from,
          to: edge.to,
        },
        source: 'fleet',
      }),
    )
    .catch((e: unknown) => failSoft(`${edge.kind} for ${edge.fleetSlug}`, e));
}

/**
 * Fire `fleet:<slug>:claim-released` — a member's claim returned to the pool, so
 * the leader can re-place the work without waiting for its next poll. Co-fired
 * from `releaseWorkItem`'s existing emit point alongside the id-scoped
 * `claim:released:<id>`, which keeps firing unchanged for delegators awaiting a
 * SPECIFIC item.
 *
 * `fleetSlug` is the PRIOR holder's fleet, resolved by the caller — a released
 * item no longer carries its holder, so the fleet cannot be recovered from the
 * item alone. A caller that cannot resolve one passes null and nothing fires:
 * an unfleeted agent's release is not a fleet transition. Never throws.
 */
export function emitFleetClaimReleasedEvent(
  fleetSlug: string | null | undefined,
  item: { id: string; title?: string | null; harness?: string | null },
  priorAssignee: string | null,
  deps: FleetTransitionEventsDeps = {},
): void {
  if (!fleetSlug) return;
  const emit = deps.emit ?? emitAwaitedEvent;
  void Promise.resolve()
    .then(() =>
      emit({
        key: fleetTransitionKey(fleetSlug, 'claim-released'),
        summary: `fleet ${fleetSlug}: ${item.id} released by ${priorAssignee ?? 'unknown'} — back to the pool`,
        payload: {
          fleetSlug,
          transition: 'claim-released',
          id: item.id,
          title: item.title ?? null,
          harness: item.harness ?? null,
          priorAssignee,
        },
        source: 'fleet',
      }),
    )
    .catch((e: unknown) => failSoft(`claim-released for ${fleetSlug}/${item.id}`, e));
}

/**
 * Fire `fleet:<slug>:item-completed` — a member settled an item, so the leader can
 * feed it more work or judge the burn-down without polling. Co-fired from
 * `emitWorkItemSettledEvents` alongside the id-scoped `work-item:done:<id>`, which
 * keeps firing unchanged.
 *
 * `fleetSlug` is the settling holder's fleet, resolved by the caller; null fires
 * nothing (an unfleeted agent's completion is not a fleet transition). Never throws.
 */
export function emitFleetItemCompletedEvent(
  fleetSlug: string | null | undefined,
  item: { id: string; state: string; title?: string | null; harness?: string | null; assignee?: string | null },
  deps: FleetTransitionEventsDeps = {},
): void {
  if (!fleetSlug) return;
  const emit = deps.emit ?? emitAwaitedEvent;
  void Promise.resolve()
    .then(() =>
      emit({
        key: fleetTransitionKey(fleetSlug, 'item-completed'),
        summary: `fleet ${fleetSlug}: ${item.id} settled → ${item.state} by ${item.assignee ?? 'unknown'}`,
        payload: {
          fleetSlug,
          transition: 'item-completed',
          id: item.id,
          state: item.state,
          title: item.title ?? null,
          harness: item.harness ?? null,
          assignee: item.assignee ?? null,
        },
        source: 'fleet',
      }),
    )
    .catch((e: unknown) => failSoft(`item-completed for ${fleetSlug}/${item.id}`, e));
}

/** Resolve the workspace for a fleet lookup. Injectable so the announce helpers
 *  below unit-test without the workspace registry. */
async function defaultWorkspaceId(): Promise<string> {
  const { activeWorkspaceId } = await import('./workspace-registry');
  return activeWorkspaceId();
}

/** The announce helpers' seams: everything `emit`/`fleetOfAgent` need, plus the
 *  workspace resolution the fleet lookup is scoped by. */
export interface FleetAnnounceDeps extends FleetTransitionEventsDeps {
  workspaceId?: () => Promise<string>;
}

/**
 * Resolve the PRIOR holder's fleet and fire `fleet:claim-released:<slug>`.
 *
 * The one-line call-site form for `releaseWorkItem`, which already knows the
 * pre-release assignee from the row-read it performs before the UPDATE (passing it
 * in avoids a second, racy read — see releaseWorkItem's `onPriorState` doc).
 * Entirely fire-and-forget: nothing here can reject into, or delay, the release.
 */
export function announceFleetClaimReleased(
  priorAssignee: string | null | undefined,
  item: { id: string; title?: string | null; harness?: string | null },
  deps: FleetAnnounceDeps = {},
): void {
  if (!priorAssignee) return; // an unheld item's release is not a fleet transition
  void Promise.resolve()
    .then(async () => {
      const ws = await (deps.workspaceId ?? defaultWorkspaceId)();
      const fleetSlug = await fleetSlugOfAgent(ws, priorAssignee, deps);
      emitFleetClaimReleasedEvent(fleetSlug, item, priorAssignee, deps);
    })
    .catch((e: unknown) => failSoft(`claim-released announce for ${item.id}`, e));
}

/**
 * Resolve the settling holder's fleet and fire `fleet:item-completed:<slug>`.
 * The one-line call-site form for `emitWorkItemSettledEvents`. Terminal writes
 * clear the item's assignee, so callers pass the pre-write holder explicitly.
 * Fire-and-forget.
 */
export function announceFleetItemCompleted(
  item: { id: string; state: string; title?: string | null; harness?: string | null; assignee?: string | null },
  priorAssignee: string | null | undefined = item.assignee,
  deps: FleetAnnounceDeps = {},
): void {
  if (!priorAssignee) return; // an unheld item settling is not a fleet transition
  void Promise.resolve()
    .then(async () => {
      const ws = await (deps.workspaceId ?? defaultWorkspaceId)();
      const fleetSlug = await fleetSlugOfAgent(ws, priorAssignee, deps);
      // Keep the post-state item truthful while giving the event its real
      // attribution. This copy never escapes the event fanout.
      emitFleetItemCompletedEvent(fleetSlug, { ...item, assignee: priorAssignee }, deps);
    })
    .catch((e: unknown) => failSoft(`item-completed announce for ${item.id}`, e));
}
