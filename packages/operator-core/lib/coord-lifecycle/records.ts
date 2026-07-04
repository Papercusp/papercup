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

/**
 * EI-6666: `whatLanded` / `deferred` are conceptually "one or more lines", and
 * every OTHER free-text-shaped completion field here (`summary`, `tests`,
 * `deploy`, `coordNotes`) accepts a plain string — so passing a bare string to
 * these two (the natural first guess) used to fail `invalid_input: expected
 * array, received string`, discoverable only by trial since the tool
 * description just says `completion?:object` with no field-level schema.
 * Accept either shape and normalize a single string to a one-element array —
 * the stored/rendered type (`string[] | undefined`) is unchanged.
 */
const stringOrStringArray = z
  .union([z.string().min(1), z.array(z.string().min(1))])
  .transform((v) => (typeof v === 'string' ? [v] : v));

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
  /** What landed — files / modules each with a one-line description. A single
   *  string is accepted and normalized to a one-element array (EI-6666). */
  whatLanded: stringOrStringArray.optional(),
  /** Migrations applied, e.g. ["146 spawned_agents supervision", "147 fleet_governor"]. */
  migrations: z.array(z.string().min(1)).optional(),
  /** Tests — counts / status, e.g. "67 green tests" or "32 tests green (vitest integration)". */
  tests: z.string().min(1).optional(),
  /** Deploy note, e.g. "additive, loads next :3070 restart" | "restarted :3070". */
  deploy: z.string().min(1).optional(),
  /**
   * The DEFERRED / surfaced-not-done / seams set. CRITICAL: the "surface every
   * deferred item" policy lives or dies here — a completion that silently drops
   * its deferrals is the exact failure the policy guards against. Rendered
   * prominently (see render.ts).
   */
  deferred: stringOrStringArray.optional(),
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
