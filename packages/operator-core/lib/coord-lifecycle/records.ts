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
// P-008 (d): type-only, so the payload contract and the resolver cannot disagree
// about the stored shape without a compile error — and so no runtime import cycle
// is created between this module and the facts substrate.
import type { ResolvedAssumption } from '../agent-facts/assumptions';

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
 * HOW the work was verified. WI-4536 originally made this a CLOSED ENUM, but it sits among
 * free-text siblings (`testsRun`, `testResult`) and callers naturally write a concise label
 * such as "macOS Tauri smoke" here. Keep the canonical labels discoverable and queryable,
 * while accepting any non-empty label so a useful verification record is never rejected at
 * the completion boundary. Detailed evidence still belongs in `testsRun` / `testResult`.
 *   unit            — a unit test suite
 *   integration     — an integration test (real PG / containers / a live dependency)
 *   live-drove-ui   — drove the running UI (e.g. the Tauri shell) and observed it
 *   manual          — verified by hand (ran the build/command, inspected real output)
 *   already-passing — no new verification; the existing suite already covered it
 */
export const CompletionVerifiedHowSchema = z
  .string()
  .min(1)
  .describe(
    "HOW it was verified — a non-empty label. Prefer 'unit' | 'integration' | 'live-drove-ui' | 'manual' | 'already-passing' for queryable coarse modes; concise free-text labels are also accepted. Put detailed evidence in `testsRun` / `testResult`.",
  );

/**
 * WI-37960: coverage evidence for a verification-shaped completion.
 *
 * A universal claim ("every page", "all facts", "nothing invented") is not
 * auditable from a sentence alone. The population must be enumerated, each
 * entry must be assigned a checked/not-checked/not-applicable status, and the
 * residue must be explicit (use `residue: ['none']` when there is none).
 * The completion gate performs the cross-field accounting check; this schema
 * keeps the durable shape typed and shared by both completion aliases.
 */
export const CompletionCoverageSchema = z.object({
  population: z
    .array(z.string().min(1))
    .min(1)
    .describe('The complete, uniquely named population. Copy each entry verbatim into exactly one status bucket.'),
  checked: z
    .array(z.string().min(1))
    .optional()
    .describe('Population entries verified as checked; entries must be copied verbatim and appear at most once.'),
  notChecked: z
    .array(z.string().min(1))
    .optional()
    .describe('Population entries not verified; entries must be copied verbatim and appear at most once.'),
  notApplicable: z
    .array(z.string().min(1))
    .optional()
    .describe('Population entries that do not apply; entries must be copied verbatim and appear at most once.'),
  residue: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe("For a universal-verification close this is required and non-empty; use ['none'] for zero residue."),
}).describe(
  "Coverage is an exact partition: every population entry must appear verbatim in exactly one of checked, notChecked, or notApplicable; do not use descriptive replacements or extra bucket entries. For universal-verification closes, residue is required and non-empty, with residue:['none'] declaring zero residue. Omitted status buckets mean empty buckets.",
);
export type CompletionCoverage = z.infer<typeof CompletionCoverageSchema>;

/**
 * EI-18682004530991057 (proposal 3) — what tree a completion's verification was
 * observed against. See the `treeStamp` field on
 * {@link CompletionVerificationEvidenceSchema} for why this is server-stamped.
 *
 * Deliberately carries ONLY what can be observed EXACTLY and CHEAPLY. It does not
 * carry a dirty/clean verdict: every spawn-free way to compute one is a heuristic
 * (an mtime newer than `.git/index` cannot distinguish "touched" from "modified"),
 * and a heuristic verdict written into a durable record that later readers trust
 * WITHOUT re-checking is worse than an absent field — it manufactures exactly the
 * confident-but-wrong reading this whole evidence surface exists to prevent. The
 * honest half ships; the guessed half does not.
 */
export const CompletionTreeStampSchema = z.object({
  /**
   * Canonical local checkout root that owns `headSha`. Optional only so pre-fix
   * persisted SHA-only records remain readable; new server stamps always include it.
   */
  repositoryRoot: z.string().min(1).optional(),
  /**
   * Full HEAD commit sha of the integration checkout at close time, read directly
   * from the git refs (never via a `git` subprocess — see completionTreeStamp()).
   */
  headSha: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/),
});
export type CompletionTreeStamp = z.infer<typeof CompletionTreeStampSchema>;

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
  addedTests: z
    .boolean()
    .optional()
    .describe(
      'A boolean FLAG — did this completion add or change tests? true/false, NOT a description of ' +
      'what was added (put that prose in `testsRun` / `testResult`).',
    ),
  /** Enumerated population + per-entry status for universal verification claims (WI-37960). */
  coverage: CompletionCoverageSchema.optional(),
  /**
   * EI-19319623239777505: the caller's free-text `completion.summary`, carried alongside
   * the structured fields it sits next to. Before this field existed, `summary` was NEVER
   * persisted anywhere durable — not on a normal close (work_items:complete never passed
   * a `completionRef`, deliberately, per P-004 — see complete.ts) and not on a second
   * (already-terminal) close either (the attestation's `completionRef` fell back to
   * `opts.completionRef ?? null`, which complete.ts also never populates). The caller's
   * narrative was echoed back in the tool's RETURN value only, never written to the row —
   * so a later reader (an audit, a leader brief, a fresh agent picking the item back up)
   * had no way to recover WHAT was done, only whether it met the `committed` evidence bar.
   * Deliberately does NOT affect `isSufficientEvidence`/`authorityForCompletion` (both key
   * only on `verifiedHow` + `testsRun`/`testResult`) — this is purely an additional,
   * non-authority-bearing carry-through of the prose the caller already wrote.
   */
  summary: z.string().min(1).optional(),
  /**
   * EI-18682004530991057 (proposal 3) — the commit the verification was run against,
   * stamped by the SERVER at close time rather than asked of the caller.
   *
   * Why it is not optional-in-spirit: `testResult: "172 passed / 0 failed"` names no
   * particular code. On this shared checkout every agent edits ONE working tree, so a
   * result recorded without a commit is not weak evidence, it is unanchored evidence —
   * a later reader cannot tell whether it describes the code they are looking at, an
   * older revision, or a tree that was mid-edit by a peer when the suite ran. The
   * sibling EI-18681435059177620 measured this directly: three measurements of one file
   * were each invalidated by an edit landing on top, producing both a false alarm AND a
   * false all-clear inside 25 minutes.
   *
   * SERVER-STAMPED on purpose. Asking the caller for it would put the one field a
   * reviewer most needs to trust in the hands of the party whose claim is being checked,
   * and it is the field most likely to be filled in from memory — the same failure mode
   * `filesChanged` already exhibits (EI-20093150500083378: 8 of 12 declared paths did not
   * exist). A caller-supplied sha is a testimonial; an observed one is evidence.
   *
   * Absent whenever it could not be observed (no repo root, unreadable/ambiguous git
   * refs). Absence means "not observed", never "clean" or "unknown-but-fine".
   */
  treeStamp: CompletionTreeStampSchema.optional(),
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
 * (since-deleted) `audit:'no-evidence'` reader keyed on `terminal_completion_ref` — a column the
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
 * P-008 (d) / D-050 / D-079 — the ONE key under which a terminal close's RESOLVED
 * assumption declaration is stored, for both work-item families.
 *
 * Declared beside {@link TERMINAL_COMPLETION_EVIDENCE_KEY} and for the same reason
 * that constant's header gives: two private, identical copies is precisely how a
 * write path and its reader drift. P-011's conflicting-assumption detector reads
 * this key; nothing may re-declare it locally.
 *
 * ⚠ Until P-008 (d) this key did not exist and `assumptions` was NOT PERSISTED AT
 * ALL — required on every terminal close, format-checked by two zod refines, then
 * referenced zero times downstream. D-050's claim that the gate enforced "an
 * assumption was STATED... strictly more than the nothing that preceded it" was
 * therefore false as built: a declaration that is validated and discarded is
 * exactly nothing, plus a required field.
 */
export const TERMINAL_ASSUMPTIONS_KEY = '_assumptions';

/**
 * What lands under {@link TERMINAL_ASSUMPTIONS_KEY}.
 *
 * `'none'` is stored VERBATIM rather than as an empty array: D-016's whole
 * argument for the literal is that an explicit "this rests on nothing recorded"
 * is a real answer, and flattening it to `[]` would make it indistinguishable
 * from a close that predates the field.
 */
export interface StoredAssumptionDeclaration {
  /** The literal 'none', or the resolved entries (see `ResolvedAssumption`). */
  declared: 'none' | ResolvedAssumption[];
  /** When resolution ran — the ISO instant the conditions below were true. */
  resolvedAt: string;
}

/**
 * EI-18764241942332131: Postgres' jsonb TEXT-INPUT parser refuses a literal NUL
 * code point inside a JSON string with `unsupported Unicode escape sequence` —
 * text columns simply cannot represent it. `JSON.stringify` happily round-trips a
 * raw NUL (it survives as the six-character escape sequence in the output text),
 * so the failure is deferred all the way to the `::text::jsonb` cast at write
 * time, and the NUL itself is invisible in every surface an agent would inspect
 * it with (renders as nothing or a plain space, survives a plain JSON round-trip)
 * — so the resulting Postgres error names neither the offending field nor the
 * offending byte.
 *
 * Deep-strips every embedded NUL from the string leaves of an arbitrary JSON-ish
 * value (object / array / string / primitive); everything else is returned
 * unchanged (by reference, when nothing needed stripping). `stripped:true` tells
 * a caller at least one NUL was actually removed, so it can surface a
 * loud-but-non-blocking warning instead of silently rewriting an agent's evidence
 * (EI-24 record-and-warn discipline). PURE — no PG required to unit-test.
 *
 * Implementation note for future editors: the NUL character below is produced at
 * runtime by calling the string-from-character-code constructor with zero. Do not
 * replace that call with a literal character typed into this source file: several
 * editors and terminals display an embedded raw NUL byte as an ordinary blank
 * space, so a hand-typed literal is easy to get wrong without any visual sign,
 * and this repository lints tracked source files against containing one.
 */
export function stripNulBytesDeep<T>(value: T): { value: T; stripped: boolean } {
  const NUL = String.fromCharCode(0);
  let stripped = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (!v.includes(NUL)) return v;
      stripped = true;
      return v.split(NUL).join('');
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  const walked = walk(value);
  return { value: (stripped ? walked : value) as T, stripped };
}

/**
 * The jsonb a terminal write merges into `payload`: structured completion evidence
 * plus the resolved assumption declaration.
 *
 * ⚠ SHARED BY BOTH FAMILIES ON PURPOSE. `completionEvidencePayloadJson` existed as
 * two byte-identical private copies — one in work-items.ts, one in
 * issues-engineer.ts — which is the *precise* duplication this module's
 * {@link TERMINAL_COMPLETION_EVIDENCE_KEY} header describes as how a write path and
 * its reader drift apart. Adding assumptions to both copies would have made it
 * three. One builder, both families, no third copy.
 *
 * Returns null when there is nothing to merge, so the caller's `IS NULL` branch
 * leaves `payload` untouched. PURE.
 *
 * EI-18764241942332131: also the DEFENSE-IN-DEPTH backstop for {@link stripNulBytesDeep}
 * — every terminal-state write's evidence/assumptions merge funnels through this one
 * function (both families), so sanitizing HERE protects every caller, not just
 * `work_items:complete` (which additionally sanitizes at its own tool boundary — see
 * `agent-tools/work_items/complete.ts` — so the state write and the completion record
 * it accompanies can never disagree about whether a NUL-bearing close landed).
 */
export function terminalPayloadMergeJson(
  evidence: CompletionVerificationEvidence | undefined,
  assumptions?: StoredAssumptionDeclaration | undefined,
): string | null {
  const merge: Record<string, unknown> = {};
  if (evidence && Object.keys(evidence).length > 0) merge[TERMINAL_COMPLETION_EVIDENCE_KEY] = evidence;
  if (assumptions) merge[TERMINAL_ASSUMPTIONS_KEY] = assumptions;
  if (Object.keys(merge).length === 0) return null;
  const { value: sanitized } = stripNulBytesDeep(merge);
  return JSON.stringify(sanitized);
}

/**
 * Read a stored assumption declaration off a payload. Defensive double-parse: the
 * column is jsonb but arrives as a string down some facade legs, and a nested JSON
 * string has been observed in the wild for the evidence key. PURE.
 */
export function readStoredAssumptions(payload: unknown): StoredAssumptionDeclaration | null {
  let obj = payload;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  let v = (obj as Record<string, unknown>)[TERMINAL_ASSUMPTIONS_KEY];
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const d = (v as StoredAssumptionDeclaration).declared;
  // 'none' or an array, nothing else — an out-of-band write must read as "no
  // declaration", never as a shape P-011's detector would mis-consume.
  if (d !== 'none' && !Array.isArray(d)) return null;
  return v as StoredAssumptionDeclaration;
}

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
  /**
   * P-008 (d) / D-079 R4: the assumptions THIS close declared.
   *
   * Carried here as well as under {@link TERMINAL_ASSUMPTIONS_KEY} because the
   * terminal UPDATE merges payload with jsonb `||` — a TOP-LEVEL key merge — so a
   * second closer REPLACES the stored object wholesale (EI-18736669939338784: 27
   * cross-owner second closes, 12 lost evidence, 15 mis-attributed). Without this
   * a losing closer's declaration would be destroyed by exactly the mechanism
   * that already destroyed evidence, in the same field, one release later.
   */
  assumptions: StoredAssumptionDeclaration | null;
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
  /** Top-level alias for the structured verification coverage record (WI-37960). */
  coverage: CompletionCoverageSchema.optional(),
  filesChanged: z.array(z.string().min(1)).optional(),
  testsRun: z.string().min(1).optional(),
  testResult: z.string().min(1).optional(),
  verifiedHow: CompletionVerifiedHowSchema.optional(),
  addedTests: z
    .boolean()
    .optional()
    .describe(
      'A boolean FLAG — did this completion add or change tests? true/false, NOT a description of ' +
        'what was added (put that prose in `testsRun` / `testResult`).',
    ),
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
