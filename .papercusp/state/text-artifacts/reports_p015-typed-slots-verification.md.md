---
rel_path: "reports/p015-typed-slots-verification.md"
updated_at: 1784054897607
_body: "content"
---

# P-015 typed slots — live verification report (2026-07-14)

Plan: deterministic-context-carry-2026-07-14 · item P-015 · WI-4820 · staging :3170 fences 62–63.

## What shipped
1. **Owner-question typed slot** — `lintOwnerQuestionSlots` (carry-surface-typed-slots.ts), wired through
   `carryProvenanceFields` onto all four carry surfaces (facts:assert, loop:checkpoint,
   work_items:checkpoint, session:request-compaction). Owner-blocking-question prose flags
   `typedSlotLint`; a `[ask:<conversation_id>]` ref (a coord:ask-owner record) or an OWNER-WALL marker
   clears the line.
2. **Dead-end fact slot** — `facts:assert { slot: 'dead-end' }` normalizes the key under `dead-end:` and
   the body under the `⛔ DEAD END — do not retry:` marker (idempotent; no schema change; folds render it
   with zero renderer changes).
3. **Turn-end auto-checkpoint** — journal:record-turn mechanically checkpoints the holder's stale held
   work-items (missing checkpoint or >45 min old) from the turn's journal note + the P-013 tool-call-log
   tail; `⟦auto-checkpoint mechanical⟧`-marked, agent prose preserved, previous mechanical block replaced.
4. **Unregistered-artifact detection** — scratch-path deliverable writes with no artifacts:save
   registration in the turn window record a journal tripwire (kind `unregistered-artifact`).
5. **Intent-pivot nudge** — coord:declare-intent compares the new intent against the previous one
   (embedding cosine when the embedder answers in budget, lexical Jaccard fallback; D-006
   extractive-only) and, on a sharp pivot, returns a `pivotHint` naming the dead-end slot.

## Live verification (staging :3170)
- Fence 62: typedSlotLint fired with the exact offending line; `[ask:…]` cleared; dead-end key/body
  normalized live; pivotHint returned in EMBEDDING space (cosine 0.32 on orthogonal intents, none on
  same-lane progression); WI-4821 (checkpoint-less probe) received the full mechanical checkpoint with a
  real P-013 tool-log tail; fresh-checkpoint items correctly skipped.
- Fence 63: after fixing the live-caught defect (harness_text_artifacts.updated_at is BIGINT epoch-ms —
  the timestamptz cast threw inside the fail-soft sweep, reading as clean), the unregistered-artifact
  tripwire fired with exactly the probe file and the register nudge, stored on the journal row.
- 202 unit tests green across 14 suites; tsc clean on every touched file.

