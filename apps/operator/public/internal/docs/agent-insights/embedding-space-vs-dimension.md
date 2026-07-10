# Vectors have a SPACE, not just a dimension — switching the embedder silently invalidates every stored vector
URL: /internal/docs/agent-insights/embedding-space-vs-dimension

EMBEDDER_DIM===384 is asserted everywhere; the embedding SPACE was asserted nowhere. Flipping memoryEmbedderMode makes stored vectors (OpenAI-384) and query vectors (BGE-384) structurally valid and semantically incomparable — no error, just noise. Migration 530's `<col>_mode` discriminator + a space-aware backfill predicate make the sweep self-healing.


## The trap

`memoryEmbedderMode` (`auto | openai | local | disabled`) picks the embedder **at
runtime**. Both available embedders produce **384-dimensional** vectors:

| mode | model | dims |
| --- | --- | --- |
| `openai` | `text-embedding-3-small`, requested with `dimensions: 384` | 384 |
| `local` | `Xenova/bge-small-en-v1.5` (BGE-ONNX) | 384 |

Every layer checks `vec.length !== EMBEDDER_DIM`. **No layer checked which model
produced the vector.** OpenAI-384 and BGE-384 are different vector spaces: cosine
similarity between them is meaningless. So flipping the pref leaves every
previously-stored vector structurally valid, non-null, correctly sized — and
semantically incomparable with the query vector, which the *same pref* also selects.

Nothing throws. Search returns confident, plausible-looking noise.

**Measured 2026-07-09**, right after switching to `local`: searching
`harness_shared.operator_turns` for a row **by its own exact text** ranked that row
**#6574 of 8383** (cosine distance `1.0336` — near-orthogonal to itself). After the
fix, the same probe returns distance `0.0000`.

## Why it could never self-heal

`embed-backfill.ts` resumed on `WHERE embedding IS NULL`. That predicate encodes the
assumption *"a vector, once written, is valid forever"* — false the moment the embedder
is a runtime choice. Foreign-space rows were never revisited, so a column that started
mixing could never converge. Caught mid-drift: **4 of 40** sampled `operator_turns` rows
were already BGE while 36 were still OpenAI, and the ratio climbed every 5-minute sweep.

## Who was affected

**Five** prose surfaces, all fed by `embed-backfill.ts`, each with one embedding column
and no discriminator:

- `harness_shared.operator_turns.text_embedding`
- `harness_shared.harness_escalations.body_embedding`
- `harness_shared.harness_brainstorm.content_embedding`
- `harness_shared.harness_decisions.body_embedding`
- `harness_shared.session_turns.text_embedding`

Downstream consumers of `buildQueryEmbedder()` — `coord:ask`'s knowledge tier,
`recipes/candidates.ts`, `cupboard/tool-find.ts`, `sessions:search` semantic mode.

**mem0's memories were immune.** They already store vectors in **per-mode tables**
(`memory_vec_openai` / `memory_vec_local`) over one mode-independent
`memory_canonical`. The prose surfaces simply never inherited that discipline. Switching
mem0 modes is therefore non-destructive and reversible — but still needs a **re-embed**,
because the target table only holds vectors written in *its* space.

## The fix (WI-3616)

1. **Migration `530-embedding-space-discriminator.sql`** — adds `<embedCol>_mode text`
   plus a partial index to all five tables. `NULL` = unknown space = stale.
2. **Space-aware predicate** in `embed-backfill.ts`:

   ```sql
   WHERE embedding IS NULL OR embedding_mode IS DISTINCT FROM $activeMode
   ```

   Use `IS DISTINCT FROM`, never `<>`: `NULL <> 'local'` evaluates to `NULL`, matches
   nothing, and silently reintroduces the original bug for every pre-migration row.
3. The `UPDATE` writes **vector and mode together**, so a row can never advertise a
   space it is not in. The sweep now converges a switched column back onto one space
   and then goes quiet.

### Postgres gotcha this nearly shipped with

Postgres derives a statement's parameter count from the **highest `$n` referenced** and
rejects a Bind that supplies a parameter the statement never uses:

```
could not determine data type of parameter $2
```

So the legacy (pre-530) path must **omit** the `mode` parameter entirely and shift its
PK placeholders from `$3` back to `$2` — not merely ignore it. Pinned by a test.

## If you switch the embedder

1. **Re-embed first, flip second.** Flipping first drops recall to whatever fraction
   already exists in the target space (it was 743/8746 ≈ 8.5% here) for the whole
   transfer window. Re-embedding first has **zero** recall gap: the old space keeps
   serving until the moment you flip.
2. mem0 memories: `reembedMemories(from, to)` (`POST /api/user/memory/reembed`).
   Idempotent (`ON CONFLICT … DO UPDATE`) and needs **no OpenAI key** — the source
   vectors are only a JOIN filter. Run it **out-of-band**: it is a serial loop and the
   HTTP route caps at `timeoutSec: 600`. Measured ~50–70 rows/s.
3. Prose columns: the space-aware sweep now heals them automatically, but it is capped
   at `BATCH_SIZE * 4` rows per table per 5-minute tick — force an immediate pass if you
   need search correct *now*. 28,231 rows took ~32 min on a loaded box.

## Verifying a space, cheaply

Re-embed a row's own stored text and compare to its stored vector:

- distance `≈ 0.0000` → that row is in the active space.
- distance `≈ 1.0` → foreign space (near-orthogonal). Search over it is noise.

Beware ties: identical texts (e.g. repeated fleet-update messages) share an identical
vector, so a self-lookup can legitimately rank #3 at distance `0.0000`. Assert on the
**distance**, not the rank.

## The detector that was missing

This bug was invisible for exactly as long as it existed — no log line, no exception, no
metric. Three call sites (`memory/configure.ts`, `agent-tools/search/embedder.ts`,
`search/embed-backfill.ts`) each independently re-derive the mode from the same pref
with subtly different cascades (embed-backfill's ignores the OpenAI-exhaustion cooldown
entirely). Any one drifting re-desynchronizes stored from query vectors. Tracked as
**EI-8913**: collapse them onto one resolver, and add a periodic self-check that embeds
a known row's own text and asserts it retrieves itself at distance ~0.
