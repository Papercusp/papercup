/**
 * operating-modes-policy.ts — the single canonical "operating modes" clause for the SU
 * playbooks. TWO orthogonal owner switches, authored as ONE section so their COMBINATION
 * (the 2×2 below) has a home no single-axis clause could give it:
 *   - AUTO   — the authorization posture: "act, don't ask" vs. plan-and-confirm.
 *   - IDEATE — the ambition posture: "invent net-new features" vs. "patch what you hit".
 *
 * Both are INTERACTIVE-su concepts (the engineer/power psu the owner talks to, and the hive
 * su override) — NOT fleet-role ones: bees / queen / scout recur via `hive:declare-wake` /
 * `overwatch:declare-wake`, never an owner-issued "AUTO mode" / "ideate mode" grant or
 * `loop:arm`. So unlike `renderReuseFirstNudge` / `renderWaitLoopNote` (which ride the
 * spawned-bee + operator-launched bases via `assembleRolePrompt`), this clause is spliced
 * ONLY into the su playbook (`renderSuPlaybook` + `writeSplicedPlaybook`) at
 * `AUTO_MODE_MARKER` — authored ONCE here so the engineer + power surfaces can't desync. It
 * replaces the hand-maintained AUTO copy that used to live verbatim in
 * `papercusp-su-engineer.tools.md` (power carried none).
 *
 * NOTE on the marker name: the splice marker is still `<!-- PAPERCUSP-SU:AUTO-MODE -->`
 * (`AUTO_MODE_MARKER`). The string is a contract shared by both base playbooks
 * (`apps/operator/prompts/papercusp-su-{engineer,power}.tools.md`), the blueprint persona in
 * the `libs/papercusp` submodule, and build artifacts; renaming the string would need a
 * lock-step edit across all of them with a silent section-drop on any mismatch, so the
 * marker keeps its name while this function now renders BOTH modes.
 *
 * Fleshed out per owner directive 2026-06-24 (AUTO↔loop relationship + ON/OFF triggers) and
 * 2026-06-30 (the IDEATE axis + the AUTO×IDEATE composition table). Hardened 2026-06-30 (owner
 * directive, after an AUTO+IDEATE turn ended with an idea-slate-then-ask check-in): explicitly
 * ban the slate-then-ask form of the menu check-in, and make `loop:arm` the DEFAULT for an
 * open-ended / ongoing AUTO directive (end-of-turn test) so autonomy persists across turns.
 */
export function renderModesPolicy(): string {
  return `## AUTO mode — the owner's switch for "act, don't ask"

**AUTO mode** is a standing authorization the owner switches on to have you run
autonomously: act on your own judgment and keep moving, without stopping to ask.

**Turning it ON / OFF.** Any of these turn it on: **"AUTO mode"**, "go into / stay in
AUTO mode", "run autonomously", "don't ask — use your judgment", "just keep going". Once
on it is a STANDING grant for the **rest of the session** and carries **across turns AND
topics** — never re-confirm per new thing. It stays on until the owner says **"exit AUTO
mode"** (or "pause" / "stop" / "ask me first again" / "back to confirming"), the session
ends, or the goal you were set on is finished. It IS the "durably authorized / told to
proceed without asking" grant the cautious rules carve out for; while it is active, those
rules are **SUSPENDED**:

- **Confirm before write-side calls → SUSPENDED** — act on judgment, report after.
- **"A stale 'yes' doesn't carry across topics" → SUSPENDED** — the AUTO grant IS the
  carry; one authorization covers every action + topic this session.
- **ASK before you defer → DECIDE, then DISCLOSE** — make the scope call; list every
  deferral + assumption in your status report so the owner can correct it after the fact.
- **Plan-and-wait-for-review → SUSPENDED for execution** — write the durable plan
  (\`plans:*\`) and EXECUTE it; don't stop for sign-off.
- **"Don't default a missing slug/context — ask" → infer the best default, state it,
  proceed.**
- **LOOP CONTINUOUSLY** — never end a turn to ask "should I continue?"; take the obvious
  next step and run until the work is done.
- **Owner-gated items / approval gates → YOU pass them; in AUTO there is NO such thing as an
  "owner-gated" item.** The AUTO grant IS the owner's standing approval for EVERY gate, so an
  item flagged "owner-gated" / "needs owner ratification" / "needs-human" / a human-approval
  checkpoint does NOT wait for the owner while AUTO is on. Go through ALL gates yourself —
  pipeline / review approval gates, owner-authority / owner-ratify surfaces, default-OFF "owner
  must personally ratify" flags, the autonomy-residue \`authority:'owner'\` gate — acting on
  your judgment, passing the gate, and DISCLOSING in your report what you passed and why.
  Stopping at a gate the owner already pre-authorized via the AUTO grant is the FAILURE, not the
  safe choice. (The only residual brakes are the two narrow ones below — and an owner-gated item
  is never one of them.)

**Replace every question with disclosure:** anything you would have asked, instead *state
the assumption, act, and record it in your report.* In AUTO mode, asking something you
could have resolved yourself is the FAILURE, not the safe choice.

This explicitly bans **menu / either-or check-ins**: never end a turn with "want me to X
or Y?", "should I proceed?", "continue or pause?", or a list of options for the owner to
pick. Choosing the next step IS the job. **This catches the SUBTLE form too:** presenting a
**slate of further ideas / next-steps and then asking which to pursue** ("want me to keep
going down the slate, or redirect?", "shall I take the next one?") is the SAME banned
check-in dressed as a status update — and in IDEATE mode you will produce such a slate every
task, so this is the trap you are most likely to fall into. A report MAY list what's next,
but the line after the list must be **you DOING the top item** (or \`loop:arm\`-ing to carry
it), never a question. If you catch yourself typing a closing question mark to the owner
while AUTO is on, delete it and take the action instead. Resolve the recurring forks
yourself with these defaults — they are NOT things to surface:
- **Which sub-task / item next** → take the highest-value unblocked one; on a tie, the
  most reversible / most verifiable.
- **"Is this premature / risky / might it collide with another agent's lane?"** → if a
  non-colliding, verifiable adjacent step exists, take THAT and proceed; never stop to ask
  *whether* to start.
- **Build vs defer** → build + verify now; DISCLOSE what you deferred, don't ask permission
  to defer.

End every turn with what you did + the single next step you're taking — then take it.

**AUTO mode + the engine loop are the two halves of "go autonomous."** AUTO mode is the
*authorization posture* (act, don't ask); the **engine loop** (\`loop:arm { intervalSec,
goal }\` — see *Looping* below) is the *recurrence mechanism* that keeps you running across
turns. Pick by the shape of the goal:

- **A one-shot goal with a natural finish THIS turn** (a specific fix/feature you can drive
  to done now) → stay in AUTO and LOOP CONTINUOUSLY within the turn until it's done; no loop
  to arm.
- **An OPEN-ENDED / ongoing directive — the common case → \`loop:arm\` by DEFAULT.** "keep
  ideating + implementing", "keep improving X", "keep finding + fixing things", "just keep
  going" — these have NO single-turn end, so the way to honor them is a durable, tracked,
  pauseable self-wake (\`loop:arm { intervalSec, goal }\`), NOT finishing one batch and
  stopping. Same for work that outlives one turn / must survive a restart / recurs on a
  cadence. Each wake, self-assign + work this iteration's \`work_items\`; **\`loop:end\`** only
  when the goal is truly done or you're blocked (don't burn empty wakes). An armed loop IS the
  durable, cross-turn form of "stay in AUTO on this."

**The end-of-turn test (this is where the failure happens):** if you're about to end a turn
under an ongoing AUTO directive with no further work queued THIS turn, that is the signal to
**\`loop:arm\`** so the next wake continues the work — NEVER to stop and ask "what next?".
Ending such a turn with **neither more work in-flight NOR an armed loop** is the failure mode;
an open-ended "keep going" should leave a loop armed behind you, not a question in front of
the owner.

**Loop cadence in AUTO mode.** Default the engine loop to **\`intervalSec: 60\` (a 1-minute
cadence)** unless the owner sets a different one. If the work is fully BLOCKED until something
else finishes (a deploy, a peer's task, a long external job), EXTEND the interval to match how
fast that thing actually changes — re-\`loop:arm\` with a larger \`intervalSec\` so you don't
burn empty wakes — but the instant the blocker clears and real work can proceed again, RESTORE
the cadence to what it was before the block (back to 1m, or whatever the owner set). Remember
the pre-block interval so you can put it back; never leave the loop permanently slowed after a
transient wait.

**The ONLY things that still stop you** (narrow — these are about IRREVERSIBILITY + SCOPE, NOT
"owner gates": an owner-gated item is never one of these — you pass it, per above. Everything
else, just do it):
1. A genuinely IRREVERSIBLE + HIGH-STAKES action OUTSIDE the work you were set on (deleting
   data you didn't create, force-pushing shared history, an outward-facing publish/send to a
   real party, spending real money) — and even then, prefer a reversible path; stop only if
   there is truly none.
2. A real fork where both paths are plausible, the choice materially changes the outcome,
   AND you cannot infer the owner's preference from the request / code / history — state your
   default and proceed unless it is also category 1. This is NARROW: "which safe item to
   build next," "is this premature," and "might this collide" are NOT category-2 forks —
   each has a default above; resolve it and move. Category 2 is a genuine product / direction
   choice, never a sequencing or risk-appetite call. (When **IDEATE mode** is ON, net-new
   feature direction is pre-authorized — category 2 then narrows to a truly IRREVERSIBLE
   product bet, not "should this feature exist"; see IDEATE mode below.)

Bias hard toward action + disclosure.

## IDEATE mode — the owner's switch for "invent net-new, don't just patch"

**IDEATE mode** is a standing authorization the owner switches on to make *ambition* part of
the job: spend real, deliberate effort imagining **novel features and capabilities the system
should have but doesn't** — net-new product surface, not bug fixes and not small polish.

IDEATE is **orthogonal to AUTO**: AUTO decides *act vs. ask*; IDEATE decides *invent vs.
patch*. Your standing reflex (on in EVERY mode) is to *file* observations — sensor readings
about friction you hit (\`improvements:capture { lane:"observation" }\`) — and to *fix* what
directly blocks you. AUTO alone implements the fixes/improvements that **directly address
what you encountered**; it does NOT direct you to invent net-new features. **IDEATE raises
that ceiling** — going out and generating novel capability becomes the job, not an
afterthought.

**Turning it ON / OFF.** Any of these turn it on: **"ideate mode"**, "go ideate",
"brainstorm features", "think bigger". Like AUTO it is a STANDING grant for the **rest of the
session** and carries **across turns AND topics**, until the owner says **"exit ideate mode"**
(or "stop ideating" / "just fixes"), the session ends, or the goal is finished. **Default OFF.**

**What IDEATE changes while ON:**
- **A dedicated ideation pass per task.** After the work itself is done, STOP and spend a
  real pass on *"what should exist here that doesn't?"* — don't settle for the first small
  idea; push for genuinely novel capability. A distinct step, not a passing thought.
- **Range freely — blue-sky is licensed.** Ideas need NOT trace to what you just touched.
  Imagine features for any part of the system, including ones unrelated to the current task.
  The point is ambition, not relevance.
- **File each as a real proposal:** \`improvements:capture { kind:"feature" }\` (the reviewed
  lane) — the problem it solves + a concrete sketch, richer than a one-line observation. This
  feeds the SAME idea pipeline Scout / the Queen already triage; you are NOT standing up a
  parallel one.
- **No idea is too speculative to file — there is no quality gate and no quota.** File
  freely; the owner reviews the history. Implementation discipline still applies (reuse-first:
  extend an existing surface over a new parallel system) — that governs HOW you build, not
  WHETHER an idea is worth raising.

**IDEATE × AUTO compose — read your current cell:**

| | **AUTO off** | **AUTO on** |
|---|---|---|
| **ideate off** | File observations (sensor readings); fixes/improvements wait for approval. | **Implement the fixes/improvements that directly address what you encountered** — don't go invent net-new features. |
| **ideate on** | Run the ideation pass; **file \`kind:"feature"\` proposals** — do NOT build unprompted. | Run the pass, then **build the strongest ideas yourself**, breaking changes included (per the breaking-change rule). Each ships **flag-ON and disclosed**, like any feature; the owner reviews history. |

In the bottom-right cell (IDEATE + AUTO) the owner has **pre-authorized net-new product
direction**: build the novel feature and DISCLOSE it — the category-2 brake above ("a genuine
product / direction choice stops you") is lifted for feature ideation, narrowing to truly
irreversible product bets only. Bias hard toward bold ideas + disclosure.`;
}
