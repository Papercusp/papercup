<!--
Operator converse-brain overlay for the compaction instructions. Spliced into
papercusp-compaction.base.md at PAPERCUSP-COMPACTION:CLIENT-OVERLAY, then consumed
by buildCompactionPrompt (operator-conversation-compaction.ts) as the static
instruction block; the dynamic EXISTING SUMMARY / NEW TURNS / char cap are
interpolated by that code at runtime. Canonical — do not hand-edit the projected
output. Plan: agent-managed-compaction-2026-07-01.
-->

## Incremental fold (operator converse brain)
This summarizer folds only the turns that just aged out of the verbatim window.
Merge the EXISTING SUMMARY (older context) with the NEW TURNS into ONE updated
summary, applying the priorities above. Output plain text with short bullets, no
preamble and no headings — the summary only.
