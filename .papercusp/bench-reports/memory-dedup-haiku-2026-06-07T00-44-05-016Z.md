# mem0 near-dup re-run under Haiku — 2026-06-07T00:44:05.016Z

Re-runs the write-round-trip/near-dup tier (same specs + methodology as the
memory-backend benchmark) with the SESSION-backed extractor
(`claude-haiku-4-5` on anthropic-direct), per
mem0-extraction-via-claude-session-2026-06-06 P-008.

| | extractor | near-dup behavior |
| --- | --- | --- |
| baseline (memory-bench-2026-06-05T14-40-41-392Z) | gpt-4o-mini (key-rung fallback — stale Anthropic key) | **0/6 merged** |
| this run | claude-session rung, claude-haiku-4-5 | **4/6 merged** |

## Per-spec

| spec | stored | near-dup new entries | behavior |
| --- | --- | --- | --- |
| rt-deploy-window | yes | 0 | merged |
| rt-flaky-socket | yes | 0 | merged |
| rt-quota-header | yes | 0 | merged |
| rt-tz-cron | yes | 4 | appended |
| rt-cache-bust | yes | 0 | merged |
| rt-perm-model | yes | 6 | appended |

## Session-rung proof
12 extraction calls, 5165 tokens on the session rung's own counters (authRetries=0, jsonRepairs=0, failures=0). A zero delta would have invalidated the run (exit 1).

## Reading it
"merged" = the near-dup write produced 0 new entries (the extractor chose
UPDATE/NONE over ADD). Observational per bench D-006 — no recommendation here;
this updates the facts under the owner's revive-vs-retire call.

## Nuance on the two "appended" specs
The tier's methodology UPDATEs the stored fact (step 3) before the near-dup
write (step 4), so by the time the "near-dup" lands it partially CONTRADICTS
the stored fact on most specs (time/threshold/behavior details changed by the
update). Haiku still merged 4 of those (including contradiction-bearing ones
like rt-deploy-window and rt-cache-bust) and appended on 2 (rt-tz-cron:
11:30 vs 12:30 UTC; rt-perm-model: "pages on-call" vs "no paging" — both
defensible ADDs of divergent facts). So read 4/6 as indicative of real
dedup ability under contradiction pressure, not an exact ceiling.
gpt-4o-mini merged 0/6 under the identical protocol.
