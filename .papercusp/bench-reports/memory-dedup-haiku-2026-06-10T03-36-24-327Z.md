# mem0 near-dup re-run under Haiku — 2026-06-10T03:36:24.327Z

Re-runs the write-round-trip/near-dup tier (same specs + methodology as the
memory-backend benchmark) with the SESSION-backed extractor
(`claude-haiku-4-5` on anthropic-direct), per
mem0-extraction-via-claude-session-2026-06-06 P-008.

| | extractor | near-dup behavior |
| --- | --- | --- |
| baseline (memory-bench-2026-06-05T14-40-41-392Z) | gpt-4o-mini (key-rung fallback — stale Anthropic key) | **0/6 merged** |
| this run | claude-session rung, claude-haiku-4-5 | **5/6 merged** |

## Per-spec

| spec | stored | near-dup new entries | behavior |
| --- | --- | --- | --- |
| rt-deploy-window | yes | 0 | merged |
| rt-flaky-socket | yes | 0 | merged |
| rt-quota-header | yes | 0 | merged |
| rt-tz-cron | yes | 0 | merged |
| rt-cache-bust | yes | 0 | merged |
| rt-perm-model | yes | 1 | appended |

## Session-rung proof
12 extraction calls, 4353 tokens on the session rung's own counters (authRetries=0, jsonRepairs=0, failures=1). A zero delta would have invalidated the run (exit 1).

## Reading it
"merged" = the near-dup write produced 0 new entries (the extractor chose
UPDATE/NONE over ADD). Observational per bench D-006 — no recommendation here;
this updates the facts under the owner's revive-vs-retire call.
