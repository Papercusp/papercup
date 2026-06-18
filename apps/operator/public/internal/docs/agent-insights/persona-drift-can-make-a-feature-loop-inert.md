# A persona that names a non-existent tool/field can leave a whole feature loop silently INERT
URL: /internal/docs/agent-insights/persona-drift-can-make-a-feature-loop-inert

The bee carry-note checkpoint loop (bee-context-efficiency P-010/P-011/P-012) had a PG store + a re-inject seam but NO write path: bee.md told bees to write the carry-note via `work_items:complete.coordNotes` / `coord:declare-intent.carry_note` — fields that do not exist — and to read it from a `## Checkpoint` section the seam never emits. So nothing was ever written; the store + re-inject sat dead. The fix was a real `work_items:checkpoint` tool + correcting the persona to the actual tool + the real `### Carry-note` location. Lesson: a prompt/persona is intent-at-write-time and drifts from the tool surface; before trusting "the bee writes X via Y", grep that Y exists in code and actually calls the store.

A feature can be **fully built on the storage + read side and still do nothing**
because the *write* side was only ever described in a prompt, never wired.

## The concrete case

`bee-context-efficiency-2026-06-14` Phase 3 built the bee carry-note checkpoint:

* **P-010** — `work-item-checkpoint.ts` (PG store, `setWorkItemCheckpoint` /
  `getWorkItemCheckpoint`, migration 281). ✅ real, tested.
* **P-011** — re-inject: `assembleSpawnHydration` calls `getWorkItemCheckpoint`
  and renders it as `### Carry-note (your last checkpoint)`. ✅ real, wired.
* **P-012** — teach `bee.md` to *write* the checkpoint. The persona said the
  carry-note "rides `work_items:complete` (the `coordNotes` field) or
  `coord:declare-intent` (the `carry_note` field)" and is re-injected in a
  "`## Checkpoint` section."

Every one of those persona claims was **false against live code**:

* `grep coordNotes / carry_note` in `complete.ts` / `declare-intent.ts` → **no
  such fields**. Nothing in `agent-tools/` called `setWorkItemCheckpoint` at all.
* The re-inject heading is `### Carry-note (your last checkpoint)` inside the
  `## Handoff` block — there is no `## Checkpoint` section.

Net: **no bee could ever write a checkpoint.** The store + re-inject were a
loaded gun with no trigger — P-010/P-011 looked "done," but the loop was inert.

## Why it's easy to miss

The plan items read green ("store ✅", "re-inject ✅", "bee.md taught ✅"), the
PG table exists, the seam renders it — every part *except the write path* is
real, and the persona *describes* a write path confidently. Reading the plan or
the persona, you'd conclude it works. Only grepping for the actual write call
(`setWorkItemCheckpoint` callers) reveals the gap.

## The rule

A prompt/persona is **intent at write-time** — it drifts from the tool surface
exactly like a stale code comment (see *trust live code, not comments*). Before
you trust "the agent does X by calling Y":

1. **Grep that Y exists** as a real tool/field and that it **calls the store /
   does the thing** — don't trust the persona's nouns.
2. **Trace the full loop write → store → read → inject** in code. A feature is
   only live when every leg is wired; a described-but-unbuilt leg is a silent
   hole.
3. When you add the missing leg, **fix the persona in the same change** to name
   the real tool + the real inject location, so the next agent isn't re-misled.

The fix here: a real `work_items:checkpoint` tool (`setWorkItemCheckpoint`,
COORD\_ROLES incl. bee) + `bee.md` corrected to point at it and the real
`### Carry-note (your last checkpoint)` location.
