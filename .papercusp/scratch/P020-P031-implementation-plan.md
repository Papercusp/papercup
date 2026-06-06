# P-020/P-021/P-022 + P-030/P-031 Implementation Plan

## Current Status (2026-06-06)

### What's Complete
- **P-022 (recallAlreadyDecided)**: ✅ Infrastructure exists in `digest.ts`
  - `recallAlreadyDecided()` function computes signature-matched recalls
  - Integrated into `capture-core.ts` - returns `alreadyDecided[]` in result
  - Surfaced to capture tool users for feedback
  
- **Digest scoring**: ✅ Built
  - `buildDigest()` produces scored items with `autoEligible` and `humanQueue` lanes
  - `signatureRecurrence()` computes recurrence-decay data structures
  - `findLikelyDuplicates()` detects near-duplicate clusters

- **Brief field**: ✅ Added to role launch spec
  - `BuildRoleLaunchSpecInput.brief?: string` added
  - Threaded through `buildRoleLaunchSpec()`
  - Ready for Queen prompt injection

- **Queen blueprint**: ✅ Framework started
  - `bee` role defined with generic "do this task" capability  
  - `hive` blueprint mechanism outlined
  - Queen placement persona drafted

### What Needs Implementation

#### P-020 - Queen-turn Triage (TYPE-ROUTING)
**What**: Queen reads `improvements:digest` and routes each idea:
- **Product-ideas** (about target project code) → place as work-item
- **Process/prompt-ideas** (about Papercusp system) → human-gate or gym-dispatch
- **Reject with reason** (duplicate, low-value)

**Where to implement**:
1. New function `classifyIdeaType()` in `digest.ts` or new `triage.ts`
   - Analyze `scope` + `paths` to determine type
   - Return `{ kind: 'product' | 'process', reason: string }`

2. Update Queen prompt to include triage section:
   ```
   ## Ideas triage (improvements:digest)
   
   **Survey:** `improvements:digest` — captured ideas with scores + recurrence
   
   **For each open idea, classify:**
   - **Product-idea** (affects target project): scope=harness:* AND paths NOT in system
     → action: `work_items:create/update` to place the idea as a ranked item
   - **Process/prompt-idea** (affects Papercusp): scope=operator OR paths in protected set
     → action: human-gate or `gym:judge` for risky prompt changes
   - **Duplicate/low-value**: compare vs recent decisions
     → action: `improvements:resolve { reason: "already decided" }`
   ```

3. Wire triage output to work-item placement logic
   - Product ideas → become work_items with `payload.ideaType: 'product'`
   - Process ideas → land in a human review queue with `payload.ideaType: 'process'`

**Key insight**: The distinction is encoded in `scope` + `paths`:
- `scope = 'operator'` or `scope = 'harness:papercup'` → process idea
- `scope = 'harness:other'` + touches that harness → product idea
- Touches protected paths (deploy/, safety/, migrations/) → force human gate

#### P-021 - Anti-flood (EXISTING CAPS REUSED)
**What**: Prevent digest queue from overwhelming the Queen
**Status**: Partially done
- Per-tick capture cap: Already in watchdog (15-min, ~4 items)
- Salience scoring: Already computed by digest
- Queen sees scored digest, not raw queue: Already fact

**What remains**:
1. Verify watchdog per-tick cap is active (likely via improvement-actions.ts)
2. Document the cap in Queen prompt: "I read the scored digest, pre-filtered for salience"

#### P-022 - Queue-as-memory (VERIFY + FINISH)
**What**: Before capture, search idea history (resolved/closed items) and surface "already decided" to prevent re-proposal
**Status**: Core built, needs verification + finish
- `recallAlreadyDecided()`: ✅ Implemented
- Surfaced in `CaptureImprovementResult`: ✅ Implemented  
- Agent sees recall before committing idea: ✅ Returns in result

**What remains**:
1. Test that `alreadyDecided` is actually being used by capture-tool caller
2. Ensure agents read and respect "already decided: <reason>" in response
3. Add to agent guidance: "Before filing, check `alreadyDecided` in response"

#### P-030 - Recurrence-decay lifecycle (INFRASTRUCTURE + TRACKING)
**What**: Track whether an applied idea's friction re-surfaces
- If it stops recurring → worked (weak signal for product class)
- If it recurs → reopen/escalate (regression)
- Rides watchdog's `dedupScope: 'open'` (re-files resolved item as regression)

**Status**: Infrastructure exists, tracking missing
- `signatureRecurrence()` computes: ✅ Built
  - `count`, `openCount`, `resolvedCount`
  - `lastSeenMs`, `decayDays`
- Watchdog can re-file resolved items: ✅ Via `dedupScope: 'open'` in capture

**What needs implementation**:
1. Add lifecycle states to work-item payload (P-031)
   - Payload schema: `{ ideaType: 'product'|'process', lifecycleState: 'open'|'triaged'|'applied'|'verified'|'recurred' }`
   
2. State machine on work-items:
   - `open` → initial capture
   - `triaged` → Queen decides (do/gate/verify/reject)
   - `applied` → idea implemented (issue closed/resolved)
   - `verified(decayed)` → friction signature stopped recurring (≥14 days no re-encounter)
   - `recurred` → friction signature re-surfaced (watchdog re-files it)

3. Decay computation
   - When Queen reads digest, check `recurringSignatures` 
   - For items in `verified` state with `decayDays > 14` → success signal
   - For items with re-filed regr

essions → escalate

4. Wire watchdog re-filing:
   - `dedupScope: 'open'` + re-encounter → creates new work-item with `ideaSource: 'recurrence'`
   - Links back to original: `payload.originalId: <prior-id>`

#### P-031 - Idea lifecycle states (SCHEMA + OPERATIONS)
**What**: Add structured lifecycle tracking to work_items
**Current state**:
- work_items.state: existing ('todo', 'done', etc.) — these are general work states
- idea_type: new, needs payload

**Schema additions needed**:
```sql
-- Add to engineer_issues / work_items payload (JSON):
-- {
--   "ideaType": "product" | "process",
--   "lifecycleState": "open" | "triaged" | "applied" | "verified" | "recurred",
--   "fromImprovement": { id: string, originalId?: string }  // for recurrence
-- }
```

**Operations needed**:
1. `improvements:triage { ideaId, decision: 'place'|'gate'|'gym'|'reject', reason? }`
   - Updates work_item.payload.lifecycleState = 'triaged'
   - Sets `ideaDecision` field

2. Watchdog re-file logic:
   ```ts
   if (dedupScope === 'open' && prior.state === 'resolved') {
     // This is a regression — re-file as new idea with back-reference
     return captureImprovement({
       ...priorIdea,
       force: true,
       source: 'recurrence'
       paths: prior.paths,
       body: `Recurrence of resolved item ${prior.id}. ...`
     });
   }
   ```

3. Decay check:
   ```ts
   for (const sig of recurringSignatures) {
     const items = digest.autoEligible.filter(i => dedupSignature(i.title) === sig.signature);
     for (const item of items) {
       if (sig.decayDays > 14 && item.state === 'resolved') {
         // Mark as verified(decayed)
         item.lifecycleState = 'verified';
         item.decayResult = 'worked';
       }
     }
   }
   ```

## Implementation Order (highest-leverage first)

1. **Core digest utilities** (already done, verify):
   - ✅ `dedupSignature()`, `titleSimilarity()`, `jaccard()`
   - ✅ `signatureRecurrence()`, `findLikelyDuplicates()`, `recallAlreadyDecided()`

2. **Triage function** (P-020 core):
   - New: `classifyIdeaType(candidate)` → { kind, reason }
   - New: `triageIdea(candidate, digest)` → { decision, reason, action }
   - Wire into improvements:triage tool (or new tool)

3. **Lifecycle tracking** (P-030/P-031):
   - Schema: Add payload fields for `ideaType`, `lifecycleState`, `idea From`
   - Operations: `improvements:set-lifecycle-state` tool
   - Watchdog integration: On re-file, set `source: 'recurrence'`

4. **Queen prompt updates** (P-020 deliverable):
   - Add "Ideas triage" section to Queen persona
   - Teach type-routing logic
   - Document "read digest, classify, place/gate/reject" loop

5. **Anti-flood verification** (P-021):
   - Verify watchdog per-tick cap is active
   - Document in Queen prompt

6. **Tests + verification** (P-060 equivalent):
   - Unit: triage logic, lifecycle state machine
   - Integration: Queen reads digest → triages → updates work_items
   - End-to-end: Idea captured → triaged → applied → decay tracked

## Files to Create/Modify

### New files:
- `packages/operator-core/lib/harness/improvements/triage.ts` (P-020 core)
- `packages/operator-core/lib/agent-tools/improvements/triage.ts` (Queen tool)

### Modify:
- `packages/operator-core/lib/harness/improvements/digest.ts` (add classifyIdeaType)
- `packages/operator-core/lib/harness/improvements/policy.ts` (add lifecycle types)
- Queen prompt (add triage section)
- Watchdog routine (wire recurrence re-file)
- work_items schema (payload fields)

## Key Decisions Confirmed (from self-learning-central D-001..D-009)

✅ D-001: Reflection-driven, not gym-centric — gym is verification rail
✅ D-002: No new kind:improvement — product vs process is a lane/tag
✅ D-003: Recurrence-decay for product class; gym A/B for process class
✅ D-004: Memory = queue history; matched by normalized signature
✅ D-005: Change Feed = projection over completions (no new log)
✅ D-006: Reflection at boundaries + friction, never per-turn
✅ D-007: Graduation = config on shipped autoKinds mechanism
✅ D-008: Generalize existing loop, don't rebuild
✅ D-009: Gym is verification rail; triage routes by idea type
