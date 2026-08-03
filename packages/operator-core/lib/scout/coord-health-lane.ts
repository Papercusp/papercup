/**
 * coord-health-lane.ts — the COORD-HEALTH digest lane
 * (blender-self-learning-2026-07-12 P-008 / WI-4453).
 *
 * The coordination fabric continuously records how the FLEET is failing to
 * cooperate: escalations that re-mount over and over (a known-benign transient
 * whose "is this the same incident" dedup gate is too narrow — EI-9492), directed
 * messages that pile up unanswered (an agent alive but not draining its reply
 * queue), single inboxes flooded with thousands of near-duplicate wakes (a
 * subscription firehose or a re-firing sender), and claim conflicts (two agents
 * handed the same work-item). Today that pain reaches ideation only after a human
 * FILES an incident — the ideators never SAW the coordination breakdown itself,
 * only its downstream symptom. (Live example this lane was built from — 2026-07-13:
 * the `papercusp-stalled-claims-5agent-pattern` escalation re-mounted across ~4
 * consecutive Kettle reads and climbed advisory→blocker, while several su inboxes
 * carried tens of unanswered directed messages and ~9k coalesced-duplicate wakes.)
 *
 * This lane feeds the coordination fabric's health straight into the corpus digest
 * as grounded, citable patterns (`ref` = `coord:escalation-storm:<sig>` /
 * `coord:unanswered` / `coord:wake-storm:<recipient>` / `coord:claim-conflict` /
 * `coord:premise-resolve-rate`), so
 * ideation can target chronic coordination pain directly — the coordination
 * counterpart of the watchdog-health (P-007) and gate/pipeline-health (P-010) lanes.
 *
 * Deterministic + fail-soft, populated by the cycle seam (cycle-deps readCorpus)
 * exactly like watchdogHealth / gatePipelineHealth: an outage here never disturbs
 * the digest or the cycle. The unanswered-directed signal REUSES the hardened
 * fetchUnansweredDirected reader (WI-4537 exclusions — machine chatter, ack
 * ping-pong, synthetic senders) rather than re-deriving its subtle SQL; the storm
 * aggregates are thin own-SQL over coord_event_log, exactly as the sibling lanes
 * aggregate their own source tables (watchdog_ticks / pipeline_events).
 *
 * The PREMISE-RESOLVE signal (P-011 / D-091) is the one pattern here that is
 * AGGREGATE-ONLY BY CONSTRUCTION: `coord:premise-resolve-rate` carries no sender
 * suffix and must never grow one. `coord:wake-storm:<recipient>` is keyed and
 * `coord:unanswered` is not, so both shapes already exist in this lane — the
 * unkeyed one is an existing precedent, not a special case. See
 * `CoordPremiseResolve` for why keying a metric on an ASSERTED field by its
 * asserter destroys the very thing it measures.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { MetaPattern } from './types';
import type { PremiseRefKind } from '../agent-tools/coordination/message-fields';
import type { PremiseStatus } from '../agent-tools/coordination/premise-resolve';

/** One re-mounting escalation signature over the window (the pure builder input). */
export interface CoordEscalationStorm {
  /** the escalation's dedup signature (subjectSignature / livenessSignature / summary). */
  signature: string;
  /** distinct escalation OPEN events on this signature in the window (the re-mount count). */
  count: number;
  /** most-severe severity seen for this signature. */
  severity: 'blocker' | 'advisory' | 'unknown';
  /** a representative summary for context. */
  sample: string;
}

/** One recipient's inbound coord-message volume over the window. */
export interface CoordWakeStorm {
  recipient: string;
  /** messages + notifies delivered to this recipient in the window. */
  count: number;
}

/** One recipient's standing unanswered-directed backlog (from fetchUnansweredDirected). */
export interface CoordUnansweredTarget {
  recipient: string;
  count: number;
  oldestAgeMs: number;
}

/**
 * One REF KIND's premise-resolution tally (P-011 / D-091).
 *
 * Keyed by ref GRAMMAR, never by sender — see `CoordPremiseResolve` for why that
 * is a correctness constraint rather than a presentation choice.
 */
export interface CoordPremiseKindStat {
  kind: PremiseRefKind;
  /** refs that reached a falsifiable verdict (holds | broken | stale | unresolvable). */
  checked: number;
  holds: number;
  broken: number;
  stale: number;
  unresolvable: number;
}

/**
 * The premise-resolution aggregate over the window — the P-011 measurement that
 * REPLACES fill rate (D-104: forced sectioning made fill rate 100% by
 * construction, so it measures nothing).
 *
 * ⚠ THERE IS NO SENDER FIELD ON THIS TYPE, AND THERE MUST NEVER BE ONE (D-091).
 * `premises` is an ASSERTED field whose values are only PARTLY checkable: a typed
 * ref resolves against a graph, free prose cannot — and D-026 forbids excluding
 * the prose. Attach any per-agent consequence to being caught with an
 * unresolvable ref — a score, a nag, a warning, or merely a lane pattern naming
 * the sender — and the dominant strategy becomes "cite only what a graph can
 * verify, or stop citing". The measurement would then destroy what it measures,
 * and the uncheckable-but-true premises (the ones a sender must state precisely
 * BECAUSE no graph holds them) are the first to go. Same argument shape as the
 * owner's D-090 ruling on `forYouBecause`, and as `youMayNotKnow.provenance`.
 *
 * The breakdown is by REF KIND because that is what makes the reading ACTIONABLE
 * without attribution: it says which ref GRAMMAR is failing, which is fixable in
 * a tool description and in the docs. Attribution says only which agent to lean
 * on, which is the thing forbidden.
 */
export interface CoordPremiseResolve {
  /** distinct agent-authored premise refs seen in the window (context, NOT a rate). */
  refsSeen: number;
  /** refs that reached a falsifiable verdict — the RATE's denominator. */
  checked: number;
  /** refs that resolved and whose claim currently holds — the RATE's numerator. */
  holds: number;
  /** per-REF-KIND breakdown. Never per-agent. */
  byKind: readonly CoordPremiseKindStat[];
  /**
   * `doc` / `opaque` — declarable but never invalidatable (D-026). NOT failures,
   * and deliberately OUTSIDE the rate: counting them would punish the honest
   * citation of something no graph holds.
   */
  notCheckable: number;
  /** the probe itself failed. OUR failure, not the sender's — also outside the rate. */
  unknown: number;
  /** representative FAILING refs (ref + verdict only — never a sender). */
  samples: readonly { ref: string; status: PremiseStatus; note?: string }[];
}

/**
 * P-012 / D-106 — did moving clarification onto the LIVE path actually raise
 * P(answer)? The adoption reading for the `clarify` message field.
 *
 * WHAT THIS MEASURES, AND WHY IT IS THIS AND NOT FILL RATE. `clarify` carries a
 * question PAIRED with the assumption the sender proceeds on. `assuming` is
 * MANDATORY IN THE SCHEMA — so "share of entries carrying an assumption" is
 * 100% by construction and measures exactly nothing. That is D-104's vacuous
 * metric in a new costume, and it is deliberately absent from this type.
 *
 * The falsifiable question is the one D-106's whole argument rests on: asking
 * only pays when an answer actually arrives, so the signal is the ANSWER RATE.
 * The baselines to beat were measured on the incumbent surface before the field
 * existed (2026-08-02, 60d): the conversation path answered 10 of 42 questions
 * (~24%) and orphaned 32 (76%), while `coord:ask` drew 6 calls against
 * `coord:send`'s 3512 (~1:84). If clarification-on-the-live-path is the right
 * call, this rate beats 24%.
 *
 * ⚠ EXPECT ZERO FOR A WHILE, AND THAT IS NOT A DEFECT. The field ships in the
 * same change as this reading, so there is no traffic yet by construction. The
 * builder is SILENT below `minClarifyAsks` rather than reporting a 0/0 rate,
 * for the same reason `coord:premise-resolve-rate` is: a rate over a handful of
 * events is noise wearing a number's clothes, and an emitted 0% would read as a
 * finding about the field rather than an absence of data.
 *
 * ⚠ NO SENDER DIMENSION — same constraint as `CoordPremiseResolve`, and it
 * binds harder here. Keying an ASK metric by the asking agent makes asking a
 * thing to avoid being seen doing, which kills the field outright (D-091,
 * generalising the owner's D-090 R3).
 */
export interface CoordClarifyAdoption {
  /** agent-authored messages in the window carrying ≥1 `clarify` entry. */
  asks: number;
  /** of those, how many drew a reply. The RATE's numerator. */
  answered: number;
  /** total `clarify` entries (one message may carry several). Context, not a rate. */
  entries: number;
}

/**
 * THE THREE LEVELS OF "ADOPTION" (plan coordination-spec-adoption-2026-08-03,
 * D-091 there — not to be confused with agent-protocol D-091 cited above).
 *
 * WHY THIS SHAPE. "Adoption" was doing three different jobs, and conflating them
 * produced a headline that was wrong by two orders of magnitude
 * (EI-19300252001829260: "0.58% adopted", measured on a denominator that mixed
 * system writers and machine lifecycle emissions in with agent prose — its
 * NUMERATOR was exactly right). So this type refuses to collapse them:
 *
 *   L1 PRESENCE    the field is there. A PRECONDITION, never a headline — a
 *                  schema that refuses the old shape can compel presence, so
 *                  L1 alone cannot tell real use from wrapper compliance.
 *   L2 SUBSTANCE   the content is non-degenerate (several sections, authored
 *                  fields actually filled).
 *   L3 CONSEQUENCE a reader received it and its next action differed. The only
 *                  level that means the spec is working, and the one nothing in
 *                  this system measured before this type existed.
 *
 * EVERY COUNT CARRIES ITS OWN DENOMINATOR as a sibling field, because the one
 * failure this is built to prevent is a ratio quoted without one (D-003).
 *
 * ⚠ NO SENDER DIMENSION — the same constraint as {@link CoordPremiseResolve} and
 * {@link CoordClarifyAdoption}, and it binds here too: a per-agent adoption
 * breakdown turns a coordination field into a compliance scoreboard, and writing
 * `forYouBecause` to avoid looking bad is not a theory of mind (D-090/D-091 R3).
 */
export interface CoordAuthoredAdoption {
  /** L1 denominator: hand-authored agent prose in the window (machine senders and `auto:true` lifecycle emissions excluded — they CANNOT carry sections, so including them is the EI-19300252001829260 bug). */
  handAuthored: number;
  /** L1 numerator: of those, how many carry a `sections` array. */
  withSections: number;
  /** L2: of the sectioned ones, how many carry MORE than one section (a 1-element array is what a wrapper looks like). */
  multiSection: number;
  /** L2: of the sectioned ones, how many fill ≥1 authored field (forYouBecause / premises / youMayNotKnow / couldNotDetermine). */
  withAuthoredField: number;
  /** L3 denominator: messages carrying `couldNotDetermine` — an OPEN question, the field that most demands a reader do something. */
  openQuestions: number;
  /** L3 numerator: of those, how many drew a reply from a recipient. The closest thing to "a reader acted" that this corpus can currently evidence. */
  openQuestionsAnswered: number;
  /** L3 context: `coord:read` calls in the window — the only surface that shows authored structure IN FULL. The in-band marker carries the forYouBecause RELATION and mere COUNTS; the note, the youMayNotKnow items and premises past the first live behind this call. */
  structureReads: number;
}

/** The pure builder's input — the coordination-breakdown aggregate over the window. */
export interface CoordHealthInput {
  /** re-mounting escalation signatures (open events grouped by signature). */
  escalationStorms: readonly CoordEscalationStorm[];
  /** per-recipient inbound-message volume (inbox/wake flooding). */
  wakeStorms: readonly CoordWakeStorm[];
  /** fleet-wide standing unanswered-directed backlog per recipient. */
  unansweredTargets: readonly CoordUnansweredTarget[];
  /** claim-conflict events in the window. */
  claimConflicts: number;
  /** premise-citation quality (P-011 / D-091). Absent ⇒ the signal is simply not emitted. */
  premiseResolve?: CoordPremiseResolve;
  /** `clarify` adoption (P-012 / D-106). Absent ⇒ the signal is simply not emitted. */
  clarifyAdoption?: CoordClarifyAdoption;
  /** L1/L2/L3 authored-structure adoption (coordination-spec-adoption-2026-08-03 P-001). Absent ⇒ the signal is simply not emitted. */
  authoredAdoption?: CoordAuthoredAdoption;
}

/**
 * The incumbent-surface baselines this reading is judged against, measured
 * 2026-08-02 over 60d BEFORE `clarify` existed (D-106). Named constants rather
 * than numbers inline in a template string, so a future re-measurement updates
 * one place and the emitted text cannot drift from the comment explaining it.
 */
export const CLARIFY_BASELINE_CONVERSATION_ANSWER_RATE = 0.24;

export interface CoordHealthOpts {
  /** min re-mounts to surface an escalation storm (advisory); a blocker surfaces at 1. */
  minEscalationReMounts?: number;
  /** min per-recipient unanswered-directed count for a recipient to count as "backlogged". */
  minUnanswered?: number;
  /** min inbound-message count for a recipient to surface as an inbox/wake flood. */
  minWakeStorm?: number;
  /** min claim-conflict events to surface the pattern. */
  minClaimConflicts?: number;
  /** min CHECKED premise refs before the resolve-rate is worth reporting at all. */
  minPremiseChecked?: number;
  /** min `clarify` asks before the answer-rate is worth reporting at all. */
  minClarifyAsks?: number;
  /** min hand-authored messages in the window before the L1/L2/L3 adoption reading is worth reporting — below it the ratios are noise, and a 0/0 "adoption %" is exactly the kind of number this signal exists to stop publishing. */
  minAuthoredAdoptionMessages?: number;
  /** cap on emitted patterns. */
  limit?: number;
}

/** Slugify a free-text signature/recipient into a compact, stable ref suffix. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'unknown'
  );
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function humanAge(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h${rem}m` : `${h}h`;
}

/**
 * PURE: the coordination-breakdown aggregate → digest patterns.
 *
 * Emits (most-acute first): re-mounting ESCALATION STORMS (the leaking dedup gate —
 * a blocker surfaces even at one re-mount; an advisory needs a chronic count), the
 * fleet-wide UNANSWERED-DIRECTED backlog (comms stalling), CLAIM CONFLICTS (two
 * agents on one item), then the chronic WAKE/INBOX FLOODS (noise burning turns).
 * Sorted acute→chronic, capped.
 */
export function buildCoordHealthPatterns(
  input: CoordHealthInput,
  opts: CoordHealthOpts = {},
): MetaPattern[] {
  const minReMounts = opts.minEscalationReMounts ?? 3;
  const minUnans = opts.minUnanswered ?? 5;
  const minWake = opts.minWakeStorm ?? 200;
  const minClaim = opts.minClaimConflicts ?? 3;
  const minPremiseChecked = opts.minPremiseChecked ?? 5;
  const minClarifyAsks = opts.minClarifyAsks ?? 5;
  const minAuthoredAdoptionMessages = opts.minAuthoredAdoptionMessages ?? 20;
  const limit = opts.limit ?? 10;

  const out: MetaPattern[] = [];

  // 1. Escalation storms — a signature that re-mounts a full escalation cascade.
  //    A blocker demands attention even at one re-mount; an advisory must be chronic.
  const storms = [...input.escalationStorms]
    .filter((s) => (s.severity === 'blocker' && s.count >= 1) || s.count >= minReMounts)
    .sort(
      (a, b) =>
        (b.severity === 'blocker' ? 1 : 0) - (a.severity === 'blocker' ? 1 : 0) ||
        b.count - a.count,
    );
  for (const s of storms) {
    out.push({
      category: 'coord-health',
      ref: `coord:escalation-storm:${slug(s.signature)}`,
      summary: `escalation re-mounted ${s.count}× in 24h (${s.severity}): ${trunc(s.signature, 80)} — a repeating cascade, not a one-off`,
      detail: `${s.count} escalation event(s)/24h on the same signature${
        s.sample ? `; e.g. "${trunc(s.sample, 120)}"` : ''
      }. A known-benign transient re-mounting a full escalation cascade (fresh work-item + probe + owner alert) means the "is this the same incident" dedup gate is too narrow (EI-9492): widen the dedup key or add a recently-resolved suppression so the same condition can't re-page every wake.`,
      weight: s.severity === 'blocker' ? 1 : 0.8,
    });
  }

  // 2. Unanswered directed — a directed message is meant to PREEMPT the recipient's
  //    work, so a growing per-agent backlog means agents are alive but not draining
  //    their reply queue (the "live but not converting" stall).
  const worst = [...input.unansweredTargets]
    .filter((t) => t.count >= minUnans)
    .sort((a, b) => b.count - a.count);
  if (worst.length > 0) {
    const total = worst.reduce((n, t) => n + t.count, 0);
    const top = worst
      .slice(0, 5)
      .map((t) => `${t.recipient} ${t.count} (${humanAge(t.oldestAgeMs)})`)
      .join(', ');
    out.push({
      category: 'coord-health',
      ref: 'coord:unanswered',
      summary: `${worst.length} agent(s) hold ≥${minUnans} unanswered directed message(s) (${total} total) — directed comms are stalling`,
      detail: `worst: ${top}. A directed message OUTRANKS the recipient's own work; a per-agent backlog that grows across wakes despite landed nudges is a coordination-comms stall (agents alive, producing turns, but not converting into reply-drain or claim progress) — the reply-obligation surfacing or the wake→reply path may be failing.`,
      weight: 0.7,
    });
  }

  // 3. Claim conflicts — two agents handed the same work-item (scheduler/claim-spec
  //    dedup leak, or a stale claim not releasing).
  if (input.claimConflicts >= minClaim) {
    out.push({
      category: 'coord-health',
      ref: 'coord:claim-conflict',
      summary: `${input.claimConflicts} claim conflict(s) in 24h — agents contending for the same work-item`,
      detail:
        'repeated claim conflicts mean the scheduler/claim-spec is surfacing the same item to multiple agents, or a stale claim is not releasing on session death; check claim TTLs, the hold-open sweep cadence, and scheduler dedup.',
      weight: 0.6,
    });
  }

  // 4. Premise-citation quality (P-011 / D-091) — the replacement for fill rate.
  //
  //    Deliberately emitted BEFORE the wake-storm floods: floods emit one pattern
  //    PER RECIPIENT and are the most numerous thing this lane produces, so a
  //    noisy fleet would push this single corpus-wide reading past `limit` and
  //    silently delete the measurement. Ordering is the cap policy here.
  const pr = input.premiseResolve;
  if (pr && pr.checked >= minPremiseChecked) {
    const failed = pr.checked - pr.holds;
    const rate = pr.holds / pr.checked;
    const failRate = 1 - rate;
    const pct = (n: number) => `${Math.round(n * 100)}%`;

    // Per-KIND, worst grammar first — that ordering is the actionable part.
    const kinds = [...pr.byKind]
      .filter((k) => k.checked > 0)
      .sort(
        (a, b) => b.checked - b.holds - (a.checked - a.holds) || b.checked - a.checked,
      );
    const kindLine = kinds
      .map((k) => `${k.kind} ${k.holds}/${k.checked}`)
      .join(', ');
    const sampleLine = pr.samples
      .slice(0, 4)
      .map((s) => `${s.ref} → ${s.status}${s.note ? ` (${trunc(s.note, 60)})` : ''}`)
      .join('; ');

    out.push({
      category: 'coord-health',
      ref: 'coord:premise-resolve-rate',
      summary: `premise refs resolve ${pct(rate)} (${pr.holds}/${pr.checked} checked; ${failed} failing) — cited ground that does not hold`,
      detail:
        `by ref kind: ${kindLine || 'n/a'}. ` +
        `${pr.refsSeen} distinct agent-authored premise ref(s) in 24h; ${pr.notCheckable} not-checkable (doc/opaque — declarable but never invalidatable, D-026, deliberately outside the rate) and ${pr.unknown} unknown (the probe failed — our gap, not the sender's).` +
        (sampleLine ? ` Failing: ${sampleLine}.` : '') +
        ` A premise is what a sender's reasoning RESTED ON, so a ref that does not resolve means a message was built on ground that was never there (broken) or has since moved (stale). ` +
        `Read this by REF GRAMMAR, never by sender: the fix for a failing kind is a clearer ref form in the tool description and the docs. ` +
        `NOT a gate — a low rate never blocks, warns, or refuses a send (D-091; D-088's standing condition that verification is never authorisation).`,
      // Weight tracks the FAILURE rate, not the volume: an all-holds reading is
      // still emitted (a reader that only ever sees failures cannot tell "no
      // premises were checkable" from "all of them held" — the same argument
      // premise-resolve.ts makes for carrying both stamp halves), but it ranks
      // low enough that the cap deprioritises it naturally.
      weight: Math.min(0.75, 0.25 + 0.5 * failRate),
    });
  }

  // 4b. `clarify` adoption (P-012 / D-106) — did moving clarification onto the
  //     live path raise P(answer)? Emitted next to the premise reading, and for
  //     the same cap reason: it is ONE corpus-wide reading competing with
  //     per-recipient floods.
  const ca = input.clarifyAdoption;
  if (ca && ca.asks >= minClarifyAsks) {
    const rate = ca.answered / ca.asks;
    const base = CLARIFY_BASELINE_CONVERSATION_ANSWER_RATE;
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    const verdict =
      rate > base
        ? `ABOVE the ${pct(base)} conversation-path baseline — moving clarification onto the live path is paying`
        : `at or BELOW the ${pct(base)} conversation-path baseline — the live path is not (yet) buying a better answer rate`;

    out.push({
      category: 'coord-health',
      ref: 'coord:clarify-answer-rate',
      summary: `clarify asks answered ${pct(rate)} (${ca.answered}/${ca.asks}) — ${verdict}`,
      detail:
        `${ca.asks} agent-authored message(s) carried a \`clarify\` section in 24h (${ca.entries} entr(y|ies) total); ${ca.answered} drew a reply. ` +
        `\`clarify\` pairs a question with the assumption the sender proceeds on ANYWAY, so an unanswered ask is not a stalled sender — it is a peer acting on an assumption nobody corrected. ` +
        `Baseline to beat (measured before the field existed): the conversation path answered ~${pct(base)} of questions and orphaned 76%, and coord:ask drew 6 calls against coord:send's 3512. ` +
        `Read this as a reading on the MECHANISM, never on the askers: no per-agent breakdown exists or may be added, because attaching a consequence to being seen asking is what kills the field (D-091/D-090 R3). ` +
        `Never a gate, and never a fill rate — \`assuming\` is schema-mandatory, so its fill rate is 100% by construction and measures nothing (D-104).`,
      // Ranks by SHORTFALL against the baseline: a rate that beats the incumbent
      // is good news and should not crowd out live coordination breakdowns.
      weight: Math.min(0.7, 0.25 + Math.max(0, base - rate)),
    });
  }

  // 4b. AUTHORED-STRUCTURE ADOPTION, reported as THREE levels and never as one
  //     number (coordination-spec-adoption-2026-08-03 D-091). The summary leads
  //     with L3 because L3 is the only level that says the spec is working: L1
  //     was ~80% and L2 healthy at a moment when the full structure was opened
  //     15 times in a week, and a single blended "adoption %" would have hidden
  //     exactly that.
  const aa = input.authoredAdoption;
  if (aa && aa.handAuthored >= minAuthoredAdoptionMessages) {
    const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : 'n/a');
    const l1 = pct(aa.withSections, aa.handAuthored);
    const l2 = pct(aa.withAuthoredField, Math.max(aa.withSections, 1));
    const l3 =
      aa.openQuestions > 0 ? pct(aa.openQuestionsAnswered, aa.openQuestions) : 'no open questions';

    // The gap that matters: structure written vs structure ever opened in full.
    const writtenWithStructure = aa.withAuthoredField;
    const readStarved = writtenWithStructure > 0 && aa.structureReads * 10 < writtenWithStructure;

    out.push({
      category: 'coord-health',
      ref: 'coord:authored-adoption',
      summary:
        `authored structure — L1 present ${l1} (${aa.withSections}/${aa.handAuthored} hand-authored), ` +
        `L2 substantive ${l2} (${aa.withAuthoredField}/${aa.withSections} sectioned), ` +
        `L3 open-questions answered ${l3}` +
        (readStarved ? ` — READ-STARVED: ${writtenWithStructure} written vs ${aa.structureReads} coord:read` : ''),
      detail:
        `Three levels, deliberately NOT collapsed into one number. ` +
        `L1 PRESENCE ${aa.withSections}/${aa.handAuthored} hand-authored messages carry sections — a PRECONDITION, not a result: the schema refuses a plain string, so this level can be satisfied by wrapping one and measures compliance, not use. ` +
        `L2 SUBSTANCE ${aa.withAuthoredField}/${aa.withSections} sectioned messages fill an authored field and ${aa.multiSection} carry more than one section — this is what separates real structure from a one-element wrapper. ` +
        `L3 CONSEQUENCE ${aa.openQuestionsAnswered}/${aa.openQuestions} messages carrying an OPEN question (couldNotDetermine) drew a reply, and coord:read — the only surface showing authored structure IN FULL — was called ${aa.structureReads} time(s) in 24h. ` +
        `The in-band [coord+N] marker carries the forYouBecause RELATION and mere COUNTS; the note, the youMayNotKnow items and premises past the first are only visible through coord:read. ` +
        `A LOW L3 against a HIGH L1 is the diagnostic this signal exists to make visible: it means the write half of "agents write their intent and other agents read it" shipped and the read half did not. ` +
        `Denominators are stated inline on purpose — a ratio quoted without one is how "0.58% adopted" was published from a numerator that was exactly right (EI-19300252001829260). ` +
        `Aggregate-only, and no per-sender breakdown exists or may be added: attaching a consequence to being seen authoring these fields is what kills them (D-090/D-091 R3).`,
      // Ranks by the READ gap, not by L1. A high L1 with a starved read path is
      // the alarming state and must outrank a low L1 that is merely early.
      weight: readStarved ? 0.65 : Math.min(0.5, 0.2 + (1 - aa.withSections / Math.max(aa.handAuthored, 1)) * 0.3),
    });
  }

  // 5. Wake / inbox floods — one recipient buried under thousands of (often near-
  //    duplicate) deliveries: a subscription firehose or a re-firing sender whose
  //    coalescing/dedup is leaking; heavy wake traffic burns turns and buries real
  //    directed mail.
  const floods = [...input.wakeStorms]
    .filter((w) => w.count >= minWake)
    .sort((a, b) => b.count - a.count);
  for (const w of floods) {
    out.push({
      category: 'coord-health',
      ref: `coord:wake-storm:${slug(w.recipient)}`,
      summary: `${w.recipient} received ${w.count} coord message(s) in 24h — an inbox/wake flood`,
      detail: `${w.count} deliveries/24h to one recipient. A subscription firehose or a re-firing sender is flooding this inbox — if most are near-duplicates the coalescing/dedup is leaking; heavy wake traffic burns turns and buries real directed mail under noise.`,
      weight: Math.min(0.6, 0.2 + w.count / 5000),
    });
  }

  return out.slice(0, Math.max(1, limit));
}

/** Bound on how many distinct refs one lane pass will probe. */
const PREMISE_REFS_MAX = 200;

/**
 * The premise-resolution read (P-011 / D-091).
 *
 * ⚠ REUSES THE LIVE RESOLVER — `resolvePremiseStamps` + the production
 * `premiseProbes()` — deliberately, and this is the load-bearing design choice
 * rather than convenience. A second, lane-local "does this ref resolve" checker
 * would be free to drift from the one the SEND path stamps with, and the two
 * would then disagree about what "resolves" means: the corpus digest would
 * report a rate that no message stamp corroborates. One resolver, two callers.
 *
 * Every dependency is imported DYNAMICALLY inside the function, matching this
 * lane's existing treatment of `fetchUnansweredDirected` and premise-probes.ts's
 * own rule — the stores stay out of the module graph at load time.
 *
 * Fail-soft to `undefined`: an outage here removes the signal, never the lane.
 */
export async function loadCoordPremiseResolve(
  ws: string,
): Promise<CoordPremiseResolve | undefined> {
  try {
    const { sql } = getOrgPg();
    const [{ MACHINE_SENDER_PATTERN }, { resolvePremiseStamps, PREMISE_STAMPS_MAX }, { premiseProbes }] =
      await Promise.all([
        import('../agent-tools/coordination/machine-authored'),
        import('../agent-tools/coordination/premise-resolve'),
        import('../agent-tools/coordination/premise-probes'),
      ]);

    // AGENT-AUTHORED ONLY (D-091's denominator). The exclusion reuses the ONE
    // canonical machine-sender pattern shared by sendMessage and
    // unanswered-directed rather than a third hand-maintained list — a private
    // copy here is exactly how the three call sites would drift apart.
    // `premises` live on SECTIONS, never on the envelope (verified against the
    // live corpus: 78 sectioned rows, 0 envelope-level).
    const rows = await sql<Array<{ ref: string }>>`
      SELECT DISTINCT p AS ref
        FROM harness_shared.coord_event_log e
        CROSS JOIN LATERAL jsonb_array_elements(e.body->'sections') s
        CROSS JOIN LATERAL jsonb_array_elements_text(s->'premises') p
       WHERE e.workspace_id = ${ws}
         AND e.surface = 'messages'
         AND e.ts > now() - interval '24 hours'
         AND jsonb_typeof(e.body->'sections') = 'array'
         AND jsonb_typeof(s->'premises') = 'array'
         AND NOT (coalesce(e.body->>'from', '') ~ ${MACHINE_SENDER_PATTERN})
       LIMIT ${PREMISE_REFS_MAX}`;

    const refs = rows.map((r) => r.ref).filter(Boolean);
    if (refs.length === 0) return undefined;

    // `resolvePremiseStamps` caps at PREMISE_STAMPS_MAX (its per-MESSAGE
    // contract), so a window-wide read is chunked to that cap rather than
    // bypassing it — the cap keeps its meaning and the resolver stays untouched.
    const probes = premiseProbes({});
    const stamps: Awaited<ReturnType<typeof resolvePremiseStamps>> = [];
    for (let i = 0; i < refs.length; i += PREMISE_STAMPS_MAX) {
      stamps.push(...(await resolvePremiseStamps(refs.slice(i, i + PREMISE_STAMPS_MAX), probes)));
    }

    return aggregatePremiseStamps(stamps);
  } catch {
    return undefined;
  }
}

/**
 * PURE: resolved stamps → the per-REF-KIND aggregate. Split out from the IO so
 * the counting rules (what lands in the rate, what is held outside it) are
 * unit-testable without a database.
 */
export function aggregatePremiseStamps(
  stamps: readonly { ref: string; kind: PremiseRefKind; status: PremiseStatus; note?: string }[],
): CoordPremiseResolve {
  const byKind = new Map<PremiseRefKind, CoordPremiseKindStat>();
  let checked = 0;
  let holds = 0;
  let notCheckable = 0;
  let unknown = 0;
  const samples: { ref: string; status: PremiseStatus; note?: string }[] = [];

  for (const s of stamps) {
    // `not-checkable` and `unknown` are held OUTSIDE the rate on purpose: the
    // first would punish honestly citing something no graph holds (D-026), the
    // second would charge the sender for OUR probe failing.
    if (s.status === 'not-checkable') {
      notCheckable += 1;
      continue;
    }
    if (s.status === 'unknown') {
      unknown += 1;
      continue;
    }

    let k = byKind.get(s.kind);
    if (!k) {
      k = { kind: s.kind, checked: 0, holds: 0, broken: 0, stale: 0, unresolvable: 0 };
      byKind.set(s.kind, k);
    }
    k.checked += 1;
    checked += 1;
    if (s.status === 'holds') {
      k.holds += 1;
      holds += 1;
    } else {
      if (s.status === 'broken') k.broken += 1;
      else if (s.status === 'stale') k.stale += 1;
      else k.unresolvable += 1;
      if (samples.length < 8) samples.push({ ref: s.ref, status: s.status, note: s.note });
    }
  }

  return {
    refsSeen: stamps.length,
    checked,
    holds,
    byKind: [...byKind.values()],
    notCheckable,
    unknown,
    samples,
  };
}

/**
 * The `clarify` adoption read (P-012 / D-106).
 *
 * REPLY DETECTION, AND ITS KNOWN BIAS — STATED, NOT HIDDEN. An ask counts as
 * answered when a RECIPIENT sent a message threaded to it
 * (`related_msg_id` = the ask's `msg_id`). That is branch (1) of
 * `unanswered-directed`'s hardened predicate, reused verbatim in shape rather
 * than re-derived.
 *
 * Its LOOSE branch — an un-threaded reply back to the sender, narrowed and
 * PAIRED so one reply clears at most one ask (WI-6729, EI-13819, WI-5345) — is
 * deliberately NOT reproduced here. That logic is subtle, order-dependent, and
 * exists to protect a counter that PREEMPTS an agent's work; a second, simpler
 * copy of it in a digest lane would drift from the original and quietly
 * disagree with it. So this reading UNDER-COUNTS answers, because this fleet's
 * agents overwhelmingly reply in fresh standalone messages rather than
 * re-threading.
 *
 * The direction of that error is the safe one for THIS metric: it can only make
 * clarification look WORSE than it is, so a rate that still beats the 24%
 * conversation baseline is a conservative win rather than an artefact. It is
 * also apples-to-apples with that baseline, which was itself measured on an
 * explicit linkage (`accepted_post_id`). If the rate ever sits just under the
 * baseline, this bias is the FIRST thing to re-examine — not evidence against
 * the field.
 *
 * Fail-soft to `undefined`: an outage removes the signal, never the lane.
 */
export async function loadCoordClarifyAdoption(
  ws: string,
): Promise<CoordClarifyAdoption | undefined> {
  try {
    const { sql } = getOrgPg();
    const { MACHINE_SENDER_PATTERN } = await import(
      '../agent-tools/coordination/machine-authored'
    );

    const rows = await sql<Array<{ asks: number; answered: number; entries: number }>>`
      WITH asks AS (
        SELECT e.body->>'msg_id' AS msg_id,
               e.body->'to'      AS recipients,
               (
                 SELECT count(*)
                   FROM jsonb_array_elements(e.body->'sections') s2
                   CROSS JOIN LATERAL jsonb_array_elements(s2->'clarify') c
                  WHERE jsonb_typeof(s2->'clarify') = 'array'
               )::int AS entries
          FROM harness_shared.coord_event_log e
         WHERE e.workspace_id = ${ws}
           AND e.surface = 'messages'
           AND e.ts > now() - interval '24 hours'
           AND jsonb_typeof(e.body->'sections') = 'array'
           AND e.body->>'msg_id' IS NOT NULL
           AND NOT (coalesce(e.body->>'from', '') ~ ${MACHINE_SENDER_PATTERN})
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(e.body->'sections') s
              WHERE jsonb_typeof(s->'clarify') = 'array'
                AND jsonb_array_length(s->'clarify') > 0
           )
      ),
      -- MATERIALISE THE REPLIES ONCE. The obvious shape -- a correlated EXISTS
      -- over coord_event_log per ask -- is a full scan PER ASK (related_msg_id
      -- lives in jsonb and is unindexed), so it costs nothing while clarify has
      -- no traffic and TIMES OUT the moment it does. Not hypothetical: the
      -- correlated form was measured against a populated field of the same
      -- shape (premises) and hit the statement timeout, while this one returns
      -- in ~35ms over the same rows. A lane query that only works while its
      -- field is unused is a latent outage, and a zero-traffic read can never
      -- reveal it.
      replies AS (
        SELECT DISTINCT r.body->>'related_msg_id' AS to_msg_id,
                        r.body->>'from'           AS responder
          FROM harness_shared.coord_event_log r
         WHERE r.workspace_id = ${ws}
           AND r.surface = 'messages'
           AND r.ts > now() - interval '24 hours'
           AND r.body ? 'related_msg_id'
      )
      SELECT count(*)::int AS asks,
             coalesce(sum(a.entries), 0)::int AS entries,
             count(*) FILTER (
               WHERE EXISTS (
                 SELECT 1 FROM replies rp
                  WHERE rp.to_msg_id = a.msg_id
                    AND a.recipients @> to_jsonb(ARRAY[rp.responder])
               )
             )::int AS answered
        FROM asks a`;

    const r = rows[0];
    if (!r || Number(r.asks) === 0) return undefined;
    return {
      asks: Number(r.asks) || 0,
      answered: Number(r.answered) || 0,
      entries: Number(r.entries) || 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * L1/L2/L3 authored-structure adoption over the 24h window
 * (coordination-spec-adoption-2026-08-03 P-001). See {@link CoordAuthoredAdoption}
 * for why the three levels may not be collapsed into one number.
 *
 * THE DENOMINATOR IS THE WHOLE POINT. `handAuthored` excludes machine senders
 * (MACHINE_SENDER_PATTERN — the SAME shared constant sendMessage stamps with) AND
 * `auto:true` lifecycle emissions. Both look agent-authored (`from` is an su-… id
 * on the lifecycle ones) and NEITHER can carry sections, so counting them is how
 * a correct numerator produced a headline off by two orders of magnitude.
 *
 * REPLIES ARE MATERIALISED ONCE, for the reason recorded verbatim in
 * loadCoordClarifyAdoption above: the correlated-EXISTS form was measured against
 * a POPULATED field of this exact shape and hit the statement timeout. This query
 * reads a populated field from day one, so the cheap-while-empty trap is not
 * hypothetical here — it would fire immediately.
 */
export async function loadCoordAuthoredAdoption(
  ws: string,
): Promise<CoordAuthoredAdoption | undefined> {
  try {
    const { sql } = getOrgPg();
    const { MACHINE_SENDER_PATTERN } = await import(
      '../agent-tools/coordination/machine-authored'
    );

    // `sections` is absent on most rows and jsonb_array_elements THROWS on a
    // non-array, so every lateral coalesces to '[]' rather than relying on a
    // WHERE guard — the L1 DENOMINATOR must include section-less messages, so
    // filtering them out (as the clarify query legitimately does) is not open
    // to us here.
    const rows = await sql<
      Array<{
        hand_authored: number;
        with_sections: number;
        multi_section: number;
        with_authored_field: number;
        open_questions: number;
        open_questions_answered: number;
      }>
    >`
      WITH hand AS (
        SELECT e.body->>'msg_id' AS msg_id,
               e.body->'to'      AS recipients,
               (jsonb_typeof(e.body->'sections') = 'array')                    AS has_sections,
               coalesce(jsonb_array_length(
                 CASE WHEN jsonb_typeof(e.body->'sections') = 'array'
                      THEN e.body->'sections' ELSE '[]'::jsonb END), 0)        AS n_sections,
               EXISTS (
                 SELECT 1 FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(e.body->'sections') = 'array'
                        THEN e.body->'sections' ELSE '[]'::jsonb END) s
                  WHERE s ?| array['forYouBecause','premises','youMayNotKnow','couldNotDetermine']
               ) AS has_authored,
               EXISTS (
                 SELECT 1 FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(e.body->'sections') = 'array'
                        THEN e.body->'sections' ELSE '[]'::jsonb END) s
                  WHERE jsonb_typeof(s->'couldNotDetermine') = 'array'
                    AND jsonb_array_length(s->'couldNotDetermine') > 0
               ) AS has_open_question
          FROM harness_shared.coord_event_log e
         WHERE e.workspace_id = ${ws}
           AND e.surface = 'messages'
           AND e.ts > now() - interval '24 hours'
           AND e.body->>'kind' = 'message'
           AND e.body->>'msg_id' IS NOT NULL
           AND NOT (coalesce(e.body->>'from', '') ~ ${MACHINE_SENDER_PATTERN})
           AND coalesce(e.body->>'auto', 'false') <> 'true'
      ),
      replies AS (
        SELECT DISTINCT r.body->>'related_msg_id' AS to_msg_id,
                        r.body->>'from'           AS responder
          FROM harness_shared.coord_event_log r
         WHERE r.workspace_id = ${ws}
           AND r.surface = 'messages'
           AND r.ts > now() - interval '24 hours'
           AND r.body ? 'related_msg_id'
      )
      SELECT count(*)::int                                              AS hand_authored,
             count(*) FILTER (WHERE h.has_sections)::int                AS with_sections,
             count(*) FILTER (WHERE h.n_sections > 1)::int              AS multi_section,
             count(*) FILTER (WHERE h.has_authored)::int                AS with_authored_field,
             count(*) FILTER (WHERE h.has_open_question)::int           AS open_questions,
             count(*) FILTER (
               WHERE h.has_open_question
                 AND EXISTS (
                   SELECT 1 FROM replies rp
                    WHERE rp.to_msg_id = h.msg_id
                      AND h.recipients @> to_jsonb(ARRAY[rp.responder])
                 )
             )::int                                                     AS open_questions_answered
        FROM hand h`;

    const r = rows[0];
    if (!r || Number(r.hand_authored) === 0) return undefined;

    // L3's depth-read signal. Its own query and its own failure domain: a
    // tool_invocations outage must degrade this ONE number to 0, never take the
    // whole reading down with it.
    let structureReads = 0;
    try {
      const reads = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${ws}
           AND invoked_at > now() - interval '24 hours'
           AND tool_name = 'coord:read'`;
      structureReads = Number(reads[0]?.n) || 0;
    } catch {
      structureReads = 0;
    }

    return {
      handAuthored: Number(r.hand_authored) || 0,
      withSections: Number(r.with_sections) || 0,
      multiSection: Number(r.multi_section) || 0,
      withAuthoredField: Number(r.with_authored_field) || 0,
      openQuestions: Number(r.open_questions) || 0,
      openQuestionsAnswered: Number(r.open_questions_answered) || 0,
      structureReads,
    };
  } catch {
    return undefined;
  }
}

/**
 * The PG edge: the 24h coordination-breakdown aggregate over coord_event_log for
 * the active workspace + the fleet-wide unanswered-directed read (REUSING the
 * hardened fetchUnansweredDirected). Returns [] on any failure (fail-soft lane).
 */
export async function buildCoordHealthLane(
  opts: { workspaceId?: string } = {},
): Promise<MetaPattern[]> {
  try {
    const ws = opts.workspaceId ?? activeWorkspaceId();
    const { sql } = getOrgPg();

    // Re-mounting escalations: OPEN events (kind='escalation', not the resolved
    // markers) grouped by dedup signature over 24h. The count is the storm.
    const escRows = await sql<
      Array<{ sig: string; n: number; sev_rank: number; sample: string | null }>
    >`
      SELECT
        coalesce(
          body->>'subjectSignature',
          body->>'livenessSignature',
          left(body->>'summary', 80)
        ) AS sig,
        count(*)::int AS n,
        max(
          CASE body->>'severity'
            WHEN 'blocker' THEN 2
            WHEN 'advisory' THEN 1
            ELSE 0
          END
        )::int AS sev_rank,
        (array_agg(body->>'summary' ORDER BY ts DESC))[1] AS sample
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${ws}
         AND surface = 'escalations'
         AND body->>'kind' = 'escalation'
         AND ts > now() - interval '24 hours'
       GROUP BY 1`;

    // Per-recipient inbound volume (inbox/wake flooding): real agent recipients
    // only — never a broadcast ('*'), an audience selector ('@…'), or 'human'.
    const wakeRows = await sql<Array<{ recipient: string; n: number }>>`
      SELECT r AS recipient, count(*)::int AS n
        FROM harness_shared.coord_event_log
        CROSS JOIN LATERAL jsonb_array_elements_text(body->'to') AS r
       WHERE workspace_id = ${ws}
         AND surface = 'messages'
         AND ts > now() - interval '24 hours'
         AND jsonb_typeof(body->'to') = 'array'
         AND r NOT IN ('human', '*')
         AND r NOT LIKE '@%'
       GROUP BY 1
      HAVING count(*) >= 100`;

    // Claim conflicts in the window (best-effort text match — the coord log does
    // not carry a dedicated conflict kind).
    const claimRows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${ws}
         AND surface = 'messages'
         AND ts > now() - interval '24 hours'
         AND (
           body->>'summary' ILIKE '%claim%conflict%'
           OR body::text ILIKE '%claim_conflict%'
         )`;

    // Unanswered directed — REUSE the hardened reader over the active recipient
    // set (best-effort: an unavailable coord fast-path yields no targets).
    let unansweredTargets: CoordUnansweredTarget[] = [];
    try {
      const recipRows = await sql<Array<{ r: string }>>`
        SELECT DISTINCT r
          FROM harness_shared.coord_event_log
          CROSS JOIN LATERAL jsonb_array_elements_text(body->'to') AS r
         WHERE workspace_id = ${ws}
           AND surface = 'messages'
           AND ts > now() - interval '3 days'
           AND r ~ '^(su-|s-|cup-)'
         LIMIT 300`;
      const recipients = recipRows.map((x) => x.r).filter(Boolean);
      if (recipients.length > 0) {
        const { fetchUnansweredDirected } = await import(
          '../agent-tools/coordination/unanswered-directed'
        );
        const map = await fetchUnansweredDirected(recipients);
        unansweredTargets = [...map.entries()].map(([recipient, s]) => ({
          recipient,
          count: s.count,
          oldestAgeMs: s.oldestAgeMs,
        }));
      }
    } catch {
      /* best-effort — the unanswered signal is optional decoration */
    }

    // Premise-citation quality (P-011 / D-091) — independent + fail-soft, so a
    // premise-read outage costs this one signal and never the whole lane.
    let premiseResolve: CoordPremiseResolve | undefined;
    try {
      premiseResolve = await loadCoordPremiseResolve(ws);
    } catch {
      /* best-effort — the premise signal is optional decoration */
    }

    // `clarify` adoption (P-012 / D-106) — independently fail-soft, so a zero-
    // traffic or failing read costs this one signal and never the lane.
    let clarifyAdoption: CoordClarifyAdoption | undefined;
    try {
      clarifyAdoption = await loadCoordClarifyAdoption(ws);
    } catch {
      /* best-effort — the clarify signal is optional decoration */
    }

    // L1/L2/L3 authored-structure adoption (coordination-spec-adoption P-001) —
    // independently fail-soft for the same reason as its two siblings above.
    let authoredAdoption: CoordAuthoredAdoption | undefined;
    try {
      authoredAdoption = await loadCoordAuthoredAdoption(ws);
    } catch {
      /* best-effort — the adoption signal is optional decoration */
    }

    return buildCoordHealthPatterns({
      premiseResolve,
      clarifyAdoption,
      authoredAdoption,
      escalationStorms: escRows.map((r) => ({
        signature: r.sig || 'unknown',
        count: Number(r.n) || 0,
        severity: r.sev_rank >= 2 ? 'blocker' : r.sev_rank >= 1 ? 'advisory' : 'unknown',
        sample: r.sample ?? '',
      })),
      wakeStorms: wakeRows.map((r) => ({
        recipient: r.recipient,
        count: Number(r.n) || 0,
      })),
      unansweredTargets,
      claimConflicts: Number(claimRows[0]?.n) || 0,
    });
  } catch {
    return [];
  }
}
