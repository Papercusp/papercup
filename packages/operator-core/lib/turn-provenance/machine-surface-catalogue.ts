/**
 * machine-surface-catalogue.ts — THE curated list of un-enrollable machine
 * surfaces recorded as `user` turns, and the ONE predicate over it.
 *
 * ── Why this file exists (owner-visibility-provenance-2026-08-11 P-003) ──────
 *
 * Some machine text lands in a session's `user` rows with NO turn-origin
 * envelope and no injector that could ever mint one: the CLI itself authored it
 * (its compaction preamble, its interrupt marker, its slash-command wrappers),
 * so there is no papercusp seam to enrol. `turn-ref.ts` already recorded that
 * population as *"unenrollable — no injector"* and already carried a curated
 * catalogue for it.
 *
 * The catalogue was module-private, so the OWNER'S CHAT PANE — which faces the
 * same population — could not reach it. That filter's un-enveloped branch
 * therefore fell through to SHOW, and rendered the CLI's own plumbing as things
 * the owner had apparently said (EI-20135573616431912). The measured leak was
 * 1,051 of 1,809 shown user-turns over 7 days; 487 of those matched a pattern
 * that was sitting RIGHT HERE, uncallable. **The defect was a missing CALL, not
 * a missing pattern.**
 *
 * ⛔ So the fix is NOT a second copy of these shapes next to the pane. Four
 * private pattern lists already exist in this repo and they disagree with each
 * other; a fifth is how this bug class reproduces (plan D-004, and the
 * leak-hunt pattern in `human-turn-tail.ts`). Anything that needs to recognise
 * an un-enrolled machine surface imports FROM HERE.
 *
 * ── Zero imports, on purpose ─────────────────────────────────────────────────
 *
 * The consumers do not share a dependency floor: `turn-ref.ts` is a Node module
 * (it reads transcripts off disk via `node:fs/promises`), while
 * `agent-tools/coordination/owner-chat-turn.ts` is a deliberate import-free leaf
 * because the BROWSER-side chat pane imports it across the
 * `@papercusp/operator-core/lib/...` seam. A shared list can only live in a
 * module that is safe for both, which means this one holds pure data and pure
 * functions and imports nothing. Keep it that way — adding a Node import here
 * silently breaks the client bundle, which is the seam that forced the
 * duplication in the first place.
 *
 * ── These are HEURISTICS; the bound is what makes them safe ──────────────────
 *
 * Adopted from `memory/human-turn-tail.ts`, which learned it expensively:
 * *the filters are heuristics, the cap is arithmetic.* Every pattern here is
 * HEAD-ANCHORED and tested against a bounded head, so an owner QUOTING one of
 * these shapes mid-sentence keeps their turn. That asymmetry is deliberate and
 * is the only direction that is safe: showing one machine row too many is
 * recoverable, hiding something the human actually wrote is not.
 *
 * Add only heads a human demonstrably never types, and ENUMERATE the population
 * first (a `GROUP BY` on the head) rather than testing a guess — an earlier
 * draft of the sibling module asserted a residue was "near zero" after grepping
 * for the two shapes it already knew about, so it could only ever confirm
 * itself. There is deliberately no `^# ` rule (a human pastes markdown) and no
 * length rule (a human pastes documents).
 *
 * PURE → unit-tested.
 */

/**
 * CLI/subsystem machine surfaces recorded as user turns with NO enrollable
 * envelope (no injector wrote one, so no ledger row could ever vouch for them)
 * that the owner nonetheless never types. Empirically drawn from real psu
 * transcripts (deterministic-context-carry P-018 hardening pass): each is a
 * fixed, self-identifying marker, and biasing a marker-bearing turn toward
 * NOT-owner is the SAFE direction — a false OWNER stamp is the exact failure
 * the turn-provenance protocol exists to kill (D-002 / EI-9904 / the WI-3532
 * manufactured-directive class).
 *
 * Deliberately BROADER than the live classifier's `detectMachineSurface`
 * (turn-provenance.ts), which mirrors the bash UserPromptSubmit hook
 * byte-for-byte and (as of EI-18112745557098348) covers the SYSTEM-NOTIFICATION
 * banner AND the bare `<task-notification>` tag. The post-hoc transcript pass
 * feeds the carry-doc continuation (P-010), where those two plus a
 * `[Request interrupted by user]` marker or a self-issued `/compact` misread as
 * an "open owner message" would hand a successor a machine string as its actual
 * first prompt. Keep the SYSTEM-NOTIFICATION + task-notification +
 * compaction-continuation shapes in lockstep with turn-provenance.ts; the rest
 * are transcript-only by design.
 *
 * Tested against the turn HEAD (bounds an incidental mid-body quote from
 * tripping a marker); each pattern carries its own anchor.
 */
export const MACHINE_SURFACE_PATTERNS: readonly RegExp[] = [
  // Claude's background-task completion banner (self-labels "NOT USER INPUT").
  /\[\s*SYSTEM NOTIFICATION\b[^\]]*\bNOT USER INPUT\b[^\]]*\]/i,
  // Native auto-compaction continuation summary (unenrollable — no injector).
  /^\s*This session is being continued from a previous conversation/,
  // Task/subagent completion notification (Task-tool subsystem), e.g.
  //   <task-notification> <task-id>…</task-id> <summary>…</summary>
  /^\s*<task-notification\b/,
  // The TUI's own interrupt marker (also "…for tool use") — a system string,
  // signalling owner action but never itself an owner directive.
  /^\s*\[Request interrupted by user/i,
  // A machine-issued self-compaction command self-declares its provenance
  // (COMPACT_PROVENANCE_MARKER, request-compaction.ts) — it rides just after
  // the `/compact ` slash prefix, so this pattern is not head-anchored.
  /⟦\s*machine-issued self-compaction/i,
  // The compaction UI status line captured verbatim as a turn.
  /✻\s*Conversation compacted|●\s*Compaction is queued/i,
];

/**
 * Slash-command and local-command wrappers the CLI records as `user` turns.
 * Substring-matched rather than anchored: the CLI emits them as tag blocks that
 * can follow a leading newline or a command echo, and the tags are distinctive
 * enough that a substring hit inside a bounded head is not ambiguous.
 */
export const SYNTHETIC_MARKERS: readonly string[] = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
];

/**
 * How much of a turn the machine-surface + synthetic scans inspect.
 *
 * This is the arithmetic half of the discipline above. Wide enough to clear a
 * `/compact ` slash prefix before the machine-issued marker, bounded so a long
 * owner message cannot trip a marker on a mid-body quote.
 */
export const CLASSIFY_HEAD_CHARS = 240;

/** Does this turn's head carry a CLI/subsystem synthetic-command wrapper? */
export function hasSyntheticMarker(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, CLASSIFY_HEAD_CHARS);
  return SYNTHETIC_MARKERS.some((m) => head.includes(m));
}

/**
 * Does this turn's head match a curated un-enrollable machine surface?
 *
 * Head-bounded by construction — callers pass the whole turn and the bound is
 * applied HERE, so no caller can accidentally widen it and start matching an
 * owner's mid-body quote.
 */
export function hasMachineSurfaceMarker(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, CLASSIFY_HEAD_CHARS);
  return MACHINE_SURFACE_PATTERNS.some((re) => re.test(head));
}

/**
 * Is this turn text a known un-enrollable machine surface — either a synthetic
 * command wrapper or a curated machine marker?
 *
 * The single question every consumer actually asks. Prefer this over reaching
 * for the raw arrays: a caller that re-implements the head-bounding or the
 * or-ing is a caller that can get one of them subtly wrong, which is precisely
 * how the four divergent private copies arose.
 */
export function isUnenrolledMachineSurface(text: string): boolean {
  return hasSyntheticMarker(text) || hasMachineSurfaceMarker(text);
}
