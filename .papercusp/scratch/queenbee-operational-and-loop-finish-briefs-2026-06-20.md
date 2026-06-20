# Get queen/bee operational + finish the loop/plan system — su briefs (2026-06-20)

## Context (the new operating model)
Owner turned OFF the agent self-loops → agents stand down + don't auto-resume. **I (role-1176 / the
stand-in manager) am now the active waker** — I assign su agents, monitor, and wake the right one
with the right prompt when it's time to act. The bee system is NOT yet operational, so this work
goes to **su agents**, not bees.

**Hard gate:** everything that BUILDS or DEPLOYS is blocked by su-7fa79's OPEN papercup→papercusp
rename window (git-sync + autoloop paused, services bouncing). I wake the assigned su the moment the
window closes + git-sync resumes.

---

## RECAP A — what's left to get the queen/bee system OPERATIONAL
The *design* is sound (the token audit put queen/bee at ~6–7× leaner than su sessions). What blocks
it from RUNNING is a deploy-sequence, not new design:
1. **EI-1758 — the bee fire-path zombie (THE keystone).** Bees boot but make **0 tool calls**
   (a WaitForMcpServers reflex). su-53b3f built the mode-1 launch-mechanics fix (green: 36/36 +
   132/132; su-37003 converged identical); mode-2 already shipped. **Not deployed.**
2. **Rename window OPEN** (su-7fa79) → nothing deploys.
3. **Deploy gate** must be green to ship the fix.
→ **Critical path:** window closes → gate green → EI-1758 deploys → **verify bees actually fire**
(the spawn protocol). Then a Queen can place + bees execute. That verification is the real "is it
operational" proof, and it's currently unowned (su-5695e designed the protocol but stood down).

## RECAP B — what's left to fully realize the loop/plan vision
Engine (B-LOOP-1..4) built + green-reported; the `arm`/`end`/`status` verb is implemented. Remaining:
1. **B-LOOP-5 tail:** the `/loop`→engine-loop **prompt-sweep** (barely started — 1 file) + **e2e
   verification** (a warm session actually looping) + **wakeup-template** finalize.
2. **Post-rename green-verify** — the rename may have touched the engine's imports.
3. **Plan reconciliation** — the tangled superseded/revised plan records.
4. **Deploy** the engine + the loop verbs.
5. **Phase B/C — "scale to hundreds" (DEFERRED, not now):** P-010/011/012 = bound RUNNING via the
   fleet cap, raise routinesQueue concurrency, lightweight fire record to dodge the workflow_status
   freeze. **Demand-gated** — only worth building when we actually run hundreds of concurrent loops.
   Out of scope unless you say otherwise.

---

## The su briefs (⚠ all BUILD work gated on the rename window — I wake at window-close)

### Queen/bee operational
**B-QB-1 — EI-1758 deploy + bee-fire verification (keystone)** → su-53b3f (built the fix) + verifier
Post-window: ensure su-53b3f's launch-mechanics fix deploys; run the spawn protocol — a fresh bee on
a seeded self-contained item → assert boots-clean (tools present, no WaitForMcpServers loop) / real
tool calls in `activity:recent` / `feature!=NULL` / claims+completes, vs the 0-bee-tool-call zombie
baseline. **Done = a bee demonstrably executes a work item end-to-end, fleet-wide.**

**B-QB-2 — bee-operational readiness sweep** → su-1ec26 (fleet/spawn internals)
Beyond EI-1758: survey + close any *other* gaps in the full **Queen→place→bee→propose/dispose→
complete** cycle. Confirm a Queen can place a work item and a bee picks it up, works it, and
completes it (not just boots). File residual blockers, fix the quick ones. **Done = one documented
green end-to-end placement→completion.**

### Loop/plan finish
**B-LOOP-FIN-1 — `/loop`→engine-loop prompt-sweep** → su-85393 (B-LOOP-5 owner)
Sweep su/interactive personas/prompts to "declare an engine loop; do NOT self-pace with Claude
`/loop`," **EXCLUDING** the autonomous queen/bee/scout loops (D-007). Files: the persona/prompt
files. Tests + the doc note. (This + FIN-2 complete B-LOOP-5.)

**B-LOOP-FIN-2 — loop e2e + wakeup-template finalize** → su-fd5c0 (B-LOOP-3) or su-85393
Prove a warm session loops end-to-end: `arm` → engine fire → warm coord-wake → next turn fires N sec
after the prior settles. Finalize the wakeup-prompt template. Files: the e2e rig/test + wakeup
template.

**B-LOOP-FIN-3 — post-rename green-verify + plan reconcile + deploy** → su-d5a84 (B-LOOP-1 owner)
Verify B-LOOP-1..4 still green after the rename (fix import breakage); reconcile the tangled plan
record (consolidate superseded/revised, flip done items via plans:set-status); deploy-verify the
engine + verbs go live.

---

## Activation + management (loops are OFF — I am the waker)
- All BUILD/DEPLOY work is gated on the rename window closing + git-sync resuming.
- I monitor for the window-close, then **wake each assigned su with its brief**, and re-wake to
  drive-to-empty (the completion guarantee).
- **Also orphaned by the loop-cancel** (re-wake at window-close): the gateway briefs
  (B-HOT-1/2, B-EGRESS, B-ACCT, B-GWCTL, B-PROV) + the token briefs (B-TOK-1..4). The loop-off
  stranded all the window-gated work; I'm the central re-waker now.
