/**
 * events:await — register a one-shot WAKE subscription on an event key
 * (await-event-primitive-2026-06-05 P-003, D-002/D-003).
 *
 * "I am blocked on this; re-invoke me when it fires." The caller's session
 * wake-handle (adv_sessions row via the coord SID, or an explicit plan-run id)
 * is stamped onto the subscription NOW — it cannot be fetched at fire time
 * because the agent is asleep. One-shot by construction: it fires once and
 * clears, so an await can never wake-loop.
 */

import { z } from 'zod';
import { dataConditionSchema } from '@papercusp/rules';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { getMessageById } from '../coordination/messages';
import { readGateRefs } from '../coordination/ref-hydrate';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import {
  keyMatchesCatalog,
  mergeInstalledEventCatalog,
  findRequiredParamPrefixMatch,
  type EventCatalogEntry,
} from '../../events/await/catalog';
import { readInstalledUnitEvents } from '../../events/await/installed-events';
import {
  registerAwait,
  findAnnouncementsForKey,
  findNearMissKeys,
  cancelAwaitsForSubscribersOnKeys,
  probeKeyFireEvidence,
  type KeyFireEvidence,
} from '../../events/await/store';
import { registerComposedAwait } from '../../events/await/compose';
import { ComposedSpecError, type ComposedSpec } from '../../events/await/compose-spec';
import { withBoundedTimeout } from '../../bounded-timeout';
import { startAwaitSweeper } from '../../events/await/engine';
import { isPattern, expandPatternMacro, assertUsablePattern } from '../../events/await/pattern';
import { liveBlockedState, liveSettledProbe } from '../../work-items-events';
import { hardText, softText, clampText, LIMITS } from '../limits';
import { extendOwnerClaimsForAwait } from '../../plan-items/claims';
import { resolvePlanScope } from '../plans/source';
import { getClaimSpecRecord } from '../../scheduler/claim-spec-store';
import { formatSpecRef } from '../../scheduler/claim-spec';
import { resolveClaimSpecWorkspace } from '../../scheduler/claim-spec-workspace';
import { claimSpecFilterToClaimablePayloadFilter } from '../../scheduler/claim-spec-payload-filter';

// The fallback timeout-wake window + hard cap — one shared source of truth
// (await-timeout-fallback-defaults-2026-07-03): the default is now 30min, not 4h.
// Aliased to the local names so every usage/describe below is unchanged.
import { AWAIT_DEFAULT_TIMEOUT_SEC as DEFAULT_TIMEOUT_SEC, AWAIT_MAX_TIMEOUT_SEC as MAX_TIMEOUT_SEC } from '../../events/await/types';

export default defineTool({
  name: 'events:await',
  description:
    'Register a one-shot WAKE on an event key OR a key PATTERN. When it fires you are re-invoked, so end your turn instead of polling. A pattern (`work-item:done:*`, or macros `@plan:<slug>` / `@fleet:<slug>`) wakes on the FIRST matching key. Or pass `spec` instead of `event` for a composed all/any/some THRESHOLD TREE — one wake when the combination is satisfied.',
  guidance: {
    when: 'You are blocked on a known event key: a lock grant, plan run finishing, peer answer, deploy/gate landing, or a custom key another tool/agent will emit (patterns/macros cover whole families — see `event`). HAND-MINTED pair key? Have the completion\'s OWNER declare it first (events:emit { announce:true }) and await the RETURNED key — never re-type a key from chat (drift strands you). work-item:unblocked:<id> latches at registration: already-unblocked returns already_unblocked instead of a dead wait.',
    notWhen:
      'Ambient interest (use topics:subscribe), sub-minute waits inside one turn, or recurring schedules. Prefer sugar verbs for common waits: deploy:await, checkpoint:await, work-item:await, service:await-up, git-sync:await, plan-item:await, fleet:await-drained.',
    chaining: 'events:catalog → events:await { event } (or a sugar verb) → END YOUR TURN → the wake carries the payload → re-register for the NEXT occurrence (one-shot: a fired await is gone). Re-awaiting the SAME key auto-retires your own prior pending registration on it (see seeAlso). events:cancel retracts early; events:status inspects.',
    seeAlso: [
      'events:catalog (what CAN I wait on? — the awaitable-key registry; check before polling)',
      'deploy:await / work-item:await / … (named sugar for the common waits — build the key for you)',
      'events:emit (the counterpart — fire the event a peer awaits)',
      'events:cancel (retract a pending await)',
      'watch:create (a standing watch instead of a one-shot await)',
      'EI-14225: re-awaiting the SAME exact key auto-retires your own prior pending registration on it (see `superseded` in the response) — a repeated idle-park loop never has to call events:cancel first.',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    event: hardText(LIMITS.IDENT)
      .optional()
      .describe(
        'Event key to wait on (mutually exclusive with `spec`). An EXACT key (`lock:grant:t1`) matches that one key. A PATTERN — a glob with `*` (`work-item:done:*`), or a macro `@plan:<slug>` (→ any plan item done) / `@fleet:<slug>` (→ any fleet event) — wakes on the FIRST key that matches. `*` matches any run of characters.',
      ),
    spec: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Composed THRESHOLD TREE (mutually exclusive with `event`): wake ONCE when a combination of event occurrences is satisfied. A leaf is { event, when? } (`when` = a payload_filter DataCondition on that event). Combinators: { all: [...] } = every child; { any: [...] } = ≥1 child; { some: { require: k, of: [...] } } = k-of-n. Nest ≤3 deep, ≤20 leaves total; event-level negation is not supported (absence is observed by the deadline). e.g. { any: [ { event: "deploy:done" }, { all: [ { event: "ci:green" }, { event: "review:approved" } ] } ] }. Deadline via timeout_sec/on_timeout as usual; a tree already satisfied at registration returns already_satisfied WITHOUT registering.',
      ),
    note: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('Why you are waiting — echoed into the wake turn so resumed-you has the thread. Auto-truncated to 2000 chars if longer.'),
    timeout_sec: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_SEC)
      .optional()
      .describe(`Deadline in seconds (default ${DEFAULT_TIMEOUT_SEC}). See on_timeout.`),
    on_timeout: z
      .enum(['wake', 'expire'])
      .optional()
      .describe(
        "What happens at the deadline without the event: 'wake' (default) = you are woken with a TIMEOUT marker (the non-event is as actionable as the event); 'expire' = the await lapses silently (visible in events:status).",
      ),
    plan_run_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('When awaiting FROM a plan run, pass its runId — the wake re-invokes the run via the plans:resume path instead of a session resume.'),
    payload_filter: dataConditionSchema
      .optional()
      .describe(
        "EI-8998: also require the emitted PAYLOAD to satisfy this predicate before firing, e.g. { queue_depth: { lt: 5 } } — same vocabulary as an ECA rule's `when`. Only takes effect combined with an `event` key/pattern the emitter actually fires. Omitted on event:'work-item:claimable'? EI-13846: it is auto-narrowed to YOUR OWN claim spec when one exists (see auto_scoped_payload_filter in the response) — pass this explicitly to override.",
      ),
    fromMsg: hardText(LIMITS.IDENT)
      .optional()
      .describe(
        'coord-authority-hardening P-006: a coord msg_id — await the gate THAT message declared (its `gateRefs` stamps, read server-side). Kills hand-typed key drift: you never re-type the key, the platform resolves it off the message. Exactly one gate on the message is required — none/many is a loud error naming what it found. Mutually exclusive with `event`/`spec`.',
      ),
  })
    .refine(
      (a) => [a.event, a.spec, a.fromMsg].filter((x) => x != null).length === 1,
      { message: 'pass exactly one of `event`, `spec`, or `fromMsg`' },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    startAwaitSweeper();

    // EI-383: a REAL registered await ends the turn until the wake — no activity-
    // bus event fires again until then, so any plan-item claim the caller holds
    // would otherwise lapse mid-sleep on a long park. Extend it to survive the
    // sleep (capped at the existing MAX_TTL_SEC ceiling — see claims.ts). Called
    // only right before an ACTUAL registration succeeds (not on an early
    // already_satisfied/already_fired/already_done short-circuit, which never
    // sleeps at all). Best-effort: never let this block or fail the await itself.
    const extendClaimsForThisAwait = async (timeoutSec: number): Promise<void> => {
      try {
        const harnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
        const { workspaceId } = await resolvePlanScope({
          harnessSlug: typeof harnessRaw === 'string' ? harnessRaw : undefined,
        });
        await extendOwnerClaimsForAwait(workspaceId, identity.ownerId, timeoutSec);
      } catch {
        /* best-effort — a claim-extension failure must never block registering the await */
      }
    };

    // ── Composed threshold-tree await (composable-event-awaits-2026-07-11): a `spec`
    //    (mutually exclusive with `event`) registers an all/any/some TREE that wakes
    //    ONCE when its combination is satisfied. Leaves are ordinary awaits; only a ROOT
    //    trip queues a wake. A tree already satisfied at registration short-circuits to
    //    already_satisfied without persisting anything. Spec validation (caps, no-`not`,
    //    unusable-glob) throws ComposedSpecError → a caller-facing error, never a 500. ──
    if (args.spec != null) {
      const { handle, note: handleNote } = await captureWakeHandleForOwner(identity.ownerId, {
        planRunId: args.plan_run_id,
      });
      try {
        const res = await registerComposedAwait({
          subscriberId: identity.ownerId,
          spec: args.spec as unknown as ComposedSpec,
          wakeHandle: handle,
          note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
          timeoutSec: args.timeout_sec ?? null,
          timeoutBehavior: args.on_timeout ?? 'wake',
        });
        if (!res.registered) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  already_satisfied: true,
                  fired: res.fired,
                  advice:
                    'The composed condition is ALREADY satisfied — no await was registered. Proceed now with the work it was gating instead of waiting.',
                }),
              },
            ],
          };
        }
        await extendClaimsForThisAwait(args.timeout_sec ?? DEFAULT_TIMEOUT_SEC);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                composed: true,
                root_id: res.rootId,
                await_id: res.anchorAwaitId,
                leaf_count: res.leafCount,
                depth: res.depth,
                on_timeout: args.on_timeout ?? 'wake',
                wake_handle: handleNote,
                advice:
                  'Registered a composed threshold tree. End your turn now — you will be woken ONCE when the combination is satisfied (or at the deadline). One-shot: re-register for the next occurrence. Cancel the whole tree with events:cancel { root_id }.',
              }),
            },
          ],
        };
      } catch (e) {
        if (e instanceof ComposedSpecError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: e.message,
                  advice: 'The composed `spec` is invalid — fix it and retry (see the events:await `spec` schema).',
                }),
              },
            ],
          };
        }
        throw e;
      }
    }

    // ── P-006 (coord-authority-hardening): fromMsg — resolve the gate key OFF the
    //    message that declared it, so the awaiter never re-types it (hand-typed
    //    near-miss keys never rendezvous; this closes that class). Exactly one
    //    gateRef on the message resolves; none/many is a LOUD, named error. ──
    let eventInput = args.event;
    if (args.fromMsg != null) {
      const origin = await getMessageById(args.fromMsg).catch(() => null);
      if (!origin) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'msg_not_found',
                fromMsg: args.fromMsg,
                advice: `fromMsg '${args.fromMsg}' matches no coord message — nothing was registered. Pass the msg_id from your inbox/feed line, or the gate key itself via \`event\`.`,
              }),
            },
          ],
        };
      }
      const gates = readGateRefs(origin as unknown as Record<string, unknown>);
      if (gates.length !== 1) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: gates.length === 0 ? 'no_gate_refs_on_msg' : 'ambiguous_gate_refs',
                fromMsg: args.fromMsg,
                gate_refs: gates.map((g) => g.key),
                advice:
                  gates.length === 0
                    ? `Message '${args.fromMsg}' carries no gateRefs stamp — nothing was registered. Ask the sender to re-send with gateRefs:[<key>], or find the key via events:catalog and await it via \`event\`.`
                    : `Message '${args.fromMsg}' declares ${gates.length} gates — pick one and await it via \`event\` (keys listed in gate_refs).`,
              }),
            },
          ],
        };
      }
      eventInput = gates[0].key;
    }
    if (eventInput == null) {
      // The refine guarantees exactly one of event/spec/fromMsg; spec is handled above.
      throw new Error('events:await: pass exactly one of `event`, `spec`, or `fromMsg`');
    }

    // ── Resolve the key: a PATTERN (glob / @macro) normalizes to a stored glob (P-201);
    //    an exact key passes through. A bad macro / too-broad glob throws a clear message. ──
    const patternAwait = isPattern(eventInput);
    const eventKey = patternAwait ? expandPatternMacro(eventInput) : eventInput;
    if (patternAwait) assertUsablePattern(eventKey);

    // ── EI-9270: the announced-gate LATCH — if this exact key was DECLARED and has
    // ALREADY fired, say so NOW instead of registering a wait that can never fire
    // again (the await-after-emit race that stranded late joiners forever). A lapsed
    // declaration (fired_reason='expired') is NOT a latch. Best-effort read.
    let announcedGate: {
      note: string | null;
      announcedBy: string;
      generation: number | null;
      expected: unknown | null;
    } | null = null;
    let nearMiss: Array<{ key: string; kind: 'await' | 'announce'; holders: number }> | null = null;
    if (!patternAwait) {
      try {
        const anns = await findAnnouncementsForKey(eventKey);
        const latched = anns.find((a) => a.firedAt && a.firedReason === 'event');
        if (latched) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  already_fired: true,
                  event: eventKey,
                  fired_at: latched.firedAt,
                  generation: latched.causalGeneration ?? null,
                  ...(latched.expectedCondition != null ? { expected: latched.expectedCondition } : {}),
                  ...(latched.note ? { gate_note: latched.note } : {}),
                  advice: `The announced gate "${eventKey}" ALREADY FIRED at ${latched.firedAt} — do not wait. Proceed with the work this gate was blocking now.`,
                }),
              },
            ],
          };
        }
        const declared = anns.find((a) => !a.firedAt);
        if (declared) {
          announcedGate = {
            note: declared.note,
            announcedBy: declared.subscriberId,
            generation: declared.causalGeneration ?? null,
            expected: declared.expectedCondition ?? null,
          };
        }
        // ── event-key-nearmiss-guard P-005: no announcement matches this key
        // exactly — advisory scan for a near-identical active key (another
        // agent's await, or a declared gate you almost-typed). Time-bounded +
        // fail-soft; the registration below always proceeds. ──
        if (anns.length === 0) {
          const found = await withBoundedTimeout(
            findNearMissKeys(eventKey, { excludeOwner: identity.ownerId }),
            { fallback: [], timeoutMs: 1_000, label: 'events-await:nearMiss' },
          );
          if (found.value.length > 0) {
            nearMiss = found.value.map((m) => ({ key: m.eventKey, kind: m.kind, holders: m.holders }));
          }
        }
      } catch { /* best-effort — never block a registration */ }
    }

    // ── EI-10870: the ORPHAN-AWAIT guard. `event` is a free-form string, so an
    // invented or mistyped key registers happily and can then only ever TIME OUT
    // — silently, in the safe-looking direction (the agent just waits, and reports
    // "it never happened"). Live proof: `overwatch:surface-landed` — 14 settled
    // awaits, 0 fires EVER, a key that appears nowhere in the tree. The catalog
    // already knew every family's emitter; nothing consulted it at await time.
    //
    // WARN, never reject — a key absent from the catalog is often legitimate (an
    // announced gate, a hand-minted pair key), and a hard reject would break them.
    // And if the installed tier cannot be CONFIRMED, stay silent: a false "nothing
    // emits this" is worse than no warning at all (it trains the warning out).
    // ── EI-13089: the bare FAMILY-PREFIX guard. `keyMatchesCatalog` (used by the
    // orphan-key probe just below) treats a family's prefix as a match whether its
    // first placeholder is required or optional — correct for optional (the bare
    // key IS the real global emit, e.g. `release:deployed`) but WRONG for required
    // (no emitter ever fires the bare literal, e.g. `work-item:done` with no id) —
    // so that probe alone would stay silent and this await could only ever TIME
    // OUT. Cheap + synchronous (static catalog only, no installed-tier I/O); same
    // guard scope as the orphan probe (skip on a pattern or an already-announced
    // gate — both are intentional, not a dropped param). Warns, never rejects.
    let requiredParamPrefixMismatch: { family: string; keyTemplate: string; paramName: string } | null = null;
    if (!patternAwait && !announcedGate) {
      const hit = findRequiredParamPrefixMatch(eventKey);
      if (hit) {
        requiredParamPrefixMismatch = {
          family: hit.entry.family,
          keyTemplate: hit.entry.keyTemplate,
          paramName: hit.param.name,
        };
      }
    }

    let unknownEventKey = false;
    if (!patternAwait && !announcedGate) {
      const harnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
      const probe = await withBoundedTimeout(
        (async () => {
          const installed = await readInstalledUnitEvents({
            harnessSlug: typeof harnessRaw === 'string' && harnessRaw !== '*' ? harnessRaw : undefined,
          });
          return mergeInstalledEventCatalog(installed).entries as readonly EventCatalogEntry[];
        })(),
        { fallback: null, timeoutMs: 1_500, label: 'events-await:orphanKey' },
      );
      // A null probe (timeout / discovery failure) ⇒ we cannot be sure ⇒ say nothing.
      if (probe.value) unknownEventKey = !keyMatchesCatalog(eventKey, probe.value);
    }

    // ── EI-18676056143796303: the orphan guard knows catalog MEMBERSHIP, but it
    // spoke about EMITTERS ("nothing in this system will ever fire it and this
    // await can only TIME OUT"). For a family that emits but was never registered
    // in the catalog, that verdict is flatly FALSE and maximally actionable in the
    // wrong direction — the correct response to it is to abandon the park, and the
    // live case was `coord:inbox-wake:<ownerId>`: the most-fired key in the system
    // AND the mechanism that rescues a stranded agent. Believing the warning there
    // strands you, which is exactly what the inbox-wake exists to prevent.
    //
    // The fire latch is DIRECT evidence to the contrary: this key (or a sibling in
    // its family) demonstrably fired. When there is such evidence, the membership
    // gap is a CATALOG bug, not a dead await — report it as that and drop the
    // scary claim entirely. A genuine orphan has neither exact nor sibling history,
    // so EI-10870's real case still warns. Bounded + fail-soft: an unavailable
    // latch leaves the (softened) warning exactly as it was.
    let emitterEvidence: KeyFireEvidence | null = null;
    if (unknownEventKey) {
      const evidence = await withBoundedTimeout(probeKeyFireEvidence(eventKey), {
        fallback: null,
        timeoutMs: 1_000,
        label: 'events-await:keyFireEvidence',
      });
      if (evidence.value && evidence.value.fires > 0) {
        emitterEvidence = evidence.value;
        unknownEventKey = false;
      }
    }

    // ── EI-13095 (the WI-5075 stranded-await incident): the done-key LATCH.
    // `work-item:done:<id>` fires ONCE, at settle time, so a registration made
    // AFTER the item settled can only ever time out — the awaiter sleeps through
    // a fix/completion that already happened (live case: an await on
    // work-item:done:WI-5075 registered 6 minutes after the item resolved slept
    // to its 2h timeout). The item row is the durable latch state: probe it NOW
    // and answer already_done instead of registering a dead wait. Same class as
    // the EI-9270 announced-gate latch and the P-006 unblocked latch below.
    // Best-effort + time-bounded: an 'unknown' probe registers normally.
    const doneTarget = patternAwait ? undefined : /^work-item:done:([^:]+)$/.exec(eventKey)?.[1];
    if (doneTarget) {
      const probe = await withBoundedTimeout(liveSettledProbe(doneTarget), {
        fallback: { verdict: 'unknown' as const },
        timeoutMs: 1_500,
        label: 'events-await:doneLatch',
      });
      if (probe.value.verdict === 'settled') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                already_done: true,
                event: eventKey,
                item_state: probe.value.itemState ?? 'settled',
                advice: `${doneTarget} is ALREADY settled (${probe.value.itemState ?? 'terminal'}) — "${eventKey}" fired when it settled and will not fire again. Do not wait; proceed with the work this settle unblocks now.`,
              }),
            },
          ],
        };
      }
    }

    // ── linking-notify-family-hardening P-006: the unblocked-key LATCH.
    // `work-item:unblocked:<id>` fires only on a blocked→unblocked EDGE, so a
    // registration against an item with NO live blocker (or already settled)
    // could only ever time out — the await-after-the-fact strand, same class
    // as the EI-9270 announced-gate race above. Say so NOW. Best-effort and
    // time-bounded: an 'unknown' probe (unreadable item, ambiguous id) falls
    // through to a normal registration.
    const unblockedTarget = patternAwait ? undefined : /^work-item:unblocked:([^:]+)$/.exec(eventKey)?.[1];
    if (unblockedTarget) {
      const probe = await withBoundedTimeout(liveBlockedState(unblockedTarget), {
        fallback: 'unknown' as const,
        timeoutMs: 1_500,
        label: 'events-await:unblockedLatch',
      });
      if (probe.value === 'unblocked' || probe.value === 'settled') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                already_unblocked: true,
                event: eventKey,
                item_state: probe.value,
                advice:
                  probe.value === 'settled'
                    ? `${unblockedTarget} is already SETTLED — "${eventKey}" will never fire. Do not wait on it.`
                    : `${unblockedTarget} has NO live blocker right now — it is ALREADY unblocked, so "${eventKey}" will not fire (it fires only on a future blocked→unblocked edge). Proceed with the blocked work now instead of waiting.`,
              }),
            },
          ],
        };
      }
    }

    // ── EI-13846 (hive-wide wake-storm): default the payload_filter for the
    // canonical `work-item:claimable` key to the CALLER'S OWN claim-spec view
    // when they didn't pass one explicitly. The member contract (scheduler:get_next's
    // miss advice, loop.ts's idle-park instruction) has always TOLD callers to copy
    // a derived filter onto this park, but nothing enforced or defaulted it — a
    // member that simply calls `events:await({ event: 'work-item:claimable' })`
    // (no lane yet, or one that just drained) got an UNSCOPED await that fires on
    // EVERY hive-wide claimable emission. On a ~2000-item board that is constant:
    // one drained member burned ~54 wakes / 272 tool calls overnight on a
    // guaranteed-miss scheduler:get_next, purely from an unscoped park. Reuses the
    // EI-15185 derivation verbatim (claimSpecFilterToClaimablePayloadFilter) — no
    // new translation logic, just applying it as a DEFAULT instead of advice text.
    // Best-effort: a claim-spec read failure/timeout must never block registration
    // — it just leaves the await unscoped, exactly as before this fix.
    let effectivePayloadFilter = args.payload_filter ?? null;
    let autoScopedFrom: { source: 'cup' | 'fleet'; specId: string; revision: number | null } | null = null;
    let unscopedClaimableWarning = false;
    if (!patternAwait && eventKey === 'work-item:claimable' && effectivePayloadFilter == null) {
      const probe = await withBoundedTimeout(
        getClaimSpecRecord({
          cupId: identity.ownerId,
          workspaceId: resolveClaimSpecWorkspace(identity.workspaceId ?? undefined),
        }),
        { fallback: null, timeoutMs: 1_500, label: 'events-await:claimSpecDefault' },
      );
      const record = probe.value;
      if (record && record.source !== 'default') {
        // EI-18674502503888023 / EI-18674151670359202 / EI-18674160393981819: the spec's
        // `view.filter` tree can NEVER carry a `harness` leaf (D-002 — harness scoping is a
        // resolver-level floor, not spec vocabulary; see ITEM_FIELDS in claim-spec.ts), so
        // `claimSpecFilterToClaimablePayloadFilter` alone can only narrow on kind/id/title/
        // plan/tags. A harness-bound fleet spec (the common case — every fleet:launch-on-plan
        // fleet stores its `harness_slug` on the very same cup_claim_specs row) was silently
        // left UNSCOPED on harness, so this auto-scope fired on any matching-kind item from
        // ANY harness in the workspace — observed live: a papercusp fleet member woken by a
        // brand-new bug in an unrelated harness (oddsmith-hive), burning a full wake for
        // nothing. Fix: AND in an explicit `harness` leaf from the claim-spec record's own
        // `harnessSlug` column (independent of the filter-tree translation) whenever it is
        // set, on top of whatever the filter tree itself narrows.
        const derived = claimSpecFilterToClaimablePayloadFilter(record.spec.view.filter) ?? null;
        const harnessLeaf = record.harnessSlug ? { harness: { equals: record.harnessSlug } } : null;
        const combined =
          derived && harnessLeaf ? { all: [derived, harnessLeaf] } : (harnessLeaf ?? derived);
        if (combined) {
          effectivePayloadFilter = combined;
          autoScopedFrom = { source: record.source, specId: record.spec.specId, revision: record.revision };
        } else {
          unscopedClaimableWarning = true;
        }
      } else {
        unscopedClaimableWarning = true;
      }
    }

    // ── EI-14225: retire the CALLER'S OWN prior pending registration(s) on this
    // EXACT key before adding a new one. events:await is one-shot by construction
    // (the caller only ever wants ONE outstanding wait per key) — the canonical
    // idle-park loop (scheduler:get_next miss → re-await 'work-item:claimable' →
    // end turn, repeated every wake) previously left every earlier registration
    // alive, each ticking down to its OWN independent timeout: a long-running loop
    // that re-registered on turns 2/3/4 could still be woken by turn 2's stale
    // await firing its TIMEOUT well after turns 3/4 were already handled — a full
    // wasted wake turn carrying a stale `note` for zero new information. Reuses the
    // exact supersede primitive the checkpoint/deploy sugar verbs already rely on
    // for this (cancelAwaitsForSubscribersOnKeys, EI-12457) instead of a new
    // mechanism. Best-effort: a failed retirement must never block registering the
    // new wait. Skipped when a PRIOR key genuinely fired for someone (announcedGate/
    // already_fired above already returned) — this only runs on the path that is
    // about to register a fresh row.
    let supersededCount = 0;
    try {
      supersededCount = await cancelAwaitsForSubscribersOnKeys([identity.ownerId], [eventKey]);
    } catch {
      /* best-effort — never let a retirement failure block the new registration */
    }

    // ── Capture the wake handle NOW (D-003) ────────────────────────────
    const { handle, note: handleNote } = await captureWakeHandleForOwner(identity.ownerId, {
      planRunId: args.plan_run_id,
    });

    const row = await registerAwait({
      subscriberId: identity.ownerId,
      eventKey,
      policy: 'wake',
      note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
      wakeHandle: handle,
      timeoutBehavior: args.on_timeout ?? 'wake',
      timeoutSec: args.timeout_sec ?? DEFAULT_TIMEOUT_SEC,
      payloadFilter: effectivePayloadFilter,
    });

    await extendClaimsForThisAwait(args.timeout_sec ?? DEFAULT_TIMEOUT_SEC);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            await_id: row.id,
            event: row.eventKey,
            ...(supersededCount > 0
              ? {
                  superseded: supersededCount,
                  superseded_advice: `Retired ${supersededCount} of your own prior pending await(s) on this exact key — one-shot semantics mean only the NEWEST registration stays live, so a stale earlier wait can no longer fire a duplicate/late TIMEOUT wake.`,
                }
              : {}),
            ...(args.fromMsg ? { resolved_from_msg: args.fromMsg } : {}),
            ...(patternAwait ? { pattern: true } : {}),
            ...(announcedGate ? { announced_gate: announcedGate } : {}),
            ...(nearMiss
              ? {
                  near_miss: nearMiss,
                  near_miss_advice: `No declaration matches "${eventKey}" exactly, but a near-identical key is active: "${nearMiss[0].key}" (${nearMiss[0].kind}). If you meant that key, events:cancel this await and re-await it EXACTLY — normalized-near keys never rendezvous.`,
                }
              : {}),
            ...(unknownEventKey
              ? {
                  unknown_event_key: true,
                  unknown_event_key_advice: `NO KNOWN EMITTER for "${eventKey}" — it matches no family in events:catalog, no announced gate, and no key in its family ("${eventKey.split(':').slice(0, 2).join(':')}") has EVER fired on this host, so this await will most likely only TIME OUT. If you mistyped a key, events:cancel and re-await the exact one (events:catalog lists them). If a peer is meant to emit it, have them DECLARE it first (events:emit { announce:true }) and await the key it returns. Registered anyway — this is a warning, not a refusal.`,
                }
              : {}),
            // EI-18676056143796303: the key emits but is missing from the catalog.
            // Say so plainly — the await is FINE (do not cancel it); what is broken
            // is the registry, and naming the gap is what gets it registered instead
            // of re-teaching the next agent to distrust the orphan warning.
            ...(emitterEvidence
              ? {
                  uncatalogued_event_key: true,
                  uncatalogued_event_key_advice: `"${eventKey}" matches no family in events:catalog, BUT it has demonstrably fired before — ${emitterEvidence.exact ? 'this exact key has fired' : `${emitterEvidence.distinctKeys} key(s) in its family "${emitterEvidence.prefix}" have fired`}, ${emitterEvidence.fires} time(s) total, most recently ${emitterEvidence.lastFiredAt ?? 'unknown'}. So an emitter EXISTS and this await is fine — do NOT cancel it. The gap is in the catalog, not your await: the family is unregistered, which is a bug worth filing (it also means events:catalog cannot surface this key to anyone else).`,
                  emitter_evidence: emitterEvidence,
                }
              : {}),
            ...(requiredParamPrefixMismatch
              ? {
                  family_prefix_missing_param: true,
                  family_prefix_missing_param_advice: `"${eventKey}" is the FAMILY PREFIX for '${requiredParamPrefixMismatch.family}' (template ${requiredParamPrefixMismatch.keyTemplate}), but its '${requiredParamPrefixMismatch.paramName}' param is REQUIRED — no emitter ever fires the bare key, so this await can only TIME OUT. Did you mean the parameterized key (fill in ${requiredParamPrefixMismatch.paramName}), or the glob form "${eventKey}:*" to wake on ANY instance? Registered anyway — this is a warning, not a refusal.`,
                }
              : {}),
            ...(autoScopedFrom
              ? {
                  auto_scoped_payload_filter: true,
                  payload_filter: effectivePayloadFilter,
                  payload_filter_source: autoScopedFrom,
                  auto_scoped_payload_filter_advice: `EI-13846: no payload_filter was passed, so this "work-item:claimable" await was AUTOMATICALLY narrowed to your own ${autoScopedFrom.source} claim spec (${formatSpecRef(autoScopedFrom.specId, autoScopedFrom.revision)}) — it will fire only on claimable items your spec could actually admit, not on every hive-wide release. Pass an explicit payload_filter to override.`,
                }
              : {}),
            ...(unscopedClaimableWarning
              ? {
                  unscoped_claimable_await: true,
                  unscoped_claimable_advice:
                    'EI-13846: no payload_filter was passed, and you have no claim spec that narrows over the claimable payload (id/kind/title/plan), so this await is UNSCOPED — it will wake you on EVERY hive-wide work-item:claimable emission, which fires constantly on a large board. If you are fleet-scoped, confirm scheduler:get_claim_spec narrows on one of those fields; otherwise pass an explicit payload_filter or expect frequent guaranteed-miss wakes.',
                }
              : {}),
            expires_ts: row.expiresTs,
            on_timeout: row.timeoutBehavior,
            wake_handle: handleNote,
            advice: patternAwait
              ? `Registered a PATTERN await on "${row.eventKey}". End your turn now — you will be re-invoked when the FIRST matching key fires (or at the deadline). It is one-shot: re-register if you need to wake on the next match too. Do not poll.`
              : 'Registered. End your turn now — you will be re-invoked when the event fires (or at the deadline). Do not poll.',
          }),
        },
      ],
    };
  },
});
