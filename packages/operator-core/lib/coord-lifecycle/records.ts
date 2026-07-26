/**
 * records.ts — the STRUCTURED lifecycle records that replace free-text
 * `coord:send` prose (coord-lifecycle-automation-2026-06-04 D-004 / D-006).
 *
 * The plan's central finding: ~79% of free-text coord `messages` is
 * *predictable lifecycle* (completion, claim, intent/window, finding…). The
 * fix is to stop narrating those in prose and instead carry the same
 * information as a typed record whose `render*()` (see ./render) produces the
 * coord notification deterministically. These Zod schemas are the field design
 * — derived from the REAL corpus (`harness_shared.coord_event_log`, 2026-06-04
 * scan), so a record never loses what the prose said (D-006).
 *
 * A completion message in the wild looked like:
 *   "fleet-as-supervised-blackboard-2026-06-04 BUILT+TESTED (su-d3187): all 5
 *    phases/8 decisions, 67 green tests, migs 146/147/148. Additive, loads next
 *    :3070 restart. SEAMS: governor opt-in, supervise not auto-wired…"
 * — which decomposes cleanly into the fields below.
 */

import { z } from 'zod';

/** The lifecycle categories this layer renders (the D-003 automation table). */
export const LIFECYCLE_CATEGORIES = [
  'completion',
  'claim',
  'intent',
  'window',
  'handoff',
  'finding',
] as const;
export type LifecycleCategory = (typeof LIFECYCLE_CATEGORIES)[number];

/**
 * HOW the work was verified. WI-4536: this is a CLOSED ENUM, but it sits among free-text
 * siblings (`testsRun`, `testResult` are prose), so callers naturally write a sentence here
 * and get rejected — the enum members were discoverable ONLY from the rejection. Name them in
 * the schema so they surface in the tool description / typed signature instead.
 *   unit            — a unit test suite
 *   integration     — an integration test (real PG / containers / a live dependency)
 *   live-drove-ui   — drove the running UI (e.g. the Tauri shell) and observed it
 *   manual          — verified by hand (ran the build/command, inspected real output)
 *   already-passing — no new verification; the existing suite already covered it
 */
export const CompletionVerifiedHowSchema = z
  .enum(['unit', 'integration', 'live-drove-ui', 'manual', 'already-passing'])
  .describe(
    "HOW it was verified — one of exactly: 'unit' | 'integration' | 'live-drove-ui' | 'manual' | 'already-passing'. " +
      'NOT free text (put prose in `testsRun` / `testResult`).',
  );

export const CompletionVerificationEvidenceSchema = z.object({
  /** Files/modules changed, for audit queries without reading completion prose. */
  filesChanged: z.array(z.string().min(1)).optional(),
  /** Exact command/probe run, or the concrete already-fixed verification. */
  testsRun: z.string().min(1).optional(),
  /** Result summary, e.g. "9/9 green" or "HTTP 200 smoke passed". */
  testResult: z.string().min(1).optional(),
  /** Verification mode, coarse enough for leader/Queen completion audits. */
  verifiedHow: CompletionVerifiedHowSchema.optional(),
  /** Whether this completion added or changed tests. */
  addedTests: z.boolean().optional(),
});
export type CompletionVerificationEvidence = z.infer<typeof CompletionVerificationEvidenceSchema>;

/**
 * EI-10867 — the ONE key under which a terminal row's structured verification evidence
 * is stored, for BOTH work-item families (`harness_features_consolidated.payload` and
 * `engineer_issues.payload`, each jsonb).
 *
 * This constant used to be declared PRIVATELY and IDENTICALLY in work-items.ts and
 * issues-engineer.ts. That duplication is precisely how the write path and the audit
 * path drifted: the writers agreed on `_completionEvidence`, while the
 * `audit:'no-evidence'` reader keyed on `terminal_completion_ref` — a column the
 * completion gate FORCES to be non-null — so the audit could never return a row it was
 * named for (4,119 unverified terminal rows read as clean). Both families now import
 * this single key, so a write and an audit cannot disagree about where evidence lives.
 */
export const TERMINAL_COMPLETION_EVIDENCE_KEY = '_completionEvidence';

/**
 * EI-18736669939338784 — the key under which a SECOND (or third…) terminal close of an
 * already-completed item is recorded, for both families, beside (never on top of)
 * {@link TERMINAL_COMPLETION_EVIDENCE_KEY}.
 *
 * Why this exists: the terminal UPDATE stamps `terminal_owner` / `terminal_completion_ref`
 * / `authority` unconditionally, and merges evidence with jsonb `||` — a TOP-LEVEL key
 * merge, so an incoming `_completionEvidence` REPLACES the stored object wholesale rather
 * than deep-merging it. A second closer therefore silently destroyed the first closer's
 * record and was told `ok:true`. Observed live on WI-6112: a rich structured close
 * (verifiedHow:'integration', 4 filesChanged, testsRun) was overwritten 1.9s later by a
 * bare-string close from a different agent, leaving the row reading as an unverified
 * assertion. 107 cross-owner overwrites in the preceding 30 days; 28 with that exact
 * damage signature.
 *
 * The inversion that makes it dangerous: completion-integrity audits read whatever closed
 * LAST, so absent this the WEAKER record wins by arriving later — a bare assertion erases
 * a verification.
 *
 * Bounded, newest-last (same discipline as `payload.reopenHistory`).
 */
export const COMPLETION_ATTESTATIONS_KEY = '_completionAttestations';

/**
 * One non-authoritative terminal close recorded under {@link COMPLETION_ATTESTATIONS_KEY}.
 *
 * `outcome` says which side of the conflict this row was:
 *  · `attested`   — THIS close did not become the row's authoritative record (it was not
 *                   strictly richer than the one already stored). Nothing was destroyed.
 *  · `superseded` — this close WAS the authoritative record and was replaced by a later,
 *                   strictly-richer one; archived here so the upgrade is not a deletion.
 */
export interface CompletionAttestation {
  at: string;
  by: string | null;
  /** The terminal state this closer asked for (may differ from the state that stands). */
  state: string;
  completionRef: string | null;
  completionAuthority: string | null;
  evidence: CompletionVerificationEvidence | null;
  outcome: 'attested' | 'superseded';
}

/**
 * COMPLETION (D-004) — the single biggest token + signal win. A work_item
 * transitioning to done emits this instead of the agent hand-writing a
 * "DONE + tested, migration 137…" prose dump. Every field maps to a phrase
 * the corpus prose carried.
 */
export const CompletionRecordSchema = z.object({
  /** The plan / brief / work-item id, e.g. "fleet-as-supervised-blackboard-2026-06-04" or "F-012". */
  workItem: z.string().min(1),
  /** Optional human title when the id isn't self-describing. */
  title: z.string().optional(),
  /** One-line "what happened" — the headline (e.g. "all 5 phases/8 decisions, 67 green tests"). */
  summary: z.string().min(1),
  /** Freeform status verb: 'done' | 'built+tested' | 'landed' | 'shipped'. Default 'done'. */
  status: z.string().min(1).default('done'),
  /** What landed — files / modules each with a one-line description. */
  whatLanded: z.array(z.string().min(1)).optional(),
  /** Migrations applied, e.g. ["146 spawned_agents supervision", "147 fleet_governor"]. */
  migrations: z.array(z.string().min(1)).optional(),
  /** Tests — counts / status, e.g. "67 green tests" or "32 tests green (vitest integration)". */
  tests: z.string().min(1).optional(),
  /** Queryable verification evidence; aliases below keep legacy callers cheap. */
  verification: CompletionVerificationEvidenceSchema.optional(),
  filesChanged: z.array(z.string().min(1)).optional(),
  testsRun: z.string().min(1).optional(),
  testResult: z.string().min(1).optional(),
  verifiedHow: CompletionVerifiedHowSchema.optional(),
  addedTests: z.boolean().optional(),
  /** Deploy note, e.g. "additive, loads next :3070 restart" | "restarted :3070". */
  deploy: z.string().min(1).optional(),
  /**
   * The DEFERRED / surfaced-not-done / seams set. CRITICAL: the "surface every
   * deferred item" policy lives or dies here — a completion that silently drops
   * its deferrals is the exact failure the policy guards against. Rendered
   * prominently (see render.ts).
   */
  deferred: z.array(z.string().min(1)).optional(),
  /**
   * Genuinely-contextual residual (D-006): peer-addressed nuance, design notes
   * the structured fields can't hold. Stays free-text by design — NOT every
   * completion has this; most don't.
   */
  coordNotes: z.string().min(1).optional(),
  /** Plan slug for routing / coord:inbox grouping. */
  planSlug: z.string().min(1).optional(),
  /** Who completed it (display only; defaults from the firing agent's identity). */
  agent: z.string().min(1).optional(),
  /**
   * EI-8993 (dup-close accountability): the SURVIVING work-item id when this
   * completion closes the item as a duplicate. WI-3646 was wrongly dup-closed
   * THREE times by three different agents, each only saying "dup of WI-3543" in
   * free-text `summary` — no structured link, no notification, so the mistake
   * was undetectable by tooling and kept recurring. Setting this makes
   * `work_items:complete` auto-create a `duplicates` coord_links edge (this
   * item → duplicateOf) and auto-subscribe the item's current assignee (if any,
   * and not the closer) so the completion's existing watcher fan-out reaches
   * them even if they weren't already following it. The target must exist and
   * differ from the item being closed — validated at complete time, not
   * rendered here.
   */
  duplicateOf: z.string().min(1).optional(),
});
export type CompletionRecord = z.infer<typeof CompletionRecordSchema>;

/**
 * CLAIM / start (D-003, 5%) — "taking X". Auto-emitted when a work_item /
 * plan-item is claimed, so the agent doesn't hand-write "Executing … overnight".
 */
export const ClaimRecordSchema = z.object({
  /** The work-item / plan-item id being claimed. */
  workItem: z.string().min(1),
  /** Optional scope / approach note ("NEW test files only, no source edits"). */
  summary: z.string().min(1).optional(),
  planSlug: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
});
export type ClaimRecord = z.infer<typeof ClaimRecordSchema>;

/**
 * INTENT (D-003, part of the 29% — the biggest category) — the "heads-up /
 * now working on X" an agent declares via `coord:declare-intent`. Auto-emitted
 * so peers see it in the inbox (push) without the agent hand-writing a separate
 * "heads-up, I'm on X" coord:send. Distinct from WINDOW: an intent is a
 * statement of focus, not a scoped file-hold with a DONE.
 */
export const IntentRecordSchema = z.object({
  /** One-line "what I'm working on now". */
  intent: z.string().min(1),
  /** Files / area currently in scope, if declared. */
  files: z.array(z.string().min(1)).optional(),
  planSlug: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
});
export type IntentRecord = z.infer<typeof IntentRecordSchema>;

/**
 * WINDOW (D-003, part of the 29%) — the coordination window. "hold lib/ until
 * I post DONE" becomes a typed window claim that auto-broadcasts open /
 * draining / done. Pairs with the Gray intention-lock
 * (locks-correctness-hardening D-005).
 */
export const WINDOW_PHASES = ['open', 'draining', 'done'] as const;
export type WindowPhase = (typeof WINDOW_PHASES)[number];

export const WindowRecordSchema = z.object({
  /** The scope held — a path / glob / area, e.g. "libs/papercusp/packages/locks/*". */
  scope: z.string().min(1),
  /** Lifecycle phase of the window. */
  phase: z.enum(WINDOW_PHASES),
  /** One line on what you're doing in the window. */
  intent: z.string().min(1),
  planSlug: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
});
export type WindowRecord = z.infer<typeof WindowRecordSchema>;

/**
 * HANDOFF (D-008, the event-reaction motivating case) — the shared
 * `formatHandoff` layer. A handoff is structured (item + context + next step),
 * delivered + tracked; the render is shared so the pane render and the coord
 * notification agree.
 */
export const HandoffRecordSchema = z.object({
  /** The item being handed off (work-item id / brief / area). */
  item: z.string().min(1),
  /** Recipient agent / role, if directed; omitted ⇒ broadcast handoff. */
  to: z.string().min(1).optional(),
  /** Context the receiver needs to pick it up. */
  context: z.string().min(1),
  /** The concrete next step. */
  nextStep: z.string().min(1).optional(),
  planSlug: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
});
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;

/**
 * FINDING / health (D-003, 2%) — a discovered problem. Auto-emitted alongside
 * a work_item[kind=bug] / the watchdog event, so findings stop living only in
 * prose.
 */
export const FindingRecordSchema = z.object({
  /** One-line finding title. */
  title: z.string().min(1),
  /** Severity, freeform ('low'|'medium'|'high'|'critical' by convention). */
  severity: z.string().min(1).optional(),
  /** Detail / repro / where. */
  detail: z.string().min(1).optional(),
  /** The work_item id minted for it, if any (the bug). */
  workItemId: z.string().min(1).optional(),
  planSlug: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
});
export type FindingRecord = z.infer<typeof FindingRecordSchema>;
