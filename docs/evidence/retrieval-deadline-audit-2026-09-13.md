# Retrieval deadline-chain audit

Date: 2026-09-13. Plan: `retrieval-soft-budget-hard-deadline-2026-09-13`.
Preparation item: WI-10001232 / P-001. Author: su-8ee55568-a37b-4b6b-84f3-e02e11c10d86.

This is pre-implementation evidence, not a claim that the new policy has shipped.

## Approved outcome

Avi approved AUTO, self execution through shipped status in
`session_turn:codex:01a09697-7bd2-78f1-9e1b-f8592b50a23c:51`.
The same session's turns 44, 46, and 47 specify:

- Keep 1,200 ms as a performance target; a reasonable slow success should reach the agent with a warning.
- Use one 10,000 ms end-to-end hard deadline, not a renewed allowance for each stage.
- Preserve completed safe results when unfinished work times out.
- Investigate and correct the cause of target breaches separately from tolerating them.
- Return to the GitNexus recommendation only after the retrieval work is verified.

Activation audit 1 resolved 16 source references across this conversation and the
two historical technology-choice conversations. The spec-quality evaluation
passed; its emitted card was awaiting mandatory non-author grading-integrity
review at the time of this document.

## Current deadline chain

These are source observations from the canonical staging checkout, not proof of
the deployed code on every endpoint.

| Boundary | Current behavior | Source |
| --- | --- | --- |
| Shared client injection port | Turn-start 2,500 ms; mid-turn 1,500 ms hard HTTP/body timeout | `apps/operator/scripts/hooks/inject/ports.mjs`, `core.mjs:postInjection` |
| OMP subprocess wrapper | Duplicates those port budgets and adds 1,200 ms before terminating the dispatcher | `apps/operator/scripts/hooks/omp/inject-hook.ts` |
| Turn-start rendered-block cache | Cold wait 2,000 ms; stale block can return while a new query revalidates in the background | `packages/operator-core/lib/memory/injection-block-cache.ts` |
| Automatic memory backend operations | Separate 5,000 ms operation deadlines and a process-wide degraded cooldown | `packages/operator-core/lib/memory/injection.ts`, `op-deadline.ts` |
| Corpus retrieval | Whole-operation 2,000 ms race, whose timeout discards the whole result | `packages/operator-core/lib/memory/corpus-recall-io.ts:recallCorpusContext` |
| Query embedding | 1,200 ms hard budget, then semantic work is omitted | `corpus-recall-io.ts:corpusEmbedBudgetMs`, `libs/generic/search/src/hybrid.ts:embedWithBudget` |
| Optional corpus reranking | Separate 1,500 ms bound | `corpus-recall-io.ts:corpusRerankTimeoutMs` |

Changing only the embedding number cannot deliver the approved outcome: both
client ports and enclosing server waits can discard a valid later response.
Unrelated interactive search callers must retain their existing contract unless
explicitly migrated.

## Cancellation and partial-result findings

1. Generic hybrid search starts lexical retrieval and query embedding together.
   It then awaits lexical batches, semantic retrieval and final fusion.
   Its result is not exposed incrementally today.
2. Caller cancellation currently rejects the search and is intentionally distinct
   from graceful degradation. Preserve that distinction when introducing a
   partial hard-deadline result.
3. `embedWithBudget` supplies an abort signal to transport-aware embedders.
   The corpus wrapper currently uses a one-argument closure around its warm
   embedder; the closure does not forward that signal or function metadata.
   This must be examined when wiring cancellation and vector provenance.
4. The corpus whole-operation race swallows the losing promise. It does not
   itself cancel that work or return already-completed candidates.
5. The corpus has an additive second query: retained first-stage results must not
   disappear if widening or reranking times out.
6. Partial output still requires the normal workspace/harness, self-session,
   exclusion, relevance, deduplication and output-budget checks. A timeout is not
   authorization to expose an unfiltered candidate list.
7. The rendered-block cache is conversation-scoped but query-dependent.
   Verify that current-query late context is delivered under the new policy;
   merely receiving a cached previous query's context does not satisfy it.
8. Shared work must retain consumer ownership: aborting one coalesced consumer
   must not kill another consumer's useful request.

## Performance evidence and its limits

On September 13, one production worker reported 250 mid-turn embeddings with
57 timeouts, a 1,200 ms budget and 3 ms median. This is one process-local ring
from a 16-worker operator, not a fleet census. It demonstrates a surviving tail,
not a universally slow or cold service.

Three uncached query probes returned 1,948, 235 and 810 ms; per-response
accounting confirmed one inference and zero cache hits for each.
The first observed a saturated queue before dispatch. Different input strings
mean this is not a causal queue-versus-inference comparison.

Both inspected production units routed to the shared sidecar on port 3384.
The sidecar reported warm models, live worker threads and CPU execution.
CPU-only metadata does not isolate the slow stage or prove that enabling a GPU
would fix these specific requests.

Coverage samples from 20:52:45 to 22:22:26 UTC showed 3,592 additional eligible
session turns but only 512 additional current embeddings. Recent sweeps
embedded 64 turns and 64 chunks before exhausting the 200-second sweep budget.
The indexing process is running but is not keeping up in this window.
Coverage alarms did report this backlog growth. This is a separate freshness
problem, not proof that the particular historical decision was unindexed.

The inspected original GitNexus and Serena-choice turns have Gemma parent
vectors. The automatic excerpt search explicitly includes `session_turn` and
`work_item`, not plan decisions. A pointer to the prior GitNexus recommendation
was nevertheless injected and the agent did not follow it before recommending
alternatives. Keep retrieval policy and agent utilization failures distinct.

## Implementation and acceptance obligations

Extend the existing search and injection seams, rather than introducing a
parallel retrieval engine. Propagate one absolute deadline and caller
cancellation through the scoped request. Keep the soft performance target in
the existing latency/watchdog accounting. Preserve safe completed snapshots
when remaining work reaches the hard deadline.

The implementation test population includes:

- Valid semantic results at 1,500, 3,000 and 9,000 ms.
- Hung semantic work at 10,000 ms with completed lexical results retained.
- One hung source while another source completed.
- Deadline during second-stage widening or optional reranking.
- Sequential and parallel stages sharing remaining time rather than renewing it.
- Explicit caller cancellation and no subsequent late delivery.
- Shared/coalesced work with one cancelled and one continuing consumer.
- Slow-success warnings distinct from genuine errors and hard timeouts.
- Scope/exclusion/relevance checks on partial output.
- Turn-start and mid-turn endpoint/client delivery, including OMP parity.
- Preservation of existing behavior for non-migrated search callers.

Use deterministic clocks for boundary tests. Live measurements must separately
report acquisition, admission/queue, inference, SQL/highlight and rerank time,
cache behavior, request size, concurrency, process identity and build.

## Historical recommendation authority

The original comparison is
`codex:01a01fbc-6171-7d02-b205-8a3faeb65a8f`, turns 4–6.
The explicit Serena rejection is
`claude:5ba8194a-9964-42d5-ade2-7699a0120deb`, turns 32–34.
The latter occurred August 20 evening in New York; its plan decision is dated
August 21 UTC.

`code-intelligence-routing-lsp-gitnexus-2026-08-20` decisions D-001 and D-002
remain the baseline: GitNexus for topology, official shared language servers
behind a thin Papercusp adapter for compiler truth, and exact text search for
working-tree evidence. The eventual reassessment must compare changed premises,
not repeat a generic vendor feature table.
