---
rel_path: "audits/p008-native-summary-baseline-2026-07-14.md"
updated_at: 1784048770849
_body: "content"
---

# P-008 stage-0 audit — native compaction summaries vs the verbatim record
Plan `deterministic-context-carry-2026-07-14` P-008 · WI-4803 · run 2026-07-14 by su-d1425 (AUTO mandate). Baseline for the P-019 miss-rate gate.

## Corpus
- **Gradeable (on-disk, full raw JSONL with flags):** 214 native summaries across 8 Claude Code sessions / 7 owners under `~/.papercusp/session-claude/<owner>/projects/*/<sid>.jsonl` (`isCompactSummary:true` rows; every one also carries a `compact_boundary` marker). Largest chains: su-b0fbf 119 summaries (one 172MB session), su-d1425 30, su-a1a71 26+7.
- **All-time (PG `session_turns` index, incl. archived):** 2,955 native summaries across 666 claude sessions.
- **omp message trees: VACUOUS LEG.** 57 omp sessions / 425 turns indexed; 0 native compaction summaries (omp sessions in this corpus never natively compacted). The Claude JSONL corpus is the entire gradeable population.

## Method
Extraction+screening script: scratchpad `p008_extract.py` → `p008/summaries.jsonl` (per-summary: owner-tag claims w/ verbatim-overlap vs real owner turns, owner-phrase claims, directive-turn windows, self-imposed contexts) + `p008/escalations.json`. Owner-turn classifier excludes tool_results, isMeta, command wrappers, `<task-notification>`/`<system-reminder>`, ⟦provenance-glyph⟧ rows, `[await-event]` wake text, and interrupts; AskUserQuestion answers counted as owner-signal separately (they are `type:user` tool_results, NOT `speaker:user` turns — the known false-positive channel, memory 767e21c0). Every automated flag was manually adjudicated; the screens are TRIAGE-ONLY (tag-flag precision ≈ 15%) — ground truth is transcript-anchored verification (`sessions:search mode:verbatim`).

## Baseline numbers (the P-019 gate inputs)
1. **Dropped-directive rate: 0 observed / 332** genuine owner directive-ish turns inside summary windows (token-overlap screen found 0 at <0.2; manual inspection of the 10 lowest-overlap cases found 0 semantic drops — all were residual machine-text misclassification or context dilution). Upper bound ≈ 1%.
2. **Owner-attribution volume:** 484 `[owner:…]` tags + 95 owner-phrase claims in 214 summaries. 85 tags (17.6%) failed the local verbatim screen; adjudicated buckets: 23 correction-banner text quoting a KNOWN fabrication, 6 meta-convention mentions, 21 cross-session inherited (locally unverifiable BY CONSTRUCTION), 35 with inline verification metadata whose overlap score was diluted (not fabrications).
3. **Confirmed fabrication incidents: 1 in-corpus** (+ WI-3532's prior documented incident, pre-corpus). The su-a1a71 chain: a native summary manufactured an `[owner:Avi 2026-07-14]` "get our next release out" GO; a successor verified 0 transcript hits, corrected it across 6+ subsequent summaries and a `facts:assert` (`no-verified-july14-release-go`). Fabrication rate ≈ 1 / ~2,955 summaries visible, but detection depended on an agent choosing to re-verify.
4. **Second-order rot specimen (NEW):** the "anti-bandaid principle" quote attributed `[owner:Avi 2026-07-11]` ("make sure it's right the first time so it doesn't need to be re-verified", su-699dc L3266) has exactly ONE speaker:user occurrence in the ENTIRE indexed corpus — itself a summary-carried continuation turn. Its local carriers are memory/hook attachments + an assistant turn saying "your anti-bandaid principle". Verdict: unverifiable-inherited → per protocol must degrade to `[inferred]`. Not provably fabricated (pre-indexing sessions could hold it) — which is precisely the problem.
5. **Self-imposed→owner escalation: 0 confirmed** in the on-disk corpus (201 raw shingle candidates → 39 unique → all adjudicated false positives: they match the anti-rot hygiene text itself — correction banners, "Do NOT treat as owner requests" disclaimers, verbatim-quoted genuine turns).
6. **Convention adoption (all-time):** `[owner:]` tagging in 18% (532/2955) of summaries; re-orient banner in 49% (1,440). Both conventions post-date most of the corpus; recent sessions show near-universal adoption plus ACTIVE defense (provenance-correction banners carried forward for 6+ compactions).

## Taxonomy conclusion → what P-019's gate must catch
The dominant residual channel is **cross-session inheritance**: an `[owner:]` claim whose source turn lives outside the current transcript can never be locally verified and carries at face value forever (21/214 summaries ride it; both the fabrication incident and the anti-bandaid specimen live there). Intra-window drops and self→owner escalation are, in this post-provenance-protocol corpus, effectively zero. The P-019 miss-rate gate should therefore require every `[owner:]` claim to carry a transcript anchor (sessionId + turn pointer, or a `sessions:search`-verifiable verbatim quote) and **auto-degrade to `[inferred]` after N unverified inheritance hops** — not re-litigate intra-window fidelity, which the current conventions already hold at ~0.

## Reproduce
`python3 <scratchpad>/p008_extract.py` (self-contained, stdlib only; rewrite path if scratchpad GC'd — script logic documented above). Corpus queries: `session_turns` counts in WI-4803's completion record.

