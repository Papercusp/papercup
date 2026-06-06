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

import { configurePrePromptRegistry, type PrePromptEntry } from '@papercusp/result-encoding';

export const PRE_PROMPT_REGISTRY: PrePromptEntry[] = [
  // ── Read (Tier-3 headerless CSV) ──────────────────────────────────────────
  // audit:list — summary mode returns exactly {id,ts,actor,action,subject}
  // (declared, flat); `detail:'full'` adds a nested field → runtime flatness
  // check downgrades it to TOON. Clean + lossless both ways.
  { name: 'audit:list', read: 'csv', note: 'flat audit rows; ~hot on investigation' },

  // ── Write (positional-CSV args) — candidates, GATED OFF pending P-013 ──────
  // Both are all-scalar, arrayless, free-text-free positional fits. They are NOT
  // yet flipped to `write:'positional'` on the live fleet: their misalignment
  // guard is ARITY-ONLY (neither `state` nor the ids carry an enum/regex the
  // guard can sanity-check), so a swapped row could write wrong-but-valid data
  // (D-007). The plan gates this on the P-013 LLM-scenario emit-correctness
  // measurement (P-016) — flip `write` to `'positional'` here once it passes on
  // a non-contended run. The mechanism + guard + scenarios are built and tested
  // (positional-integration.test.ts, su S07/S08); only the live default waits.
  { name: 'work_items:set_state', read: 'off', write: 'off', note: '→positional after P-013 (cols id,state,harness?)' },
  { name: 'work_items:claim', read: 'off', write: 'off', note: '→positional after P-013 (cols id,assignee?,harness?)' },
];

configurePrePromptRegistry(PRE_PROMPT_REGISTRY);
