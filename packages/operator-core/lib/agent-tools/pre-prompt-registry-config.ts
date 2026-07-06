/**
 * The curated pre-prompt registry list (plan `token-efficient-agent-io-2026-06-06`,
 * P-002 / D-008). This is the HOST configuration of the domain-free registry in
 * `@papercusp/result-encoding` — the one governed place that decides which tools
 * get prompt-declared column schemas (and thus the Tier-3 read / positional write
 * paths). Imported as a side-effect at startup (see agent-tools/index.ts).
 *
 * Telemetry basis (D-008 — derived, not hand-guessed). From
 * `harness_shared.tool_invocations` over the trailing 21 days (~268k calls), the
 * hot tools by call count are:
 *
 *   coord:inbox 80.8k · activity:recent 50k · activity:report 28.7k ·
 *   plans:list 26k · locks:acquire/release/queue ~13-15k each ·
 *   plans:attention 9.6k · plans:get/items ~2.2k · plans:set-status 1.5k ·
 *   coord:declare-intent 1k · coord:send 0.9k · coord:presence 0.38k ·
 *   harness:list 0.32k
 *
 * The breakeven gate (a tool earns its prompt space when called > ~1×/session)
 * is comfortably cleared by every tool above. BUT Tier-3 read only activates when
 * a tool's `data` is a flat scalar array (columns derivable) AND positional write
 * only when the args fit the bounded shape (scalars/enums/ids + ≤1 trailing
 * free-text, no arrays). Most hot reads don't qualify *yet*:
 *
 *   - coord:inbox / coord:presence / locks:queue — `data` is a nested object
 *     ({summary, entries[]} / {active, stale} / {active_locks, waiting}), not a
 *     flat array. (coord injection has its own push-side plan,
 *     `token-efficient-coord-injection`.)
 *   - plans:list / plans:items — array rows carry a nested field (itemCounts /
 *     the ResolvedItem object), so not CSV-flat.
 *   - activity:recent — flat-ish but carries a `detail: unknown` column; the
 *     runtime flatness check downgrades to TOON whenever detail is an object.
 *   - locks:acquire / coord:send / coord:declare-intent — write args carry
 *     ARRAYS (paths/to/current_files) → not positional-shaped.
 *   - plans:set-status — has a non-last free-text column (`note` before
 *     `rationale`) → correctly rejected by the positional projection.
 *
 * So v1 activates the clean, correct cases and lists them here; the larger-win
 * tools activate as their output `data` is flattened / restructured (tracked by
 * the sibling read plans). Note the read side is already compact (the
 * tool-result-formats plan defaults every tool to TOON); Tier-3 CSV is an
 * incremental read win, while the positional WRITE path is the larger one
 * (output tokens cost ~4-5× input).
 */

import { configurePrePromptRegistry, type ColumnOverride, type PrePromptEntry } from '@papercusp/result-encoding';
import { ISSUE_FAMILY_STATES, ISSUE_STATE_ALIASES, WORK_ITEM_ID_PATTERN } from '../work-items';
import { FEATURE_FAMILY_STATES, FEATURE_STATE_ALIASES } from '../work-item-dispatch-states';

/**
 * EI-7927 (D-007 residual): the misalignment guard's per-column checks (id
 * pattern / enum membership) only fire when the tool's OWN Zod schema carries
 * them — but `id` and `state` on these two tools are both loose strings (id
 * accepts several id-family prefixes; state accepts every cross-family alias),
 * so the schema alone can't express the constraint. `columnOverrides` supplies
 * it out of band. The `state` vocabulary is the UNION of every dialect + alias
 * the real `normalizeWorkItemState`/`normalizeFeatureStateInput` accept —
 * derived from the same exported constants those functions use (never
 * hand-duplicated), so this can't silently drift out of sync with a future
 * added state/alias.
 */
const WORK_ITEM_ID_OVERRIDE: ColumnOverride = { pattern: WORK_ITEM_ID_PATTERN };
const KNOWN_WORK_ITEM_STATE_TOKENS: readonly string[] = Array.from(
  new Set([
    ...ISSUE_FAMILY_STATES,
    ...FEATURE_FAMILY_STATES,
    ...Object.keys(ISSUE_STATE_ALIASES),
    ...Object.keys(FEATURE_STATE_ALIASES),
  ]),
);
const WORK_ITEM_STATE_OVERRIDE: ColumnOverride = { enumValues: KNOWN_WORK_ITEM_STATE_TOKENS };

export const PRE_PROMPT_REGISTRY: PrePromptEntry[] = [
  // ── Read (Tier-3 headerless CSV) ──────────────────────────────────────────
  // audit:list — summary mode returns exactly {id,ts,actor,action,subject}
  // (declared, flat); `detail:'full'` adds a nested field → runtime flatness
  // check downgrades it to TOON. Clean + lossless both ways.
  { name: 'audit:list', read: 'csv', note: 'flat audit rows; ~hot on investigation' },

  // ── Write (positional-CSV args) — LIVE since 2026-07-06 (the P-013 gate PASSED) ──
  // Both are all-scalar, arrayless, free-text-free positional fits. The P-013
  // emit-correctness gate passed on a non-contended live run 2026-07-06
  // (definetool-token-reduction-uncovered-surfaces-2026-07-06 P-001/P-002):
  // su-S07 verdict=pass with a DISTINCT judge (claude-opus-4-6 vs SUT
  // sonnet-4-6 per Plan §6.3 — the earlier red verdict was SUT==judge
  // self-grade bias on orthogonal behavioral dims); the load-bearing positional
  // assert (row === "WI-42,passed") passed 6/6 across both runs; su-S08
  // compact-read passed 3/3.
  //
  // D-007 residual CLOSED (EI-7927, 2026-07-06): the guard was arity-only — id/
  // state carry no schema-level pattern/enum (id spans several id-family
  // prefixes; state spans every cross-family alias) — so a swapped row with
  // matching arity could still write wrong-but-valid data. `columnOverrides`
  // below closes that gap without touching either tool's real args schema
  // (which stays a loose string for legitimate cross-family use).
  //
  // Separately found while verifying this (do NOT attempt inside EI-7927):
  // as of the 2026-06-21 bulk-endpoint-standardization refactor, both tools'
  // real args schema carries bulk fields (ids/items/decision) alongside the
  // single-item shape, and projectWriteColumns rejects the WHOLE schema the
  // moment ANY property is an array/nested-object — so it returns undefined
  // for both today, advertisedArgsSchema falls back to full keyed args (which
  // is what keeps bulk ids[]/items[] callable), and positional-row is in
  // practice not exercised in production despite this entry's write:
  // 'positional' (confirmed by feeding the real Zod-derived JSON Schema
  // through projectWriteColumns directly). A real fix needs a UNION schema
  // (row-string OR full keyed args); filed as WI-3258. The columnOverrides
  // hardening below is unit-tested directly and activates the moment WI-3258
  // (or any narrower future schema) makes either tool columns-eligible again.
  {
    name: 'work_items:set_state',
    read: 'off',
    write: 'positional',
    note: 'positional live 2026-07-06 — S07 gate passed (cols id,state,harness?); columnOverrides hardened EI-7927; see WI-3258 for the bulk-schema eligibility gap',
    columnOverrides: { id: WORK_ITEM_ID_OVERRIDE, state: WORK_ITEM_STATE_OVERRIDE },
  },
  {
    name: 'work_items:claim',
    read: 'off',
    write: 'positional',
    note: 'positional live 2026-07-06 — S07 gate passed (cols id,assignee?,harness?); columnOverrides hardened EI-7927; see WI-3258 for the bulk-schema eligibility gap',
    columnOverrides: { id: WORK_ITEM_ID_OVERRIDE },
  },
];

configurePrePromptRegistry(PRE_PROMPT_REGISTRY);
